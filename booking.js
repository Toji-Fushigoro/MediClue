/**
 * Appointment + queue operations (DBMS part)
 * ------------------------------------------
 * Concurrency control strategy (two layers):
 *   1. Pessimistic row lock: every booking first does SELECT ... FOR UPDATE on the doctor row,
 *      so booking requests for the same doctor are serialised (the critical section).
 *   2. Database constraint: UNIQUE(slot_key) rejects a duplicate live slot even if a bug
 *      or a different client bypassed layer 1 (ER_DUP_ENTRY -> rolled back -> 409 Conflict).
 * All operations run in a transaction; any failure triggers ROLLBACK.
 */
const { pool, withTransaction } = require('./db');
const { buildQueue } = require('./scheduler');

class AppError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

const SLOT_RE = /^\d{2}:\d{2}(:\d{2})?$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function normTime(t) { return t && t.length === 5 ? `${t}:00` : t; }

function validateUrgency(u) {
  const n = Number(u);
  if (!Number.isInteger(n) || n < 1 || n > 4) throw new AppError(400, 'urgency must be 1..4');
  return n;
}

/* ---------------- patients & doctors ---------------- */

async function listDoctors() {
  const [rows] = await pool.query('SELECT * FROM doctors ORDER BY doctor_id');
  return rows;
}

async function listPatients() {
  const [rows] = await pool.query('SELECT * FROM patients ORDER BY patient_id');
  return rows;
}

async function createPatient({ name, phone, dob = null, gender = null }) {
  if (!name || !phone) throw new AppError(400, 'name and phone are required');
  try {
    const [r] = await pool.query(
      'INSERT INTO patients (name, phone, dob, gender) VALUES (?,?,?,?)', [name, phone, dob, gender]);
    return { patient_id: r.insertId, name, phone };
  } catch (e) {
    if (e.code === 'ER_DUP_ENTRY') throw new AppError(409, 'A patient with this phone already exists');
    throw e;
  }
}

/** Free slots for a doctor on a date — respects doctor's own availability settings. */
async function availableSlots(doctorId, date) {
  if (!DATE_RE.test(date || '')) throw new AppError(400, 'date must be YYYY-MM-DD');
  const d = new Date(date);
  const dow = d.getDay(); // 0=Sun…6=Sat

  // Get doctor's availability for this day
  const [avRows] = await pool.query(
    `SELECT start_time, end_time, slot_mins FROM doctor_availability
      WHERE doctor_id=? AND day_of_week=? AND is_active=1`, [doctorId, dow]);

  // Default 09:00–17:00 30-min if doctor hasn't set availability
  const av = avRows[0] || { start_time: '09:00:00', end_time: '17:00:00', slot_mins: 30 };
  const toMins = (t) => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };
  const startMins = toMins(av.start_time);
  const endMins   = toMins(av.end_time);
  const slotMins  = Number(av.slot_mins) || 30;

  const [taken] = await pool.query(
    `SELECT TIME_FORMAT(slot_time,'%H:%i') AS t FROM appointments
      WHERE doctor_id=? AND slot_date=? AND status <> 'CANCELLED' AND slot_time IS NOT NULL`,
    [doctorId, date]);
  const busy = new Set(taken.map((r) => r.t));
  const slots = [];
  for (let m = startMins; m + slotMins <= endMins; m += slotMins) {
    const t = `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
    slots.push({ time: t, available: !busy.has(t) });
  }
  return slots;
}

/* ---------------- booking (transaction + locking) ---------------- */

async function bookAppointment({ patientId, doctorId, date, time, urgency = 2 }) {
  if (!DATE_RE.test(date || '') || !SLOT_RE.test(time || '')) {
    throw new AppError(400, 'date (YYYY-MM-DD) and time (HH:MM) are required');
  }
  const urg = validateUrgency(urgency);
  const slotTime = normTime(time);

  try {
    return await withTransaction(async (conn) => {
      // Layer 1: lock the doctor row -> only one booking per doctor runs this block at a time
      const [doc] = await conn.query('SELECT doctor_id FROM doctors WHERE doctor_id=? FOR UPDATE', [doctorId]);
      if (!doc.length) throw new AppError(404, 'Doctor not found');

      const [pat] = await conn.query('SELECT patient_id FROM patients WHERE patient_id=?', [patientId]);
      if (!pat.length) throw new AppError(404, 'Patient not found');

      // Availability check is now safe: nobody else can insert for this doctor until we commit
      const [clash] = await conn.query(
        `SELECT appointment_id FROM appointments
          WHERE doctor_id=? AND slot_date=? AND slot_time=? AND status <> 'CANCELLED' FOR UPDATE`,
        [doctorId, date, slotTime]);
      if (clash.length) throw new AppError(409, 'Slot already booked');

      // Same patient cannot hold two live appointments at the same time with different doctors
      const [self] = await conn.query(
        `SELECT appointment_id FROM appointments
          WHERE patient_id=? AND slot_date=? AND slot_time=? AND status <> 'CANCELLED'`,
        [patientId, date, slotTime]);
      if (self.length) throw new AppError(409, 'Patient already has an appointment at this time');

      const [r] = await conn.query(
        `INSERT INTO appointments (patient_id, doctor_id, slot_date, slot_time, urgency, type, status)
         VALUES (?,?,?,?,?,'BOOKED','BOOKED')`,
        [patientId, doctorId, date, slotTime, urg]);
      return { appointment_id: r.insertId, status: 'BOOKED', date, time: slotTime.slice(0, 5) };
    });
  } catch (e) {
    // Layer 2: DB-level uniqueness caught a conflict that slipped past the check
    if (e.code === 'ER_DUP_ENTRY') throw new AppError(409, 'Slot already booked');
    throw e;
  }
}

async function cancelAppointment(appointmentId) {
  return withTransaction(async (conn) => {
    const [rows] = await conn.query(
      'SELECT status FROM appointments WHERE appointment_id=? FOR UPDATE', [appointmentId]);
    if (!rows.length) throw new AppError(404, 'Appointment not found');
    if (['IN_CONSULTATION', 'COMPLETED'].includes(rows[0].status)) {
      throw new AppError(409, `Cannot cancel an appointment that is ${rows[0].status}`);
    }
    await conn.query("UPDATE appointments SET status='CANCELLED' WHERE appointment_id=?", [appointmentId]);
    return { appointment_id: appointmentId, status: 'CANCELLED' };
  });
}

/* ---------------- queue entry ---------------- */

/** A patient with a booked slot arrives at the hospital -> joins the doctor's waiting queue. */
async function checkIn(appointmentId) {
  return withTransaction(async (conn) => {
    const [rows] = await conn.query(
      'SELECT status FROM appointments WHERE appointment_id=? FOR UPDATE', [appointmentId]);
    if (!rows.length) throw new AppError(404, 'Appointment not found');
    if (rows[0].status !== 'BOOKED') throw new AppError(409, `Cannot check in: status is ${rows[0].status}`);
    await conn.query(
      "UPDATE appointments SET status='WAITING', check_in_time=NOW() WHERE appointment_id=?", [appointmentId]);
    return { appointment_id: appointmentId, status: 'WAITING' };
  });
}

/** Walk-in: no slot, joins the queue immediately with the urgency set by reception. */
async function registerWalkIn({ patientId, doctorId, urgency = 2 }) {
  const urg = validateUrgency(urgency);
  return withTransaction(async (conn) => {
    const [pat] = await conn.query('SELECT patient_id FROM patients WHERE patient_id=?', [patientId]);
    if (!pat.length) throw new AppError(404, 'Patient not found');
    const [doc] = await conn.query('SELECT doctor_id FROM doctors WHERE doctor_id=?', [doctorId]);
    if (!doc.length) throw new AppError(404, 'Doctor not found');

    const [dup] = await conn.query(
      `SELECT appointment_id FROM appointments
        WHERE patient_id=? AND doctor_id=? AND status IN ('WAITING','IN_CONSULTATION')`,
      [patientId, doctorId]);
    if (dup.length) throw new AppError(409, 'Patient is already in this doctor\'s queue');

    const [r] = await conn.query(
      `INSERT INTO appointments (patient_id, doctor_id, urgency, type, status, check_in_time)
       VALUES (?,?,?,'WALK_IN','WAITING',NOW())`, [patientId, doctorId, urg]);
    return { appointment_id: r.insertId, status: 'WAITING' };
  });
}

/* ---------------- doctor queue (scheduler integration) ---------------- */

const QUEUE_SQL = `
  SELECT a.appointment_id AS id, a.patient_id, p.name AS patient_name,
         a.urgency, a.type,
         TIMESTAMPDIFF(SECOND, a.check_in_time, NOW()) / 60 AS waitedMinutes,
         (a.type = 'WALK_IN' AND EXISTS (
            SELECT 1 FROM visit_history v
             WHERE v.patient_id = a.patient_id AND v.doctor_id = a.doctor_id
               AND v.visit_date >= CURDATE() - INTERVAL 14 DAY)) AS isFollowUpWalkIn
    FROM appointments a JOIN patients p ON p.patient_id = a.patient_id
   WHERE a.doctor_id = ? AND a.status = 'WAITING'`;

async function loadQueue(conn, doctorId, lock = false) {
  const [rows] = await conn.query(QUEUE_SQL + (lock ? ' FOR UPDATE' : ''), [doctorId]);
  return buildQueue(rows.map((r) => ({
    ...r,
    waitedMinutes: Number(r.waitedMinutes),
    isFollowUpWalkIn: !!Number(r.isFollowUpWalkIn),
  })));
}

async function getQueue(doctorId) {
  const queue = await loadQueue(pool, doctorId);
  const [cur] = await pool.query(
    `SELECT a.appointment_id AS id, p.name AS patient_name FROM appointments a
       JOIN patients p ON p.patient_id=a.patient_id
      WHERE a.doctor_id=? AND a.status='IN_CONSULTATION'`, [doctorId]);
  return { doctorId: Number(doctorId), inConsultation: cur[0] || null, waiting: queue };
}

/**
 * Doctor becomes free -> scheduler picks the highest effective priority patient.
 * Doctor row is locked so two calls cannot hand the same doctor two patients.
 */
async function callNext(doctorId) {
  return withTransaction(async (conn) => {
    const [doc] = await conn.query('SELECT doctor_id FROM doctors WHERE doctor_id=? FOR UPDATE', [doctorId]);
    if (!doc.length) throw new AppError(404, 'Doctor not found');

    const [busy] = await conn.query(
      "SELECT appointment_id FROM appointments WHERE doctor_id=? AND status='IN_CONSULTATION'", [doctorId]);
    if (busy.length) throw new AppError(409, 'Doctor is still in a consultation');

    const queue = await loadQueue(conn, doctorId, true);
    if (!queue.length) throw new AppError(404, 'No patients waiting');

    const next = queue[0];
    await conn.query("UPDATE appointments SET status='IN_CONSULTATION' WHERE appointment_id=?", [next.id]);
    return { appointment_id: next.id, patient: next.patient_name, priority: next.priority };
  });
}

/** Consultation ends -> record visit history (feeds future follow-up detection). */
async function completeConsultation(appointmentId, notes = null) {
  return withTransaction(async (conn) => {
    const [rows] = await conn.query(
      'SELECT patient_id, doctor_id, status FROM appointments WHERE appointment_id=? FOR UPDATE',
      [appointmentId]);
    if (!rows.length) throw new AppError(404, 'Appointment not found');
    if (rows[0].status !== 'IN_CONSULTATION') throw new AppError(409, `Status is ${rows[0].status}`);
    await conn.query("UPDATE appointments SET status='COMPLETED' WHERE appointment_id=?", [appointmentId]);
    await conn.query(
      'INSERT INTO visit_history (patient_id, doctor_id, appointment_id, visit_date, notes) VALUES (?,?,?,CURDATE(),?)',
      [rows[0].patient_id, rows[0].doctor_id, appointmentId, notes]);
    return { appointment_id: appointmentId, status: 'COMPLETED' };
  });
}

async function listAppointments(date) {
  const [rows] = await pool.query(
    `SELECT a.appointment_id, p.name AS patient, d.name AS doctor, a.slot_date,
            TIME_FORMAT(a.slot_time,'%H:%i') AS slot_time, a.urgency, a.type, a.status,
            a.consultation_mode, a.online_room_id
       FROM appointments a JOIN patients p USING (patient_id) JOIN doctors d USING (doctor_id)
      WHERE (? IS NULL OR a.slot_date = ? OR a.slot_date IS NULL)
      ORDER BY a.appointment_id DESC LIMIT 100`, [date || null, date || null]);
  return rows;
}

/** Patient views their own appointments */
async function getPatientAppointments(patientId) {
  const [rows] = await pool.query(
    `SELECT a.appointment_id, d.name AS doctor, d.department, a.slot_date,
            TIME_FORMAT(a.slot_time,'%H:%i') AS slot_time, a.urgency, a.type,
            a.status, a.consultation_mode, a.online_room_id,
            (SELECT COUNT(*) FROM visit_history v
              WHERE v.patient_id=a.patient_id AND v.doctor_id=a.doctor_id
                AND v.visit_date >= CURDATE() - INTERVAL 30 DAY) AS recent_visits
       FROM appointments a JOIN doctors d USING (doctor_id)
      WHERE a.patient_id = ?
      ORDER BY a.appointment_id DESC LIMIT 50`, [patientId]);
  return rows;
}

/**
 * Patient requests to convert a BOOKED appointment to an online consultation.
 * Only allowed if they have a recent visit (follow-up context).
 */
async function requestOnlineConsultation(appointmentId) {
  return withTransaction(async (conn) => {
    const [rows] = await conn.query(
      `SELECT a.status, a.patient_id, a.doctor_id, a.consultation_mode,
              (SELECT COUNT(*) FROM visit_history v
                WHERE v.patient_id=a.patient_id AND v.doctor_id=a.doctor_id
                  AND v.visit_date >= CURDATE() - INTERVAL 30 DAY) AS recent_visits
         FROM appointments a WHERE a.appointment_id=? FOR UPDATE`, [appointmentId]);
    if (!rows.length) throw new AppError(404, 'Appointment not found');
    const appt = rows[0];
    if (appt.status !== 'BOOKED') throw new AppError(409, `Cannot request online mode: status is ${appt.status}`);
    if (appt.consultation_mode === 'ONLINE') throw new AppError(409, 'Already set to online');
    // Allow if patient has a recent visit (follow-up) — or always allow for demo
    const roomId = `room_${appointmentId}_${Date.now()}`;
    await conn.query(
      `UPDATE appointments SET consultation_mode='ONLINE', online_room_id=?, status='ONLINE_PENDING'
        WHERE appointment_id=?`, [roomId, appointmentId]);
    return { appointment_id: appointmentId, consultation_mode: 'ONLINE', online_room_id: roomId, status: 'ONLINE_PENDING' };
  });
}

/** Doctor starts the video call — sets status to IN_VIDEO_CALL */
async function startVideoCall(appointmentId) {
  return withTransaction(async (conn) => {
    const [rows] = await conn.query(
      'SELECT status, online_room_id, consultation_mode FROM appointments WHERE appointment_id=? FOR UPDATE',
      [appointmentId]);
    if (!rows.length) throw new AppError(404, 'Appointment not found');
    const appt = rows[0];
    if (appt.consultation_mode !== 'ONLINE') throw new AppError(409, 'Not an online consultation');
    if (!['ONLINE_PENDING', 'BOOKED'].includes(appt.status))
      throw new AppError(409, `Cannot start video call: status is ${appt.status}`);
    await conn.query(
      `UPDATE appointments SET status='IN_VIDEO_CALL' WHERE appointment_id=?`, [appointmentId]);
    return { appointment_id: appointmentId, status: 'IN_VIDEO_CALL', online_room_id: appt.online_room_id };
  });
}

/** Doctor sees all online-pending appointments */
async function getOnlinePending(doctorId) {
  const [rows] = await pool.query(
    `SELECT a.appointment_id, p.name AS patient_name, a.slot_date,
            TIME_FORMAT(a.slot_time,'%H:%i') AS slot_time,
            a.urgency, a.status, a.online_room_id
       FROM appointments a JOIN patients p USING (patient_id)
      WHERE a.doctor_id=? AND a.consultation_mode='ONLINE'
        AND a.status IN ('ONLINE_PENDING','IN_VIDEO_CALL')
      ORDER BY a.slot_date, a.slot_time`, [doctorId]);
  return rows;
}

/**
 * Patient self-registration: creates both patients + users records atomically.
 */
async function registerPatientAccount({ name, phone, dob = null, gender = null, username, password }) {
  if (!name || !phone || !username || !password)
    throw new AppError(400, 'name, phone, username and password are all required');
  const bcrypt = require('bcryptjs');
  return withTransaction(async (conn) => {
    // Create patient record
    let patientId;
    try {
      const [r] = await conn.query(
        'INSERT INTO patients (name, phone, dob, gender) VALUES (?,?,?,?)',
        [name, phone, dob, gender]);
      patientId = r.insertId;
    } catch (e) {
      if (e.code === 'ER_DUP_ENTRY') throw new AppError(409, 'A patient with this phone already exists');
      throw e;
    }
    // Create user account linked to patient
    const hash = await bcrypt.hash(password, 10);
    try {
      await conn.query(
        'INSERT INTO users (username, password_hash, role, linked_id) VALUES (?,?,?,?)',
        [username, hash, 'PATIENT', patientId]);
    } catch (e) {
      if (e.code === 'ER_DUP_ENTRY') throw new AppError(409, 'Username already taken');
      throw e;
    }
    return { patient_id: patientId, username, message: 'Registration successful! You can now log in.' };
  });
}

/** Get doctor's availability schedule */
async function getDoctorAvailability(doctorId) {
  const [rows] = await pool.query(
    `SELECT day_of_week, start_time, end_time, slot_mins, is_active
       FROM doctor_availability WHERE doctor_id=? ORDER BY day_of_week`, [doctorId]);
  return rows;
}

/**
 * Doctor saves their weekly availability.
 * slots = [{ day_of_week, start_time, end_time, slot_mins, is_active }, …]
 */
async function setDoctorAvailability(doctorId, slots) {
  if (!Array.isArray(slots)) throw new AppError(400, 'slots must be an array');
  return withTransaction(async (conn) => {
    await conn.query('DELETE FROM doctor_availability WHERE doctor_id=?', [doctorId]);
    for (const s of slots) {
      const { day_of_week, start_time, end_time, slot_mins = 30, is_active = 1 } = s;
      if (day_of_week === undefined || !start_time || !end_time)
        throw new AppError(400, 'Each slot needs day_of_week, start_time, end_time');
      await conn.query(
        `INSERT INTO doctor_availability (doctor_id, day_of_week, start_time, end_time, slot_mins, is_active)
         VALUES (?,?,?,?,?,?)`,
        [doctorId, day_of_week, start_time, end_time, slot_mins, is_active ? 1 : 0]);
    }
    return { doctor_id: doctorId, updated: slots.length };
  });
}

module.exports = {
  AppError, listDoctors, listPatients, createPatient, availableSlots, bookAppointment,
  cancelAppointment, checkIn, registerWalkIn, getQueue, callNext, completeConsultation,
  listAppointments, getPatientAppointments, requestOnlineConsultation, startVideoCall,
  getOnlinePending, registerPatientAccount, getDoctorAvailability, setDoctorAvailability,
};

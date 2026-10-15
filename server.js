require('dotenv').config();
const path = require('path');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');
const svc = require('./booking');
const auth = require('./auth');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

// Helper: wraps async handlers, sends JSON, forwards errors
const h = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res)).then((d) => { if (!res.headersSent) res.json(d); }).catch(next);

/* ─── Auth routes (public) ───────────────────────────────────────── */
app.post('/api/auth/login',    h((req) => auth.login(req.body)));
app.post('/api/auth/register', h((req) => auth.register(req.body)));

// Patient self-registration (creates patient record + user account in one step)
app.post('/api/auth/register-patient', h((req) => svc.registerPatientAccount(req.body)));

// Change password — any logged-in user
app.put('/api/auth/change-password',
  auth.requireAuth('PATIENT','DOCTOR','RECEPTIONIST'),
  h((req) => auth.changePassword({ userId: req.user.userId, ...req.body })));


/* ─── Public read routes (all roles need these) ──────────────────── */
app.get('/api/doctors',           h(() => svc.listDoctors()));
app.get('/api/doctors/:id/slots', h((req) => svc.availableSlots(req.params.id, req.query.date)));
app.get('/api/appointments',      auth.requireAuth('RECEPTIONIST','DOCTOR'), h((req) => svc.listAppointments(req.query.date)));

/* ─── Patient self-service routes ────────────────────────────────── */
const P = auth.requireAuth('PATIENT');
app.post('/api/appointments',           P, h((req) => svc.bookAppointment(req.body)));
app.delete('/api/appointments/:id',     P, h((req) => svc.cancelAppointment(Number(req.params.id))));

/* ─── Receptionist-only routes (queue + walk-in + check-in only) ─── */
const R = auth.requireAuth('RECEPTIONIST');
app.get('/api/patients',                    R, h(() => svc.listPatients()));
app.post('/api/appointments/:id/checkin',   R, h((req) => svc.checkIn(Number(req.params.id))));
app.post('/api/appointments/:id/complete',  auth.requireAuth('RECEPTIONIST','DOCTOR'), h((req) => svc.completeConsultation(Number(req.params.id), req.body.notes)));
app.post('/api/walkin',                     R, h((req) => svc.registerWalkIn(req.body)));

/* ─── Doctor availability routes ─────────────────────────────────── */
const D = auth.requireAuth('DOCTOR');
app.get('/api/my/availability',    D, h((req) => svc.getDoctorAvailability(req.user.linkedId)));
app.put('/api/my/availability',    D, h((req) => svc.setDoctorAvailability(req.user.linkedId, req.body.slots)));
app.get('/api/doctors/:id/availability', h((req) => svc.getDoctorAvailability(req.params.id)));

/* ─── Queue routes (receptionist + doctor) ────────────────────────── */
const RD = auth.requireAuth('RECEPTIONIST', 'DOCTOR');
app.get('/api/queue/:doctorId', RD, h((req) => svc.getQueue(req.params.doctorId)));
app.post('/api/queue/:doctorId/next', RD, h((req) => svc.callNext(req.params.doctorId)));

/* ─── Online consultation routes ─────────────────────────────────── */
// Patient requests an online follow-up
app.post('/api/appointments/:id/request-online',
  auth.requireAuth('PATIENT'),
  h((req) => svc.requestOnlineConsultation(Number(req.params.id))));

// Doctor starts the video call (sets room active)
app.post('/api/appointments/:id/start-video',
  auth.requireAuth('DOCTOR'),
  h((req) => svc.startVideoCall(Number(req.params.id))));

// Get patient's own appointments
app.get('/api/my/appointments',
  auth.requireAuth('PATIENT'),
  h((req) => svc.getPatientAppointments(req.user.linkedId)));

// Get doctor's own queue + online pending
app.get('/api/my/queue',
  auth.requireAuth('DOCTOR'),
  h((req) => svc.getQueue(req.user.linkedId)));

app.get('/api/my/online-pending',
  auth.requireAuth('DOCTOR'),
  h((req) => svc.getOnlinePending(req.user.linkedId)));

/* ─── Error handler ──────────────────────────────────────────────── */
app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  if (err.status) return res.status(err.status).json({ error: err.message });
  console.error(err);
  res.status(500).json({ error: 'Internal server error' });
});

/* ─── Socket.io WebRTC Signaling ─────────────────────────────────── */
// Rooms are keyed by online_room_id (e.g. "room_<appointmentId>")
io.on('connection', (socket) => {
  console.log('Socket connected:', socket.id);

  socket.on('join-room', (roomId, role) => {
    socket.join(roomId);
    socket.roomId = roomId;
    socket.userRole = role;
    console.log(`[${role}] joined room ${roomId}`);
    // Notify the other peer that someone joined
    socket.to(roomId).emit('peer-joined', { role });
  });

  // WebRTC offer from caller (doctor)
  socket.on('offer', (roomId, offer) => {
    socket.to(roomId).emit('offer', offer);
  });

  // WebRTC answer from callee (patient)
  socket.on('answer', (roomId, answer) => {
    socket.to(roomId).emit('answer', answer);
  });

  // ICE candidates exchange
  socket.on('ice-candidate', (roomId, candidate) => {
    socket.to(roomId).emit('ice-candidate', candidate);
  });

  // End call
  socket.on('end-call', (roomId) => {
    socket.to(roomId).emit('call-ended');
  });

  socket.on('disconnect', () => {
    if (socket.roomId) {
      socket.to(socket.roomId).emit('peer-left');
    }
  });
});

const port = process.env.PORT || 3000;
if (require.main === module) {
  server.listen(port, () => console.log(`MediClue running on http://localhost:${port}`));
}
module.exports = app;

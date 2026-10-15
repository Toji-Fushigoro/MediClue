/**
 * MediClue Auth Module
 * Handles JWT-based authentication for Patient, Doctor, Receptionist roles.
 */
require('dotenv').config();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { pool } = require('./db');

const JWT_SECRET = process.env.JWT_SECRET || 'mediclue_secret_key_change_in_prod';
const JWT_EXPIRES = '8h';

class AppError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

/** Register a new user account */
async function register({ username, password, role, linkedId = null }) {
  if (!['PATIENT', 'DOCTOR', 'RECEPTIONIST'].includes(role))
    throw new AppError(400, 'Invalid role');
  if (!username || !password) throw new AppError(400, 'username and password required');

  const hash = await bcrypt.hash(password, 10);
  try {
    const [r] = await pool.query(
      'INSERT INTO users (username, password_hash, role, linked_id) VALUES (?,?,?,?)',
      [username, hash, role, linkedId]);
    return { user_id: r.insertId, username, role };
  } catch (e) {
    if (e.code === 'ER_DUP_ENTRY') throw new AppError(409, 'Username already taken');
    throw e;
  }
}

/** Login and return a JWT */
async function login({ username, password }) {
  if (!username || !password) throw new AppError(400, 'username and password required');
  const [rows] = await pool.query('SELECT * FROM users WHERE username = ?', [username]);
  if (!rows.length) throw new AppError(401, 'Invalid credentials');
  const user = rows[0];
  const ok = await bcrypt.compare(password, user.password_hash);
  if (!ok) throw new AppError(401, 'Invalid credentials');
  const token = jwt.sign(
    { userId: user.user_id, role: user.role, linkedId: user.linked_id, username: user.username },
    JWT_SECRET, { expiresIn: JWT_EXPIRES });
  return { token, role: user.role, username: user.username, linkedId: user.linked_id };
}

/** Express middleware — verifies JWT from Authorization header */
function requireAuth(...roles) {
  return (req, res, next) => {
    const header = req.headers['authorization'] || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token) return res.status(401).json({ error: 'Not authenticated' });
    try {
      const decoded = jwt.verify(token, JWT_SECRET);
      if (roles.length && !roles.includes(decoded.role))
        return res.status(403).json({ error: 'Forbidden: insufficient role' });
      req.user = decoded;
      next();
    } catch {
      return res.status(401).json({ error: 'Invalid or expired token' });
    }
  };
}

/** Change password — verifies old password first */
async function changePassword({ userId, oldPassword, newPassword }) {
  if (!oldPassword || !newPassword) throw new AppError(400, 'oldPassword and newPassword required');
  if (newPassword.length < 6) throw new AppError(400, 'New password must be at least 6 characters');
  const [rows] = await pool.query('SELECT * FROM users WHERE user_id = ?', [userId]);
  if (!rows.length) throw new AppError(404, 'User not found');
  const ok = await bcrypt.compare(oldPassword, rows[0].password_hash);
  if (!ok) throw new AppError(401, 'Current password is incorrect');
  const hash = await bcrypt.hash(newPassword, 10);
  await pool.query('UPDATE users SET password_hash = ? WHERE user_id = ?', [hash, userId]);
  return { message: 'Password changed successfully' };
}

module.exports = { register, login, requireAuth, changePassword };

require('dotenv').config();
const mysql = require('mysql2/promise');

// dateStrings: DATE/TIME/DATETIME columns come back as plain strings (no timezone surprises)
const pool = mysql.createPool({
  host: process.env.DB_HOST || 'localhost',
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'mediclue',
  waitForConnections: true,
  connectionLimit: 20,
  dateStrings: true,
});

/**
 * Run `fn(conn)` inside a transaction. Commits on success, rolls back on any error.
 * Every booking / queue operation goes through this so partial updates never survive.
 */
async function withTransaction(fn) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const result = await fn(conn);
    await conn.commit();
    return result;
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

module.exports = { pool, withTransaction };

// Seed default users with correct bcrypt hashes
// Run: node scripts/seedusers.js
require('dotenv').config();
const bcrypt = require('bcryptjs');
const mysql  = require('mysql2/promise');

(async () => {
  const conn = await mysql.createConnection({
    host: process.env.DB_HOST || 'localhost',
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'mediclue',
  });

  const hash = await bcrypt.hash('password123', 10);

  const users = [
    ['admin',    hash, 'RECEPTIONIST', null],
    ['dr.anita', hash, 'DOCTOR',       1],
    ['dr.rohit', hash, 'DOCTOR',       2],
    ['dr.meera', hash, 'DOCTOR',       3],
    ['amit',     hash, 'PATIENT',      1],
    ['priya',    hash, 'PATIENT',      2],
    ['ravi',     hash, 'PATIENT',      3],
    ['dikshant',   hash, 'PATIENT',      4],
    ['tanishk',    hash, 'PATIENT',      5],
    ['vansh',     hash, 'PATIENT',      6],
    ['sumeet',     hash, 'PATIENT',      6],
  ];

  // Clear and re-insert
  await conn.query('DELETE FROM users');
  for (const [username, password_hash, role, linked_id] of users) {
    await conn.query(
      'INSERT INTO users (username, password_hash, role, linked_id) VALUES (?,?,?,?)',
      [username, password_hash, role, linked_id]
    );
    console.log(`Created user: ${username} (${role})`);
  }

  await conn.end();
  console.log('\nAll users seeded! Default password: password123');
})().catch(e => { console.error(e.message); process.exit(1); });

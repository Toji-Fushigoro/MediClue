// Usage: npm run db:init  — creates tables, sample data AND seeds user accounts
require('dotenv').config();
const fs     = require('fs');
const path   = require('path');
const mysql  = require('mysql2/promise');
const bcrypt = require('bcryptjs');

(async () => {
  const conn = await mysql.createConnection({
    host: process.env.DB_HOST || 'localhost',
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    multipleStatements: true,
  });

  // 1. Run schema SQL
  const sql = fs.readFileSync(path.join(__dirname, '..', 'schema.sql'), 'utf8');
  await conn.query(sql);
  console.log('Schema applied.');

  // 2. Seed user accounts (all default password: password123)
  const hash = await bcrypt.hash('password123', 10);
  const users = [
    ['admin',    hash, 'RECEPTIONIST', null],
    ['dr.anita', hash, 'DOCTOR',       1],
    ['dr.rohit', hash, 'DOCTOR',       2],
    ['dr.meera', hash, 'DOCTOR',       3],
    ['amit',     hash, 'PATIENT',      1],
    ['priya',    hash, 'PATIENT',      2],
    ['ravi',     hash, 'PATIENT',      3],
    ['sunita',   hash, 'PATIENT',      4],
    ['karan',    hash, 'PATIENT',      5],
    ['neha',     hash, 'PATIENT',      6],
  ];
  for (const [username, password_hash, role, linked_id] of users) {
    await conn.query(
      'INSERT INTO users (username, password_hash, role, linked_id) VALUES (?,?,?,?)',
      [username, password_hash, role, linked_id]);
    console.log(`  User created: ${username} (${role})`);
  }

  await conn.end();
  console.log('\nDatabase initialised successfully!');
  console.log('Default password for all sample users: password123');
})().catch((e) => { console.error(e.message); process.exit(1); });

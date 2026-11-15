const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS circles(id TEXT PRIMARY KEY, elder_name TEXT NOT NULL, age INTEGER NOT NULL,
  emergency_name TEXT DEFAULT '', emergency_phone TEXT DEFAULT '', emergency_email TEXT DEFAULT '',
  require_approval INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS passcodes(circle_id TEXT NOT NULL REFERENCES circles(id) ON DELETE CASCADE,
  role TEXT NOT NULL, hash TEXT NOT NULL, PRIMARY KEY(circle_id, role));
CREATE TABLE IF NOT EXISTS contacts(id INTEGER PRIMARY KEY AUTOINCREMENT,
  circle_id TEXT NOT NULL REFERENCES circles(id) ON DELETE CASCADE, role TEXT NOT NULL, name TEXT DEFAULT '', email TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_contacts ON contacts(circle_id, role);
CREATE TABLE IF NOT EXISTS meds(id TEXT PRIMARY KEY, circle_id TEXT NOT NULL REFERENCES circles(id) ON DELETE CASCADE,
  name TEXT NOT NULL, dosage TEXT DEFAULT '', form TEXT DEFAULT 'tablet', times TEXT NOT NULL, start_date TEXT NOT NULL,
  end_date TEXT, days TEXT NOT NULL, instructions TEXT DEFAULT '', pill_count INTEGER DEFAULT 0,
  refill_threshold INTEGER DEFAULT 5, active INTEGER NOT NULL DEFAULT 1);
CREATE INDEX IF NOT EXISTS idx_meds ON meds(circle_id, active);
CREATE TABLE IF NOT EXISTS doses(id TEXT PRIMARY KEY, med_id TEXT NOT NULL REFERENCES meds(id) ON DELETE CASCADE,
  circle_id TEXT NOT NULL, date TEXT NOT NULL, slot TEXT NOT NULL, time TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending', by_name TEXT, at TEXT, UNIQUE(med_id, date, slot));
CREATE INDEX IF NOT EXISTS idx_doses ON doses(circle_id, date, status);
CREATE TABLE IF NOT EXISTS appointments(id TEXT PRIMARY KEY, circle_id TEXT NOT NULL REFERENCES circles(id) ON DELETE CASCADE,
  doctor TEXT NOT NULL, specialty TEXT DEFAULT '', location TEXT DEFAULT '', at TEXT NOT NULL, notes TEXT DEFAULT '',
  status TEXT NOT NULL DEFAULT 'scheduled');
CREATE INDEX IF NOT EXISTS idx_appts ON appointments(circle_id, at);
CREATE TABLE IF NOT EXISTS notes(id INTEGER PRIMARY KEY AUTOINCREMENT, circle_id TEXT NOT NULL, author TEXT NOT NULL, role TEXT NOT NULL,
  text TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS checkins(id INTEGER PRIMARY KEY AUTOINCREMENT, circle_id TEXT NOT NULL, date TEXT NOT NULL,
  mood INTEGER NOT NULL, pain INTEGER NOT NULL, note TEXT DEFAULT '', UNIQUE(circle_id, date));
CREATE TABLE IF NOT EXISTS pending(id INTEGER PRIMARY KEY AUTOINCREMENT, circle_id TEXT NOT NULL, type TEXT NOT NULL,
  payload TEXT NOT NULL, by_name TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', created_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_pending ON pending(circle_id, status);
CREATE TABLE IF NOT EXISTS activity(id INTEGER PRIMARY KEY AUTOINCREMENT, circle_id TEXT NOT NULL, actor TEXT NOT NULL,
  role TEXT NOT NULL, action TEXT NOT NULL, at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_activity ON activity(circle_id, id);
CREATE TABLE IF NOT EXISTS outbox(id INTEGER PRIMARY KEY AUTOINCREMENT, circle_id TEXT, to_addr TEXT NOT NULL,
  subject TEXT NOT NULL, body TEXT NOT NULL, mode TEXT NOT NULL, at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_outbox ON outbox(circle_id, id);
CREATE TABLE IF NOT EXISTS notifications_sent(key TEXT PRIMARY KEY, at TEXT NOT NULL);
`;

/**
 * Open (and migrate) a SQLite database.
 * @param {string} file path or ':memory:'
 */
function openDb(file = ':memory:') {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA);
  return db;
}
module.exports = { openDb };

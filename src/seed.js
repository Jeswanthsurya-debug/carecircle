const bcrypt = require('bcryptjs');
const { ymd, stamp, addDays } = require('./time');
const { applyChange, ensureDoses } = require('./services');

/** Demo credentials: circle DEMO2026 / ELDER-2026 / CARER-2026 / FAMILY-2026 */
function seedDemo(db, { rounds = 10, now = new Date() } = {}) {
  if (db.prepare('SELECT 1 FROM circles WHERE id=?').get('DEMO2026')) return;
  db.prepare('INSERT INTO circles(id,elder_name,age,emergency_name,emergency_phone,emergency_email,created_at) VALUES(?,?,?,?,?,?,?)')
    .run('DEMO2026', 'Ramesh', 72, 'Anil (son)', '+91 98765 43210', 'anil@example.com', stamp(now));
  const pc = db.prepare('INSERT INTO passcodes(circle_id,role,hash) VALUES(?,?,?)');
  for (const [role, code] of [['elder', 'ELDER-2026'], ['caretaker', 'CARER-2026'], ['family', 'FAMILY-2026']])
    pc.run('DEMO2026', role, bcrypt.hashSync(code, rounds));
  const ct = db.prepare('INSERT INTO contacts(circle_id,role,name,email) VALUES(?,?,?,?)');
  ct.run('DEMO2026', 'elder', 'Ramesh', 'ramesh@example.com');
  ct.run('DEMO2026', 'caretaker', 'Priya', 'priya@example.com');
  ct.run('DEMO2026', 'family', 'Anil', 'anil@example.com');
  const start = ymd(addDays(now, -14));
  const base = { dosage: '', form: 'tablet', start_date: start, end_date: null, days: [0, 1, 2, 3, 4, 5, 6], instructions: '', pill_count: 40, refill_threshold: 5 };
  [
    { name: 'Metformin', dosage: '500 mg', times: ['08:00', '20:00'], instructions: 'Take with food', pill_count: 50 },
    { name: 'Amlodipine', dosage: '5 mg', times: ['09:00'], instructions: 'Blood pressure - morning' },
    { name: 'Atorvastatin', dosage: '10 mg', times: ['21:00'], instructions: 'After dinner', pill_count: 4 },
    { name: 'Vitamin D3', dosage: '1000 IU', form: 'capsule', times: ['13:00'], instructions: 'With lunch' },
  ].forEach((m) => applyChange(db, 'DEMO2026', 'med.create', { ...base, ...m }, now));
  ensureDoses(db, 'DEMO2026', start, ymd(now));
  const today = ymd(now);
  const rows = db.prepare('SELECT id,date,slot FROM doses WHERE circle_id=? ORDER BY date,slot').all('DEMO2026');
  const upd = db.prepare('UPDATE doses SET status=?,by_name=?,at=? WHERE id=?');
  rows.forEach((r, i) => {
    if (r.date >= today) return;
    if (i % 7 === 3) upd.run('missed', null, null, r.id);
    else upd.run('taken', i % 5 === 0 ? 'Priya' : 'Ramesh', `${r.date}T${r.slot}`, r.id);
  });
  const ap = (days, time, doctor, specialty, location, notes) =>
    applyChange(db, 'DEMO2026', 'appt.create', { doctor, specialty, location, at: `${ymd(addDays(now, days))}T${time}`, notes, status: 'scheduled' }, now);
  ap(2, '10:30', 'Dr. Meera Iyer', 'Cardiologist', 'Apollo Clinic, Chennai', 'Bring BP log');
  ap(9, '16:00', 'Dr. Suresh Rao', 'Diabetologist', 'City Diabetes Centre', 'Fasting blood test first');
  db.prepare('INSERT INTO notes(circle_id,author,role,text,created_at) VALUES(?,?,?,?,?)').run('DEMO2026', 'Anil', 'family', 'Proud of your 7 day streak, Appa! Call you tonight.', stamp(now));
}
module.exports = { seedDemo };

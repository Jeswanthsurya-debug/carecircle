const crypto = require('crypto');
const { ymd, hm, stamp, at, addDays } = require('./time');

const uid = () => crypto.randomUUID();
const medRow = (m) => ({ ...m, times: JSON.parse(m.times), days: JSON.parse(m.days) });

/** Active medications of a circle (times/days parsed). */
const listMeds = (db, cid) =>
  db.prepare('SELECT * FROM meds WHERE circle_id=? AND active=1 ORDER BY name').all(cid).map(medRow);

/** Emails of contacts holding any of the given roles. */
const emails = (db, cid, roles) =>
  db
    .prepare(`SELECT DISTINCT email FROM contacts WHERE circle_id=? AND role IN (${roles.map(() => '?').join(',')})`)
    .all(cid, ...roles)
    .map((r) => r.email);

/** Idempotently materialise dose rows for [from..to] (inclusive, "YYYY-MM-DD"). */
function ensureDoses(db, cid, from, to) {
  const meds = listMeds(db, cid);
  const ins = db.prepare('INSERT OR IGNORE INTO doses(id,med_id,circle_id,date,slot,time) VALUES(?,?,?,?,?,?)');
  db.transaction(() => {
    for (let d = at(from); ymd(d) <= to; d = addDays(d, 1)) {
      const date = ymd(d);
      for (const m of meds) {
        if (date < m.start_date || (m.end_date && date > m.end_date) || !m.days.includes(d.getDay())) continue;
        for (const t of m.times) ins.run(uid(), m.id, cid, date, t, t);
      }
    }
  })();
}

/** Apply a (possibly approved) change to meds / appointments. Returns null when target is missing. */
function applyChange(db, cid, type, p, now = new Date()) {
  const today = ymd(now);
  const medVals = (x) => [
    x.name, x.dosage, x.form, JSON.stringify([...new Set(x.times)].sort()), x.start_date,
    x.end_date ?? null, JSON.stringify(x.days), x.instructions, x.pill_count, x.refill_threshold,
  ];
  const apptVals = (x) => [x.doctor, x.specialty, x.location, x.at, x.notes, x.status];
  switch (type) {
    case 'med.create': {
      const id = uid();
      db.prepare(
        'INSERT INTO meds(name,dosage,form,times,start_date,end_date,days,instructions,pill_count,refill_threshold,id,circle_id) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)'
      ).run(...medVals(p), id, cid);
      ensureDoses(db, cid, today, today);
      return { id };
    }
    case 'med.update': {
      const r = db
        .prepare('UPDATE meds SET name=?,dosage=?,form=?,times=?,start_date=?,end_date=?,days=?,instructions=?,pill_count=?,refill_threshold=? WHERE id=? AND circle_id=?')
        .run(...medVals(p), p.id, cid);
      if (!r.changes) return null;
      db.prepare("DELETE FROM doses WHERE med_id=? AND status='pending' AND date>=?").run(p.id, today);
      ensureDoses(db, cid, today, today);
      return { id: p.id };
    }
    case 'med.delete':
      return db.prepare('DELETE FROM meds WHERE id=? AND circle_id=?').run(p.id, cid).changes ? { id: p.id } : null;
    case 'appt.create': {
      const id = uid();
      db.prepare('INSERT INTO appointments(doctor,specialty,location,at,notes,status,id,circle_id) VALUES(?,?,?,?,?,?,?,?)').run(...apptVals(p), id, cid);
      return { id };
    }
    case 'appt.update':
      return db.prepare('UPDATE appointments SET doctor=?,specialty=?,location=?,at=?,notes=?,status=? WHERE id=? AND circle_id=?')
        .run(...apptVals(p), p.id, cid).changes ? { id: p.id } : null;
    case 'appt.delete':
      return db.prepare('DELETE FROM appointments WHERE id=? AND circle_id=?').run(p.id, cid).changes ? { id: p.id } : null;
    default:
      throw new Error('Unknown change type');
  }
}

/** Adherence for the last `days` days incl. today (future doses are not counted). */
function adherence(db, cid, days, now = new Date()) {
  const today = ymd(now);
  const start = ymd(addDays(now, -(days - 1)));
  ensureDoses(db, cid, start, today);
  const nowT = hm(now);
  const byDay = new Map();
  for (let i = 0; i < days; i++) {
    const d = ymd(addDays(now, -(days - 1 - i)));
    byDay.set(d, { date: d, taken: 0, total: 0 });
  }
  for (const r of db.prepare('SELECT date,slot,status FROM doses WHERE circle_id=? AND date BETWEEN ? AND ?').all(cid, start, today)) {
    if (r.date === today && r.slot > nowT) continue;
    const o = byDay.get(r.date);
    o.total++;
    if (r.status === 'taken') o.taken++;
  }
  const list = [...byDay.values()].map((o) => ({ ...o, pct: o.total ? Math.round((o.taken / o.total) * 100) : null }));
  const taken = list.reduce((a, o) => a + o.taken, 0);
  const total = list.reduce((a, o) => a + o.total, 0);
  let streak = 0;
  for (let i = list.length - 1; i >= 0; i--) {
    const o = list[i];
    if (o.total === 0) continue;
    if (o.pct === 100) streak++;
    else if (i === list.length - 1) continue; // today still in progress
    else break;
  }
  return { days: list, overall: total ? Math.round((taken / total) * 100) : null, taken, total, streak };
}

/** Refill predictor: days of pills left per medicine; `low` when < 5 days or under the threshold. */
function refills(db, cid) {
  return listMeds(db, cid).map((m) => {
    const perDay = (m.times.length * m.days.length) / 7;
    const daysLeft = perDay ? Math.floor(m.pill_count / perDay) : null;
    return { id: m.id, name: m.name, pill_count: m.pill_count, daysLeft, low: daysLeft !== null && (daysLeft < 5 || m.pill_count <= m.refill_threshold) };
  });
}

/** Simple local safety rules. NOT medical advice. */
function safety(db, cid) {
  const meds = listMeds(db, cid);
  const warnings = [];
  const seen = new Set();
  for (const m of meds) {
    const k = m.name.trim().toLowerCase();
    if (seen.has(k)) warnings.push(`Possible duplicate: "${m.name}" is listed more than once.`);
    seen.add(k);
    if (m.times.length > 4) warnings.push(`"${m.name}" has ${m.times.length} doses per day - please confirm with the doctor.`);
  }
  const total = meds.reduce((a, m) => a + m.times.length, 0);
  if (total > 12) warnings.push(`${total} doses per day in total - please review the list with the doctor.`);
  return warnings;
}

/** Send once per key (idempotent via notifications_sent). */
const once = (db, key, now) =>
  db.prepare('INSERT OR IGNORE INTO notifications_sent(key,at) VALUES(?,?)').run(key, stamp(now)).changes === 1;

async function notify(db, mailer, cid, roles, subject, text, extra = []) {
  return mailer.send({ circleId: cid, to: [...emails(db, cid, roles), ...extra], subject, text });
}

/**
 * One scheduler tick: upcoming doses (15 min), missed doses (30 min -> elder, 60 min -> caretakers + family),
 * appointments (24h / 2h) and refill warnings. Idempotent.
 */
async function runOnce(db, mailer, now = new Date()) {
  const today = ymd(now);
  const nowS = stamp(now);
  const in24 = stamp(new Date(now.getTime() + 24 * 3600000));
  for (const c of db.prepare('SELECT id,elder_name FROM circles').all()) {
    ensureDoses(db, c.id, today, today);
    const doses = db
      .prepare("SELECT d.id,d.date,d.time,d.status,m.name,m.dosage FROM doses d JOIN meds m ON m.id=d.med_id WHERE d.circle_id=? AND d.date>=? AND d.status IN ('pending','missed')")
      .all(c.id, ymd(addDays(now, -1)));
    for (const d of doses) {
      const diff = (at(d.date, d.time) - now) / 60000;
      const label = `${d.name} ${d.dosage}`.trim();
      if (diff > 0 && diff <= 15 && once(db, `up:${d.id}`, now))
        await notify(db, mailer, c.id, ['elder'], `Reminder: ${label} at ${d.time}`, `Hello ${c.elder_name}, it is almost time for ${label} (${d.time}).`);
      if (diff <= -30) {
        db.prepare("UPDATE doses SET status='missed' WHERE id=? AND status='pending'").run(d.id);
        if (once(db, `miss1:${d.id}`, now))
          await notify(db, mailer, c.id, ['elder'], `Missed dose: ${label} (${d.time})`, `Hello ${c.elder_name}, you have not confirmed ${label} due at ${d.time}. Please take it and mark it as taken.`);
      }
      if (diff <= -60 && once(db, `miss2:${d.id}`, now))
        await notify(db, mailer, c.id, ['caretaker', 'family'], `ALERT: ${c.elder_name} missed ${label}`, `${c.elder_name} has not confirmed ${label} due at ${d.time} (over an hour ago). Please check in.`);
    }
    const appts = db.prepare("SELECT * FROM appointments WHERE circle_id=? AND status='scheduled' AND at>? AND at<=?").all(c.id, nowS, in24);
    for (const a of appts) {
      const diff = (new Date(a.at) - now) / 60000;
      const txt = `Appointment with ${a.doctor}${a.specialty ? ` (${a.specialty})` : ''} on ${a.at.replace('T', ' at ')}${a.location ? `, ${a.location}` : ''}.`;
      if (diff <= 120) {
        once(db, `ap24:${a.id}`, now);
        if (once(db, `ap2:${a.id}`, now)) await notify(db, mailer, c.id, ['elder', 'caretaker', 'family'], `In 2 hours: ${a.doctor}`, txt);
      } else if (once(db, `ap24:${a.id}`, now)) await notify(db, mailer, c.id, ['elder', 'caretaker', 'family'], `Tomorrow: ${a.doctor}`, txt);
    }
    for (const r of refills(db, c.id).filter((x) => x.low))
      if (once(db, `refill:${r.id}:${today}`, now))
        await notify(db, mailer, c.id, ['elder', 'caretaker'], `Refill soon: ${r.name}`, `${r.name} has ${r.pill_count} pills left (about ${r.daysLeft} days). Please arrange a refill.`);
  }
}

/** Weekly adherence digest for one circle. */
async function sendDigest(db, mailer, cid, now = new Date()) {
  const c = db.prepare('SELECT elder_name FROM circles WHERE id=?').get(cid);
  const a = adherence(db, cid, 7, now);
  const upcoming = db.prepare("SELECT doctor,at FROM appointments WHERE circle_id=? AND status='scheduled' AND at>=? ORDER BY at LIMIT 3").all(cid, stamp(now));
  const text = [
    `Weekly summary for ${c.elder_name}`,
    `Adherence: ${a.overall ?? 'n/a'}% (${a.taken}/${a.total} doses), current streak: ${a.streak} day(s).`,
    ...a.days.map((d) => `  ${d.date}: ${d.pct ?? '-'}%`),
    upcoming.length ? `Upcoming: ${upcoming.map((u) => `${u.doctor} ${u.at.replace('T', ' ')}`).join('; ')}` : 'No upcoming appointments.',
  ].join('\n');
  return notify(db, mailer, cid, ['elder', 'caretaker', 'family'], `Weekly care summary for ${c.elder_name}`, text);
}

module.exports = { uid, listMeds, emails, ensureDoses, applyChange, adherence, refills, safety, runOnce, sendDigest, notify };

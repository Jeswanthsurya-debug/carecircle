const path = require('path');
const crypto = require('crypto');
const express = require('express');
const helmet = require('helmet');
const compression = require('compression');
const cookieParser = require('cookie-parser');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { z, ZodError } = require('zod');
const svc = require('./services');
const { ymd, stamp, addMin } = require('./time');

const ROLES = ['elder', 'caretaker', 'family'];
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const code = (n) => Array.from({ length: n }, () => ALPHABET[crypto.randomInt(ALPHABET.length)]).join('');
const newPasscode = () => `${code(4)}-${code(4)}`;

const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use HH:MM (24h)');
const dateS = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');
const email = z.string().trim().email().max(120);
const S = {
  circle: z.object({
    elderName: z.string().trim().min(1).max(60), age: z.coerce.number().int().min(1).max(120),
    emergencyName: z.string().trim().max(60).default(''), emergencyPhone: z.string().trim().max(30).default(''),
    emergencyEmail: email.optional().or(z.literal('')), elderEmail: email.optional().or(z.literal('')),
    caretakerEmail: email.optional().or(z.literal('')), familyEmail: email.optional().or(z.literal('')),
  }).strict(),
  join: z.object({ circleId: z.string().trim().min(1).max(20), passcode: z.string().trim().min(1).max(40), name: z.string().trim().min(1).max(40) }).strict(),
  med: z.object({
    name: z.string().trim().min(1).max(80), dosage: z.string().trim().max(40).default(''), form: z.string().trim().max(30).default('tablet'),
    times: z.array(hhmm).min(1).max(8), start_date: dateS, end_date: dateS.nullable().optional(),
    days: z.array(z.number().int().min(0).max(6)).min(1).max(7).default([0, 1, 2, 3, 4, 5, 6]),
    instructions: z.string().trim().max(200).default(''), pill_count: z.coerce.number().int().min(0).max(1000).default(0),
    refill_threshold: z.coerce.number().int().min(0).max(100).default(5),
  }).strict(),
  appt: z.object({
    doctor: z.string().trim().min(1).max(80), specialty: z.string().trim().max(60).default(''), location: z.string().trim().max(120).default(''),
    at: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/, 'Use a valid date and time'), notes: z.string().trim().max(300).default(''),
    status: z.enum(['scheduled', 'completed', 'cancelled']).default('scheduled'),
  }).strict(),
  dose: z.object({ action: z.enum(['take', 'skip', 'snooze']) }).strict(),
  checkin: z.object({ mood: z.coerce.number().int().min(1).max(5), pain: z.coerce.number().int().min(0).max(10), note: z.string().trim().max(200).default('') }).strict(),
  note: z.object({ text: z.string().trim().min(1).max(300) }).strict(),
  settings: z.object({ requireApproval: z.boolean() }).strict(),
  contacts: z.object({ contacts: z.array(z.object({ role: z.enum(ROLES), name: z.string().trim().max(60).default(''), email })).max(12) }).strict(),
};

/**
 * Build the Express app. Dependencies are injected so tests can use an in-memory DB and a fake clock.
 * @param {{db:object, mailer:object, env?:object, clock?:()=>Date}} deps
 */
function createApp({ db, mailer, env = process.env, clock = () => new Date() }) {
  const app = express();
  const prod = env.NODE_ENV === 'production';
  const rounds = Number(env.BCRYPT_ROUNDS || 10);
  const secret = env.JWT_SECRET || crypto.randomBytes(32).toString('hex');
  const dummyHash = bcrypt.hashSync('not-a-real-passcode', rounds);
  const num = (v, d) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : d);

  app.set('trust proxy', 1);
  app.disable('x-powered-by');
  app.use(helmet({
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        defaultSrc: ["'self'"], scriptSrc: ["'self'"], styleSrc: ["'self'"], imgSrc: ["'self'", 'data:'],
        connectSrc: ["'self'"], objectSrc: ["'none'"], baseUri: ["'self'"], formAction: ["'self'"], frameAncestors: ["'none'"],
      },
    },
  }));
  app.use(compression());
  app.use(cors({ origin: env.CORS_ORIGIN ? env.CORS_ORIGIN.split(',') : false, credentials: true }));
  app.use(express.json({ limit: '20kb' }));
  app.use(cookieParser());

  app.get('/health', (_req, res) => res.json({ status: 'ok' }));

  const api = express.Router();
  api.use(rateLimit({ windowMs: 60000, max: num(env.API_LIMIT, 300), standardHeaders: true, legacyHeaders: false }));
  // CSRF: SameSite=Strict cookie + required custom header on every state-changing request.
  api.use((req, res, next) => {
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && req.get('x-requested-with') !== 'CareCircle')
      return res.status(403).json({ error: 'Missing CSRF header' });
    next();
  });

  const auth = (...roles) => (req, res, next) => {
    try {
      req.user = jwt.verify(req.cookies.cc_token, secret);
    } catch {
      return res.status(401).json({ error: 'Please sign in' });
    }
    if (roles.length && !roles.includes(req.user.role)) return res.status(403).json({ error: 'Your role is not allowed to do this' });
    next();
  };
  const h = (fn) => (req, res, next) => Promise.resolve(fn(req, res)).catch(next);
  const circleOf = (cid) => db.prepare('SELECT * FROM circles WHERE id=?').get(cid);
  const log = (u, action) => db.prepare('INSERT INTO activity(circle_id,actor,role,action,at) VALUES(?,?,?,?,?)').run(u.cid, u.name, u.role, action, stamp(clock()));
  const hashAll = (pw) => bcrypt.hashSync(pw, rounds);

  // ---------- access ----------
  api.post('/circles', rateLimit({ windowMs: 3600000, max: num(env.CREATE_LIMIT, 20) }), (req, res) => {
    const b = S.circle.parse(req.body);
    const id = code(8);
    const passcodes = { elder: newPasscode(), caretaker: newPasscode(), family: newPasscode() };
    db.transaction(() => {
      db.prepare('INSERT INTO circles(id,elder_name,age,emergency_name,emergency_phone,emergency_email,created_at) VALUES(?,?,?,?,?,?,?)')
        .run(id, b.elderName, b.age, b.emergencyName, b.emergencyPhone, b.emergencyEmail || '', stamp(clock()));
      for (const r of ROLES) db.prepare('INSERT INTO passcodes(circle_id,role,hash) VALUES(?,?,?)').run(id, r, hashAll(passcodes[r]));
      for (const [r, e] of [['elder', b.elderEmail], ['caretaker', b.caretakerEmail], ['family', b.familyEmail]])
        if (e) db.prepare('INSERT INTO contacts(circle_id,role,name,email) VALUES(?,?,?,?)').run(id, r, r, e);
    })();
    res.status(201).json({ circleId: id, passcodes, note: 'Passcodes are shown only once. Save them now.' });
  });

  api.post('/join', rateLimit({
    windowMs: 15 * 60000, max: num(env.LOGIN_LIMIT, 5), standardHeaders: true, legacyHeaders: false,
    message: { error: 'Too many attempts. Please try again in 15 minutes.' },
  }), (req, res) => {
    const b = S.join.parse(req.body);
    const cid = b.circleId.toUpperCase();
    const rows = db.prepare('SELECT role,hash FROM passcodes WHERE circle_id=?').all(cid);
    let role = null;
    for (const r of rows.length ? rows : [{ role: null, hash: dummyHash }]) {
      if (bcrypt.compareSync(b.passcode.toUpperCase(), r.hash) && !role) role = r.role; // bcrypt compare is constant-time
    }
    if (!role) return res.status(401).json({ error: 'Circle code or passcode is not correct' });
    const token = jwt.sign({ cid, role, name: b.name }, secret, { expiresIn: '12h' });
    res.cookie('cc_token', token, { httpOnly: true, sameSite: 'strict', secure: prod, maxAge: 12 * 3600000 });
    log({ cid, role, name: b.name }, 'joined the circle');
    res.json({ role, name: b.name });
  });

  api.post('/logout', (_req, res) => res.clearCookie('cc_token').json({ ok: true }));

  api.get('/me', auth(), (req, res) => {
    const c = circleOf(req.user.cid);
    if (!c) return res.status(401).json({ error: 'Circle no longer exists' });
    const canSee = req.user.role !== 'family';
    res.json({
      role: req.user.role, name: req.user.name, mailMode: mailer.mode,
      circle: { id: c.id, elderName: c.elder_name, age: c.age, emergencyName: c.emergency_name, emergencyPhone: c.emergency_phone, requireApproval: !!c.require_approval },
      contacts: canSee ? db.prepare('SELECT role,name,email FROM contacts WHERE circle_id=?').all(c.id) : [],
    });
  });

  // ---------- change submission (caretaker edits may need elder approval) ----------
  const submit = (req, res, type, payload, okStatus = 200) => {
    const u = req.user;
    if (u.role === 'caretaker' && circleOf(u.cid).require_approval) {
      db.prepare('INSERT INTO pending(circle_id,type,payload,by_name,created_at) VALUES(?,?,?,?,?)').run(u.cid, type, JSON.stringify(payload), u.name, stamp(clock()));
      log(u, `requested: ${type}`);
      return res.status(202).json({ pending: true, message: 'Sent to the elder for approval' });
    }
    const r = svc.applyChange(db, u.cid, type, payload, clock());
    if (!r) return res.status(404).json({ error: 'Not found' });
    log(u, type);
    res.status(okStatus).json(r);
  };
  const W = ['elder', 'caretaker'];

  // ---------- medications ----------
  api.get('/meds', auth(), (req, res) => res.json(svc.listMeds(db, req.user.cid)));
  api.post('/meds', auth(...W), (req, res) => submit(req, res, 'med.create', S.med.parse(req.body), 201));
  api.put('/meds/:id', auth(...W), (req, res) => submit(req, res, 'med.update', { ...S.med.parse(req.body), id: req.params.id }));
  api.delete('/meds/:id', auth(...W), (req, res) => submit(req, res, 'med.delete', { id: req.params.id }));
  api.get('/refills', auth(), (req, res) => res.json(svc.refills(db, req.user.cid)));
  api.get('/safety', auth(), (req, res) => res.json({ warnings: svc.safety(db, req.user.cid), disclaimer: 'Not medical advice. Always confirm with a doctor or pharmacist.' }));

  // ---------- doses ----------
  api.get('/today', auth(), (req, res) => {
    const d = ymd(clock());
    svc.ensureDoses(db, req.user.cid, d, d);
    const doses = db.prepare('SELECT d.id,d.time,d.slot,d.status,d.by_name,d.at,m.name,m.dosage,m.form,m.instructions FROM doses d JOIN meds m ON m.id=d.med_id WHERE d.circle_id=? AND d.date=? ORDER BY d.time').all(req.user.cid, d);
    res.json({ date: d, doses });
  });
  api.post('/doses/:id', auth(...W), (req, res) => {
    const { action } = S.dose.parse(req.body);
    const u = req.user;
    const d = db.prepare('SELECT * FROM doses WHERE id=? AND circle_id=?').get(req.params.id, u.cid);
    if (!d) return res.status(404).json({ error: 'Not found' });
    const now = clock();
    if (action === 'take') {
      if (d.status !== 'taken') {
        db.prepare("UPDATE doses SET status='taken',by_name=?,at=? WHERE id=?").run(u.name, stamp(now), d.id);
        db.prepare('UPDATE meds SET pill_count=MAX(0,pill_count-1) WHERE id=?').run(d.med_id);
      }
    } else if (action === 'skip') db.prepare("UPDATE doses SET status='skipped',by_name=?,at=? WHERE id=?").run(u.name, stamp(now), d.id);
    else {
      const t = addMin(new Date(`${d.date}T${d.time}:00`), 15);
      const time = ymd(t) === d.date ? stamp(t).slice(11) : '23:59';
      db.prepare("UPDATE doses SET status='pending',time=? WHERE id=?").run(time, d.id);
    }
    log(u, `dose ${action}`);
    res.json(db.prepare('SELECT id,time,status,by_name,at FROM doses WHERE id=?').get(d.id));
  });
  api.get('/adherence', auth(), (req, res) => res.json(svc.adherence(db, req.user.cid, Math.min(90, Math.max(1, Number(req.query.days) || 30)), clock())));

  // ---------- appointments ----------
  api.get('/appointments', auth(), (req, res) => {
    const q = req.query.upcoming ? "AND status='scheduled' AND at>=? ORDER BY at" : 'AND at>=? ORDER BY at DESC';
    res.json(db.prepare(`SELECT * FROM appointments WHERE circle_id=? ${q}`).all(req.user.cid, req.query.upcoming ? stamp(clock()) : '0000'));
  });
  api.post('/appointments', auth(...W), (req, res) => submit(req, res, 'appt.create', S.appt.parse(req.body), 201));
  api.put('/appointments/:id', auth(...W), (req, res) => submit(req, res, 'appt.update', { ...S.appt.parse(req.body), id: req.params.id }));
  api.delete('/appointments/:id', auth(...W), (req, res) => submit(req, res, 'appt.delete', { id: req.params.id }));
  api.get('/appointments/:id/ics', auth(), (req, res) => {
    const a = db.prepare('SELECT * FROM appointments WHERE id=? AND circle_id=?').get(req.params.id, req.user.cid);
    if (!a) return res.status(404).json({ error: 'Not found' });
    const esc = (s) => String(s).replace(/[\\;,]/g, (m) => `\\${m}`).replace(/\r?\n/g, '\\n');
    const dt = `${a.at.replace(/[-:]/g, '')}00`;
    res.type('text/calendar').set('Content-Disposition', 'attachment; filename="appointment.ics"').send(
      ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//CareCircle//EN', 'BEGIN:VEVENT', `UID:${a.id}@carecircle`, `DTSTAMP:${dt}`, `DTSTART:${dt}`,
        `SUMMARY:${esc(`Doctor: ${a.doctor}`)}`, `LOCATION:${esc(a.location)}`, `DESCRIPTION:${esc(a.notes)}`, 'END:VEVENT', 'END:VCALENDAR'].join('\r\n'));
  });

  // ---------- wellness, notes, SOS ----------
  api.post('/checkin', auth('elder'), (req, res) => {
    const b = S.checkin.parse(req.body);
    db.prepare('INSERT INTO checkins(circle_id,date,mood,pain,note) VALUES(?,?,?,?,?) ON CONFLICT(circle_id,date) DO UPDATE SET mood=excluded.mood,pain=excluded.pain,note=excluded.note')
      .run(req.user.cid, ymd(clock()), b.mood, b.pain, b.note);
    log(req.user, 'wellness check-in');
    res.status(201).json({ ok: true });
  });
  api.get('/checkins', auth(), (req, res) => res.json(db.prepare('SELECT date,mood,pain,note FROM checkins WHERE circle_id=? ORDER BY date DESC LIMIT 14').all(req.user.cid)));
  api.get('/notes', auth(), (req, res) => res.json(db.prepare('SELECT author,role,text,created_at FROM notes WHERE circle_id=? ORDER BY id DESC LIMIT 30').all(req.user.cid)));
  api.post('/notes', auth(), (req, res) => {
    db.prepare('INSERT INTO notes(circle_id,author,role,text,created_at) VALUES(?,?,?,?,?)').run(req.user.cid, req.user.name, req.user.role, S.note.parse(req.body).text, stamp(clock()));
    res.status(201).json({ ok: true });
  });
  api.post('/sos', auth(...W), h(async (req, res) => {
    const c = circleOf(req.user.cid);
    const n = await svc.notify(db, mailer, c.id, ROLES, `SOS: ${c.elder_name} needs help`,
      `${req.user.name} pressed SOS for ${c.elder_name} at ${stamp(clock()).replace('T', ' ')}.\nEmergency contact: ${c.emergency_name} ${c.emergency_phone}`, c.emergency_email ? [c.emergency_email] : []);
    log(req.user, 'SOS sent');
    res.json({ notified: n });
  }));

  // ---------- elder control: approvals, settings, passcodes, contacts ----------
  api.get('/pending', auth(...W), (req, res) =>
    res.json(db.prepare("SELECT id,type,payload,by_name,created_at FROM pending WHERE circle_id=? AND status='pending' ORDER BY id").all(req.user.cid).map((r) => ({ ...r, payload: JSON.parse(r.payload) }))));
  api.post('/pending/:id/:decision', auth('elder'), (req, res) => {
    if (!['approve', 'reject'].includes(req.params.decision)) return res.status(404).json({ error: 'Not found' });
    const p = db.prepare("SELECT * FROM pending WHERE id=? AND circle_id=? AND status='pending'").get(req.params.id, req.user.cid);
    if (!p) return res.status(404).json({ error: 'Not found' });
    if (req.params.decision === 'approve' && !svc.applyChange(db, req.user.cid, p.type, JSON.parse(p.payload), clock()))
      return res.status(404).json({ error: 'The item no longer exists' });
    db.prepare('UPDATE pending SET status=? WHERE id=?').run(req.params.decision === 'approve' ? 'approved' : 'rejected', p.id);
    log(req.user, `${req.params.decision}d ${p.by_name}'s request (${p.type})`);
    res.json({ ok: true });
  });
  api.put('/settings', auth('elder'), (req, res) => {
    db.prepare('UPDATE circles SET require_approval=? WHERE id=?').run(S.settings.parse(req.body).requireApproval ? 1 : 0, req.user.cid);
    log(req.user, 'changed approval setting');
    res.json({ ok: true });
  });
  api.post('/passcodes/:role/regenerate', auth('elder'), (req, res) => {
    if (!ROLES.includes(req.params.role)) return res.status(404).json({ error: 'Not found' });
    const pc = newPasscode();
    db.prepare('UPDATE passcodes SET hash=? WHERE circle_id=? AND role=?').run(hashAll(pc), req.user.cid, req.params.role);
    log(req.user, `regenerated ${req.params.role} passcode`);
    res.json({ role: req.params.role, passcode: pc, note: 'Shown only once. The old passcode no longer works.' });
  });
  api.put('/contacts', auth('elder'), (req, res) => {
    const { contacts } = S.contacts.parse(req.body);
    db.transaction(() => {
      db.prepare('DELETE FROM contacts WHERE circle_id=?').run(req.user.cid);
      for (const c of contacts) db.prepare('INSERT INTO contacts(circle_id,role,name,email) VALUES(?,?,?,?)').run(req.user.cid, c.role, c.name, c.email);
    })();
    log(req.user, 'updated email contacts');
    res.json({ ok: true });
  });
  api.get('/activity', auth('elder'), (req, res) => res.json(db.prepare('SELECT actor,role,action,at FROM activity WHERE circle_id=? ORDER BY id DESC LIMIT 50').all(req.user.cid)));
  api.get('/outbox', auth(...W), (req, res) => res.json(db.prepare('SELECT to_addr,subject,body,mode,at FROM outbox WHERE circle_id=? ORDER BY id DESC LIMIT 50').all(req.user.cid)));
  api.post('/digest/test', auth(...W), h(async (req, res) => res.json({ notified: await svc.sendDigest(db, mailer, req.user.cid, clock()) })));
  api.get('/export', auth(), (req, res) => {
    const c = circleOf(req.user.cid);
    res.set('Content-Disposition', 'attachment; filename="health-summary.json"').json({
      patient: { name: c.elder_name, age: c.age, emergencyContact: `${c.emergency_name} ${c.emergency_phone}` }, generatedAt: stamp(clock()),
      medications: svc.listMeds(db, c.id), appointments: db.prepare('SELECT doctor,specialty,location,at,notes,status FROM appointments WHERE circle_id=? ORDER BY at').all(c.id),
      adherence30: svc.adherence(db, c.id, 30, clock()), checkins: db.prepare('SELECT date,mood,pain,note FROM checkins WHERE circle_id=? ORDER BY date DESC LIMIT 30').all(c.id),
    });
  });

  api.use((_req, res) => res.status(404).json({ error: 'Not found' }));
  app.use('/api', api);
  app.use(express.static(path.join(__dirname, '..', 'public'), { maxAge: env.NODE_ENV === 'production' ? '1h' : 0 }));

  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    if (err instanceof ZodError) {
      const fields = {};
      for (const i of err.issues) fields[i.path.join('.') || '_'] = i.message;
      return res.status(400).json({ error: 'Please check the highlighted fields', fields });
    }
    if (err.type === 'entity.parse.failed' || err.type === 'entity.too.large') return res.status(400).json({ error: 'Invalid request body' });
    console.error(err);
    res.status(500).json({ error: 'Something went wrong' });
  });
  return app;
}
module.exports = { createApp };

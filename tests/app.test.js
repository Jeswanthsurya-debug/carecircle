const request = require('supertest');
const bcrypt = require('bcryptjs');
const { openDb } = require('../src/db');
const { createMailer } = require('../src/mail');
const { createApp } = require('../src/app');
const { seedDemo } = require('../src/seed');
const svc = require('../src/services');

const ENV = { BCRYPT_ROUNDS: '4', JWT_SECRET: 'test-secret', LOGIN_LIMIT: '1000', API_LIMIT: '100000', CREATE_LIMIT: '1000' };
let db, mailer, app, now;
const clock = () => now;
const H = { 'X-Requested-With': 'CareCircle' };

function setup(env = ENV) {
  db = openDb(':memory:');
  mailer = createMailer(db, {});
  app = createApp({ db, mailer, env, clock });
}
async function newCircle(extra = {}) {
  const r = await request(app).post('/api/circles').set(H).send({
    elderName: 'Asha', age: 70, emergencyName: 'Ravi', emergencyPhone: '999', elderEmail: 'asha@x.com',
    caretakerEmail: 'care@x.com', familyEmail: 'fam@x.com', ...extra,
  });
  return r.body;
}
async function login(circle, role, name = role) {
  const a = request.agent(app).set(H);
  const r = await a.post('/api/join').send({ circleId: circle.circleId, passcode: circle.passcodes[role], name });
  expect(r.status).toBe(200);
  return a;
}
const med = (o = {}) => ({ name: 'Metformin', dosage: '500 mg', times: ['08:00'], start_date: '2026-11-10', days: [0, 1, 2, 3, 4, 5, 6], pill_count: 30, ...o });
const outbox = (like) => db.prepare('SELECT * FROM outbox WHERE subject LIKE ?').all(like);

beforeEach(() => {
  now = new Date('2026-11-16T08:00:00');
  setup();
});

describe('access & security', () => {
  test('health endpoint', async () => {
    expect((await request(app).get('/health')).body.status).toBe('ok');
  });
  test('circle creation returns 3 passcodes and stores only bcrypt hashes', async () => {
    const c = await newCircle();
    expect(Object.keys(c.passcodes).sort()).toEqual(['caretaker', 'elder', 'family']);
    const rows = db.prepare('SELECT hash FROM passcodes WHERE circle_id=?').all(c.circleId);
    expect(rows).toHaveLength(3);
    rows.forEach((r) => expect(r.hash).toMatch(/^\$2[aby]\$/));
    expect(bcrypt.compareSync(c.passcodes.elder, rows.find((r) => bcrypt.compareSync(c.passcodes.elder, r.hash)).hash)).toBe(true);
  });
  test('join succeeds with an httpOnly SameSite=Strict cookie', async () => {
    const c = await newCircle();
    const r = await request(app).post('/api/join').set(H).send({ circleId: c.circleId, passcode: c.passcodes.family, name: 'Sam' });
    expect(r.status).toBe(200);
    expect(r.body.role).toBe('family');
    const cookie = r.headers['set-cookie'][0];
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Strict/i);
  });
  test('wrong passcode and unknown circle give the same generic error', async () => {
    const c = await newCircle();
    const a = await request(app).post('/api/join').set(H).send({ circleId: c.circleId, passcode: 'WRONG-CODE', name: 'x' });
    const b = await request(app).post('/api/join').set(H).send({ circleId: 'NOPE1234', passcode: 'WRONG-CODE', name: 'x' });
    expect(a.status).toBe(401);
    expect(b.status).toBe(401);
    expect(a.body.error).toBe(b.body.error);
  });
  test('login is rate limited (5 attempts)', async () => {
    const limited = createApp({ db, mailer, env: { ...ENV, LOGIN_LIMIT: '5' }, clock });
    let last;
    for (let i = 0; i < 6; i++) last = await request(limited).post('/api/join').set(H).send({ circleId: 'X', passcode: 'Y', name: 'z' });
    expect(last.status).toBe(429);
  });
  test('state-changing requests without the CSRF header are rejected', async () => {
    const r = await request(app).post('/api/join').send({ circleId: 'X', passcode: 'Y', name: 'z' });
    expect(r.status).toBe(403);
  });
  test('unauthenticated API access is rejected', async () => {
    expect((await request(app).get('/api/meds')).status).toBe(401);
  });
  test('security headers include a strict CSP', async () => {
    const r = await request(app).get('/health');
    expect(r.headers['content-security-policy']).toMatch(/script-src 'self'/);
    expect(r.headers['x-powered-by']).toBeUndefined();
  });
  test('regenerating a passcode invalidates the old one', async () => {
    const c = await newCircle();
    const elder = await login(c, 'elder');
    const r = await elder.post('/api/passcodes/family/regenerate');
    expect(r.body.passcode).not.toBe(c.passcodes.family);
    const old = await request(app).post('/api/join').set(H).send({ circleId: c.circleId, passcode: c.passcodes.family, name: 'x' });
    expect(old.status).toBe(401);
    const fresh = await request(app).post('/api/join').set(H).send({ circleId: c.circleId, passcode: r.body.passcode, name: 'x' });
    expect(fresh.status).toBe(200);
  });
  test('invalid JSON / oversized bodies get a clean 400, no stack trace', async () => {
    const r = await request(app).post('/api/join').set(H).set('Content-Type', 'application/json').send('{bad');
    expect(r.status).toBe(400);
    expect(JSON.stringify(r.body)).not.toMatch(/at .*\.js/);
  });
});

describe('roles, IDOR and approvals', () => {
  test('family cannot create, edit or take doses; family can read', async () => {
    const c = await newCircle();
    const elder = await login(c, 'elder');
    const m = (await elder.post('/api/meds').send(med())).body;
    const fam = await login(c, 'family');
    expect((await fam.post('/api/meds').send(med())).status).toBe(403);
    expect((await fam.put(`/api/meds/${m.id}`).send(med())).status).toBe(403);
    expect((await fam.get('/api/meds')).status).toBe(200);
    const today = (await fam.get('/api/today')).body.doses[0];
    expect((await fam.post(`/api/doses/${today.id}`).send({ action: 'take' })).status).toBe(403);
  });
  test('another circle cannot read or change my resources (IDOR)', async () => {
    const a = await newCircle();
    const b = await newCircle({ elderName: 'Other' });
    const elderA = await login(a, 'elder');
    const m = (await elderA.post('/api/meds').send(med())).body;
    const ap = (await elderA.post('/api/appointments').send({ doctor: 'Dr A', at: '2026-11-20T10:00' })).body;
    const elderB = await login(b, 'elder');
    expect((await elderB.get('/api/meds')).body).toHaveLength(0);
    expect((await elderB.put(`/api/meds/${m.id}`).send(med())).status).toBe(404);
    expect((await elderB.delete(`/api/meds/${m.id}`)).status).toBe(404);
    expect((await elderB.get(`/api/appointments/${ap.id}/ics`)).status).toBe(404);
  });
  test('caretaker edits go to the elder approval queue when enabled', async () => {
    const c = await newCircle();
    const elder = await login(c, 'elder');
    const care = await login(c, 'caretaker', 'Priya');
    expect((await elder.put('/api/settings').send({ requireApproval: true })).status).toBe(200);
    const r = await care.post('/api/meds').send(med({ name: 'Aspirin' }));
    expect(r.status).toBe(202);
    expect((await elder.get('/api/meds')).body).toHaveLength(0);
    const q = (await elder.get('/api/pending')).body;
    expect(q).toHaveLength(1);
    expect((await care.post(`/api/pending/${q[0].id}/approve`)).status).toBe(403);
    expect((await elder.post(`/api/pending/${q[0].id}/approve`)).status).toBe(200);
    expect((await elder.get('/api/meds')).body[0].name).toBe('Aspirin');
  });
  test('elder can reject a pending change', async () => {
    const c = await newCircle();
    const elder = await login(c, 'elder');
    const care = await login(c, 'caretaker');
    await elder.put('/api/settings').send({ requireApproval: true });
    await care.post('/api/meds').send(med());
    const q = (await elder.get('/api/pending')).body;
    await elder.post(`/api/pending/${q[0].id}/reject`);
    expect((await elder.get('/api/meds')).body).toHaveLength(0);
    expect((await elder.get('/api/pending')).body).toHaveLength(0);
  });
  test('caretaker applies changes directly when approval is off; cannot change settings', async () => {
    const c = await newCircle();
    const care = await login(c, 'caretaker');
    expect((await care.post('/api/meds').send(med())).status).toBe(201);
    expect((await care.put('/api/settings').send({ requireApproval: true })).status).toBe(403);
    expect((await care.post('/api/passcodes/elder/regenerate')).status).toBe(403);
  });
  test('activity log is elder-only and records who did what', async () => {
    const c = await newCircle();
    const elder = await login(c, 'elder', 'Asha');
    const care = await login(c, 'caretaker', 'Priya');
    await care.post('/api/meds').send(med());
    expect((await care.get('/api/activity')).status).toBe(403);
    const log = (await elder.get('/api/activity')).body;
    expect(log.some((l) => l.actor === 'Priya' && l.action === 'med.create')).toBe(true);
  });
});

describe('medications, doses, adherence', () => {
  test('medication CRUD with validation', async () => {
    const c = await newCircle();
    const e = await login(c, 'elder');
    const bad = await e.post('/api/meds').send(med({ times: ['25:99'] }));
    expect(bad.status).toBe(400);
    expect(bad.body.fields['times.0']).toBeDefined();
    expect((await e.post('/api/meds').send({ ...med(), evil: 'x' })).status).toBe(400);
    const m = (await e.post('/api/meds').send(med())).body;
    expect((await e.put(`/api/meds/${m.id}`).send(med({ dosage: '1000 mg' }))).status).toBe(200);
    expect((await e.get('/api/meds')).body[0].dosage).toBe('1000 mg');
    expect((await e.delete(`/api/meds/${m.id}`)).status).toBe(200);
    expect((await e.get('/api/meds')).body).toHaveLength(0);
  });
  test('taking a dose records who/when and decrements pill count', async () => {
    const c = await newCircle();
    const care = await login(c, 'caretaker', 'Priya');
    await care.post('/api/meds').send(med());
    const d = (await care.get('/api/today')).body.doses[0];
    const r = await care.post(`/api/doses/${d.id}`).send({ action: 'take' });
    expect(r.body.status).toBe('taken');
    expect(r.body.by_name).toBe('Priya');
    await care.post(`/api/doses/${d.id}`).send({ action: 'take' });
    expect((await care.get('/api/meds')).body[0].pill_count).toBe(29);
  });
  test('skip and snooze work; invalid action rejected', async () => {
    const c = await newCircle();
    const e = await login(c, 'elder');
    await e.post('/api/meds').send(med());
    const d = (await e.get('/api/today')).body.doses[0];
    expect((await e.post(`/api/doses/${d.id}`).send({ action: 'snooze' })).body.time).toBe('08:15');
    expect((await e.post(`/api/doses/${d.id}`).send({ action: 'skip' })).body.status).toBe('skipped');
    expect((await e.post(`/api/doses/${d.id}`).send({ action: 'nuke' })).status).toBe(400);
  });
  test('adherence percentage and streak are calculated correctly', async () => {
    const c = await newCircle();
    const e = await login(c, 'elder');
    await e.post('/api/meds').send(med({ times: ['08:00', '20:00'], start_date: '2026-11-14' }));
    db.prepare("UPDATE doses SET status='taken'").run();
    now = new Date('2026-11-16T21:00:00');
    const first = (await e.get('/api/adherence?days=7')).body;
    expect(first.total).toBe(6);
    expect(first.overall).toBe(Math.round((first.taken / 6) * 100));
    db.prepare("UPDATE doses SET status='taken'").run();
    const all = (await e.get('/api/adherence?days=7')).body;
    expect(all.overall).toBe(100);
    expect(all.streak).toBe(3);
    db.prepare("UPDATE doses SET status='missed' WHERE date='2026-11-15' AND slot='20:00'").run();
    const broken = (await e.get('/api/adherence?days=7')).body;
    expect(broken.overall).toBe(83);
    expect(broken.streak).toBe(1);
  });
  test('refill predictor flags medicines running out in under 5 days', async () => {
    const c = await newCircle();
    const e = await login(c, 'elder');
    await e.post('/api/meds').send(med({ times: ['08:00', '20:00'], pill_count: 4 }));
    await e.post('/api/meds').send(med({ name: 'Plenty', pill_count: 90 }));
    const r = (await e.get('/api/refills')).body;
    expect(r.find((x) => x.name === 'Metformin')).toMatchObject({ daysLeft: 2, low: true });
    expect(r.find((x) => x.name === 'Plenty').low).toBe(false);
  });
  test('safety check flags duplicates and excessive doses', async () => {
    const c = await newCircle();
    const e = await login(c, 'elder');
    await e.post('/api/meds').send(med());
    await e.post('/api/meds').send(med({ name: 'metformin', times: ['06:00', '09:00', '12:00', '15:00', '18:00'] }));
    const w = (await e.get('/api/safety')).body;
    expect(w.warnings.length).toBeGreaterThanOrEqual(2);
    expect(w.disclaimer).toMatch(/not medical advice/i);
  });
});

describe('appointments, wellness, notes, SOS', () => {
  test('appointment CRUD, validation and .ics download', async () => {
    const c = await newCircle();
    const e = await login(c, 'elder');
    expect((await e.post('/api/appointments').send({ doctor: 'Dr X', at: 'tomorrow' })).status).toBe(400);
    const a = (await e.post('/api/appointments').send({ doctor: 'Dr X', specialty: 'Heart', at: '2026-11-20T10:30' })).body;
    const ics = await e.get(`/api/appointments/${a.id}/ics`);
    expect(ics.headers['content-type']).toMatch(/calendar/);
    expect(ics.text).toContain('DTSTART:20261120T103000');
    await e.put(`/api/appointments/${a.id}`).send({ doctor: 'Dr Y', at: '2026-11-21T09:00' });
    expect((await e.get('/api/appointments?upcoming=1')).body[0].doctor).toBe('Dr Y');
    await e.delete(`/api/appointments/${a.id}`);
    expect((await e.get('/api/appointments?upcoming=1')).body).toHaveLength(0);
  });
  test('wellness check-in is elder-only and validated', async () => {
    const c = await newCircle();
    const e = await login(c, 'elder');
    const care = await login(c, 'caretaker');
    expect((await care.post('/api/checkin').send({ mood: 4, pain: 2 })).status).toBe(403);
    expect((await e.post('/api/checkin').send({ mood: 4, pain: 11 })).status).toBe(400);
    expect((await e.post('/api/checkin').send({ mood: 4, pain: 2, note: 'ok' })).status).toBe(201);
    expect((await care.get('/api/checkins')).body[0]).toMatchObject({ mood: 4, pain: 2 });
  });
  test('family can post encouragement notes', async () => {
    const c = await newCircle();
    const fam = await login(c, 'family', 'Ravi');
    expect((await fam.post('/api/notes').send({ text: 'Proud of you!' })).status).toBe(201);
    expect((await fam.get('/api/notes')).body[0]).toMatchObject({ author: 'Ravi', text: 'Proud of you!' });
  });
  test('SOS emails every member plus the emergency contact', async () => {
    const c = await newCircle({ emergencyEmail: 'emergency@x.com' });
    const e = await login(c, 'elder');
    const r = await e.post('/api/sos');
    expect(r.body.notified).toBe(4);
    expect(outbox('SOS%').map((m) => m.to_addr).sort()).toEqual(['asha@x.com', 'care@x.com', 'emergency@x.com', 'fam@x.com']);
  });
  test('demo-mode outbox is visible to elder/caretaker but not family; test digest sends', async () => {
    const c = await newCircle();
    const e = await login(c, 'elder');
    const fam = await login(c, 'family');
    await e.post('/api/digest/test');
    const box = (await e.get('/api/outbox')).body;
    expect(box.length).toBe(3);
    expect(box[0].mode).toBe('demo');
    expect((await fam.get('/api/outbox')).status).toBe(403);
  });
  test('export returns a doctor-visit summary', async () => {
    const c = await newCircle();
    const e = await login(c, 'elder');
    await e.post('/api/meds').send(med());
    const r = await e.get('/api/export');
    expect(r.body.patient.name).toBe('Asha');
    expect(r.body.medications).toHaveLength(1);
  });
});

describe('scheduler & email reminders', () => {
  async function circleWithMed() {
    const c = await newCircle();
    const e = await login(c, 'elder');
    await e.post('/api/meds').send(med());
    return c;
  }
  test('upcoming-dose reminder is sent once (idempotent)', async () => {
    await circleWithMed();
    now = new Date('2026-11-16T07:50:00');
    await svc.runOnce(db, mailer, now);
    await svc.runOnce(db, mailer, now);
    expect(outbox('Reminder:%')).toHaveLength(1);
    expect(outbox('Reminder:%')[0].to_addr).toBe('asha@x.com');
  });
  test('missed dose escalates elder (30 min) then caretaker + family (60 min)', async () => {
    await circleWithMed();
    now = new Date('2026-11-16T08:31:00');
    await svc.runOnce(db, mailer, now);
    expect(outbox('Missed dose%').map((m) => m.to_addr)).toEqual(['asha@x.com']);
    expect(outbox('ALERT%')).toHaveLength(0);
    expect(db.prepare("SELECT status FROM doses WHERE date='2026-11-16'").get().status).toBe('missed');
    now = new Date('2026-11-16T09:05:00');
    await svc.runOnce(db, mailer, now);
    await svc.runOnce(db, mailer, now);
    expect(outbox('ALERT%').map((m) => m.to_addr).sort()).toEqual(['care@x.com', 'fam@x.com']);
    expect(outbox('Missed dose%')).toHaveLength(1);
  });
  test('no escalation once the dose is confirmed', async () => {
    await circleWithMed();
    db.prepare("UPDATE doses SET status='taken'").run();
    now = new Date('2026-11-16T09:30:00');
    await svc.runOnce(db, mailer, now);
    expect(outbox('%missed%')).toHaveLength(0);
    expect(outbox('Missed%')).toHaveLength(0);
  });
  test('appointment reminders: 24h then 2h, each once', async () => {
    const c = await newCircle();
    const e = await login(c, 'elder');
    await e.post('/api/appointments').send({ doctor: 'Dr Z', at: '2026-11-17T07:30' });
    await svc.runOnce(db, mailer, now);
    await svc.runOnce(db, mailer, now);
    expect(outbox('Tomorrow:%')).toHaveLength(3);
    now = new Date('2026-11-17T06:00:00');
    await svc.runOnce(db, mailer, now);
    await svc.runOnce(db, mailer, now);
    expect(outbox('In 2 hours:%')).toHaveLength(3);
  });
  test('refill warning emailed to elder and caretaker once per day', async () => {
    const c = await newCircle();
    const e = await login(c, 'elder');
    await e.post('/api/meds').send(med({ pill_count: 3 }));
    await svc.runOnce(db, mailer, now);
    await svc.runOnce(db, mailer, now);
    expect(outbox('Refill soon%').map((m) => m.to_addr).sort()).toEqual(['asha@x.com', 'care@x.com']);
  });
  test('seeded demo circle works end-to-end with documented credentials', async () => {
    seedDemo(db, { rounds: 4, now });
    const r = await request(app).post('/api/join').set(H).send({ circleId: 'demo2026', passcode: 'elder-2026', name: 'Ramesh' });
    expect(r.status).toBe(200);
    const a = request.agent(app).set(H);
    await a.post('/api/join').send({ circleId: 'DEMO2026', passcode: 'CARER-2026', name: 'Priya' });
    expect((await a.get('/api/meds')).body).toHaveLength(4);
    expect((await a.get('/api/adherence?days=14')).body.overall).toBeGreaterThan(70);
    expect((await a.get('/api/appointments?upcoming=1')).body).toHaveLength(2);
  });
});

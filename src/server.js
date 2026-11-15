const cron = require('node-cron');
const { openDb } = require('./db');
const { createMailer } = require('./mail');
const { createApp } = require('./app');
const { seedDemo } = require('./seed');
const { runOnce, sendDigest } = require('./services');

const env = process.env;
const db = openDb(env.DB_PATH || './data/carecircle.db');
const mailer = createMailer(db, env);
if (env.SEED_DEMO !== 'false') seedDemo(db, { rounds: Number(env.BCRYPT_ROUNDS || 10) });
if (env.NODE_ENV === 'production' && !env.JWT_SECRET) console.warn('JWT_SECRET not set: sessions reset on every restart.');

cron.schedule('* * * * *', () => runOnce(db, mailer).catch((e) => console.error('scheduler', e)));
cron.schedule('0 9 * * 0', async () => {
  for (const c of db.prepare('SELECT id FROM circles').all()) await sendDigest(db, mailer, c.id).catch((e) => console.error('digest', e));
});

const port = Number(env.PORT || 8080);
createApp({ db, mailer, env }).listen(port, () => console.log(`CareCircle running on :${port} (email mode: ${mailer.mode})`));

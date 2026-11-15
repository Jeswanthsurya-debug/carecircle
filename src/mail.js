const nodemailer = require('nodemailer');
const { stamp } = require('./time');

/**
 * Mailer with DEMO MODE: without SMTP_HOST every email is stored in the outbox table
 * (shown in the "Sent Emails" screen) and logged. With SMTP it also sends for real.
 */
function createMailer(db, env = process.env) {
  const live = Boolean(env.SMTP_HOST);
  const port = Number(env.SMTP_PORT || 587);
  const transport = live
    ? nodemailer.createTransport({
        host: env.SMTP_HOST,
        port,
        secure: port === 465,
        auth: env.SMTP_USER ? { user: env.SMTP_USER, pass: env.SMTP_PASS } : undefined,
      })
    : null;
  const insert = db.prepare('INSERT INTO outbox(circle_id,to_addr,subject,body,mode,at) VALUES(?,?,?,?,?,?)');
  return {
    mode: live ? 'smtp' : 'demo',
    /** @returns {Promise<number>} number of recipients */
    async send({ circleId, to, subject, text }) {
      const list = [...new Set(to)].filter(Boolean);
      if (!list.length) return 0;
      const now = stamp(new Date());
      for (const addr of list) insert.run(circleId, addr, subject, text, live ? 'smtp' : 'demo', now);
      if (transport) {
        try {
          await transport.sendMail({ from: env.MAIL_FROM, to: list.join(','), subject, text });
        } catch (e) {
          console.error('Email delivery failed:', e.message);
        }
      } else console.log(`[DEMO EMAIL] to=${list.join(',')} | ${subject}`);
      return list.length;
    },
  };
}
module.exports = { createMailer };

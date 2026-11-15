/* CareCircle front-end. Vanilla ES modules; user data is only ever inserted via textContent (no innerHTML). */
const NS = 'http://www.w3.org/2000/svg';
const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
let prefs = {};
try { prefs = JSON.parse(localStorage.getItem('cc_prefs') || '{}'); } catch { prefs = {}; }
let me = null;
let current = 'today';

/** Create an element: h('div', {class:'x', onclick:fn}, child, 'text') */
function h(tag, props = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (k === 'class') e.className = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (v === true) e.setAttribute(k, '');
    else if (v !== false && v != null) e.setAttribute(k, v);
  }
  for (const c of kids.flat(2)) if (c != null && c !== false) e.append(c.nodeType ? c : document.createTextNode(String(c)));
  return e;
}
const $ = (s, r = document) => r.querySelector(s);
const root = () => $('#app');

function applyPrefs() {
  const r = document.documentElement;
  r.dataset.theme = prefs.theme || 'dark';
  r.dataset.fs = prefs.fs || 'md';
  r.dataset.simple = prefs.simple ? '1' : '0';
  try { localStorage.setItem('cc_prefs', JSON.stringify(prefs)); } catch { /* storage unavailable */ }
}

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch('/api' + path, {
    method, credentials: 'same-origin', body: body ? JSON.stringify(body) : undefined,
    headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'CareCircle' },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const e = new Error(data.error || 'Something went wrong');
    e.fields = data.fields; e.status = res.status;
    throw e;
  }
  return data;
}

function toast(msg, bad) {
  const t = h('div', { class: 'toast' + (bad ? ' err' : '') }, (bad ? 'Problem: ' : 'Done: ') + msg);
  $('#toasts').append(t);
  setTimeout(() => t.remove(), 4500);
}
const guard = (fn) => async (...a) => { try { await fn(...a); } catch (e) { toast(e.message, true); } };

function burst(el) {
  if (reduced) return;
  const r = el.getBoundingClientRect();
  const colors = ['#2DD4BF', '#8B5CF6', '#38BDF8', '#FDE047', '#F472B6'];
  for (let i = 0; i < 22; i++) {
    const p = h('i', { class: 'conf' });
    p.style.left = r.left + r.width / 2 + 'px'; p.style.top = r.top + r.height / 2 + 'px'; p.style.background = colors[i % 5];
    document.body.append(p);
    const a = Math.random() * Math.PI * 2, d = 60 + Math.random() * 90;
    p.animate([{ transform: 'translate(0,0) scale(1)', opacity: 1 }, { transform: `translate(${Math.cos(a) * d}px,${Math.sin(a) * d + 40}px) rotate(${Math.random() * 540}deg) scale(.4)`, opacity: 0 }],
      { duration: 900 + Math.random() * 400, easing: 'cubic-bezier(.2,.8,.2,1)' }).onfinish = () => p.remove();
  }
}
function countUp(el, to, suffix = '') {
  if (reduced || to == null) { el.textContent = (to ?? '-') + (to == null ? '' : suffix); return; }
  const t0 = performance.now();
  const step = (t) => { const k = Math.min(1, (t - t0) / 900); el.textContent = Math.round(to * k) + suffix; if (k < 1) requestAnimationFrame(step); };
  requestAnimationFrame(step);
}
let gid = 0;
function ring(pct, label, sub) {
  const id = 'rg' + gid++, C = 276.46;
  const wrap = h('div', { class: 'ring', role: 'img', 'aria-label': `${label}: ${pct == null ? 'no data yet' : pct + ' percent'}` });
  const svg = document.createElementNS(NS, 'svg'); svg.setAttribute('viewBox', '0 0 100 100'); svg.setAttribute('aria-hidden', 'true');
  svg.innerHTML = `<defs><linearGradient id="${id}"><stop offset="0" stop-color="#2DD4BF"/><stop offset="1" stop-color="#8B5CF6"/></linearGradient></defs><circle class="bg" cx="50" cy="50" r="44" fill="none" stroke-width="9"/><circle class="fg" cx="50" cy="50" r="44" fill="none" stroke-width="9" stroke="url(#${id})" stroke-dasharray="${C}" stroke-dashoffset="${C}"/>`;
  const num = h('div', { class: 'num' }, h('span'), h('small', {}, sub || label));
  wrap.append(svg, num);
  requestAnimationFrame(() => requestAnimationFrame(() => { svg.querySelector('.fg').style.strokeDashoffset = String(C * (1 - (pct || 0) / 100)); }));
  countUp(num.firstChild, pct, pct == null ? '' : '%');
  if (pct == null) num.firstChild.textContent = '-';
  return wrap;
}
const card = (...k) => h('div', { class: 'card' }, ...k);
const stagger = (box) => [...box.children].forEach((c, i) => c.style.setProperty('--i', i));
const fmtDT = (s) => new Date(s).toLocaleString([], { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
const relative = (s) => {
  const m = Math.round((new Date(s) - Date.now()) / 60000);
  if (m < 0) return 'past';
  return m < 60 ? `in ${m} min` : m < 2880 ? `in ${Math.round(m / 60)} hours` : `in ${Math.round(m / 1440)} days`;
};

/* ---------- modal form with validation errors tied via aria-describedby ---------- */
function formDialog(title, fields, values, onSave, saveLabel = 'Save') {
  const dlg = h('dialog', { 'aria-labelledby': 'dlg-title' });
  const form = h('form', { novalidate: true });
  const errEls = {};
  const getters = {};
  fields.forEach((f) => {
    const id = 'f_' + f.name, v = values?.[f.name] ?? f.default ?? '';
    let input;
    if (f.type === 'select') input = h('select', { id }, f.options.map((o) => h('option', { value: o, selected: o === v }, o)));
    else if (f.type === 'textarea') { input = h('textarea', { id, rows: 3 }); input.value = v; }
    else if (f.type === 'days') {
      input = h('fieldset', { class: 'days', id }, ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((d, i) =>
        h('label', {}, h('input', { type: 'checkbox', value: i, checked: (Array.isArray(v) ? v : [0, 1, 2, 3, 4, 5, 6]).includes(i) }), d)));
      getters[f.name] = () => [...input.querySelectorAll('input:checked')].map((c) => Number(c.value));
    } else { input = h('input', { id, type: f.type || 'text', placeholder: f.placeholder || '' }); input.value = v; }
    if (!getters[f.name]) getters[f.name] = () => { const x = input.value.trim(); return f.type === 'number' ? (x === '' ? 0 : Number(x)) : f.list ? x.split(/[ ,]+/).filter(Boolean) : x === '' && f.nullable ? null : x; };
    const err = h('p', { class: 'err', id: id + '_e' });
    errEls[f.name] = [input, err];
    input.setAttribute('aria-describedby', id + '_e');
    form.append(f.type === 'days' ? h('div', {}, h('label', { for: id }, f.label), input, err) : h('div', {}, h('label', { for: id }, f.label + (f.required ? ' *' : '')), input, err));
  });
  const summary = h('p', { class: 'err', role: 'alert' });
  form.append(summary, h('div', { class: 'row', style: null }, h('button', { class: 'btn primary', type: 'submit' }, saveLabel), h('button', { class: 'btn', type: 'button', onclick: () => dlg.close() }, 'Cancel')));
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    Object.values(errEls).forEach(([i, p]) => { p.textContent = ''; i.removeAttribute('aria-invalid'); });
    summary.textContent = '';
    const data = {};
    fields.forEach((f) => { data[f.name] = getters[f.name](); });
    try { await onSave(data); dlg.close(); } catch (err) {
      summary.textContent = err.message;
      for (const [k, msg] of Object.entries(err.fields || {})) {
        const [name] = k.split('.'); const pair = errEls[name];
        if (pair) { pair[1].textContent = `${fields.find((f) => f.name === name).label}: ${msg}`; pair[0].setAttribute('aria-invalid', 'true'); }
      }
    }
  });
  dlg.append(h('h2', { id: 'dlg-title' }, title), form);
  dlg.addEventListener('close', () => dlg.remove());
  document.body.append(dlg);
  dlg.showModal(); // native focus trapping + Esc to close
  return dlg;
}
function infoDialog(title, ...body) {
  const dlg = h('dialog', { 'aria-labelledby': 'dlg-title' }, h('h2', { id: 'dlg-title' }, title), ...body, h('p', {}, h('button', { class: 'btn primary', onclick: () => dlg.close() }, 'Close')));
  dlg.addEventListener('close', () => dlg.remove());
  document.body.append(dlg); dlg.showModal();
}
const copyBtn = (text) => h('button', { class: 'btn small', type: 'button', onclick: () => navigator.clipboard?.writeText(text).then(() => toast('Copied')) }, 'Copy');

/* ---------- voice ---------- */
function speak(text) {
  if (!('speechSynthesis' in window)) return toast('Voice reading is not supported on this browser', true);
  speechSynthesis.cancel(); speechSynthesis.speak(new SpeechSynthesisUtterance(text));
}
function listen(cb) {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) return toast('Voice commands are not supported here. Use the buttons instead.', true);
  const r = new SR(); r.lang = 'en-IN';
  r.onresult = (e) => cb(e.results[0][0].transcript.toLowerCase());
  r.onerror = () => toast('Could not hear you. Please try again.', true);
  r.start(); toast('Listening... say "I took my morning pills"');
}

/* ---------- views ---------- */
const canWrite = () => me.role !== 'family';
const isElder = () => me.role === 'elder';
const statusBadge = (d) => d.status === 'taken' ? h('span', { class: 'badge ok' }, '✔ Taken ' + (d.at ? d.at.slice(11) : '') + (d.by_name ? ' by ' + d.by_name : ''))
  : d.status === 'missed' ? h('span', { class: 'badge bad' }, '⚠ Missed - please take it now')
  : d.status === 'skipped' ? h('span', { class: 'badge warn' }, '↷ Skipped') : h('span', { class: 'badge' }, '⏳ Due ' + d.time);

async function viewToday() {
  const [t, ap, pend] = await Promise.all([api('/today'), api('/appointments?upcoming=1'), canWrite() ? api('/pending') : []]);
  const done = t.doses.filter((d) => d.status === 'taken').length;
  const pct = t.doses.length ? Math.round((done / t.doses.length) * 100) : null;
  const next = t.doses.find((d) => d.status === 'pending' || d.status === 'missed');
  const box = h('div', { class: 'page' });
  box.append(h('h1', { tabindex: '-1', id: 'view-h' }, `Hello ${me.circle.elderName}'s circle`));
  if (isElder() && pend.length) box.append(card(h('h2', {}, `${pend.length} change(s) waiting for your approval`), h('button', { class: 'btn primary', onclick: () => show('circle') }, 'Review now')));
  box.append(card(h('div', { class: 'row spread' }, h('div', {}, h('h2', {}, "Today's progress"), h('p', { class: 'muted' }, `${done} of ${t.doses.length} doses taken`)), ring(pct, "Today's doses", 'done')),
    h('div', { class: 'row noprint' },
      h('button', { class: 'btn', onclick: () => speak(t.doses.length ? 'Your schedule today. ' + t.doses.map((d) => `${d.name} ${d.dosage} at ${d.time}, ${d.status === 'taken' ? 'already taken' : 'not yet taken'}`).join('. ') : 'No medicines are scheduled today.') }, '🔊 Read my schedule'),
      canWrite() && h('button', { class: 'btn', onclick: () => listen(guard(async (txt) => {
        if (!/took|taken|had|finished/.test(txt)) return toast('I heard: "' + txt + '". Say "I took my morning pills".', true);
        const inRange = (d) => /morning/.test(txt) ? d.time < '12:00' : /afternoon/.test(txt) ? d.time >= '12:00' && d.time < '17:00' : /evening|night/.test(txt) ? d.time >= '17:00' : true;
        const todo = t.doses.filter((d) => d.status !== 'taken' && inRange(d));
        for (const d of todo) await api('/doses/' + d.id, { method: 'POST', body: { action: 'take' } });
        toast(`Marked ${todo.length} dose(s) as taken`); show('today');
      })) }, '🎤 Voice command'))));
  if (!t.doses.length) box.append(card(h('p', {}, 'No medicines scheduled today. Add one in the Medicines tab.')));
  t.doses.forEach((d) => {
    const act = guard(async (action, btn) => { await api('/doses/' + d.id, { method: 'POST', body: { action } }); if (action === 'take') burst(btn); toast(action === 'take' ? `${d.name} marked as taken` : `${d.name}: ${action}`); setTimeout(() => show('today'), action === 'take' ? 700 : 0); });
    box.append(h('div', { class: 'card dose' + (next && next.id === d.id ? ' next' : '') },
      h('div', { class: 'time' }, d.time),
      h('div', { style: null }, h('h3', {}, `${d.name} ${d.dosage}`), h('p', { class: 'muted hide-simple' }, [d.form, d.instructions].filter(Boolean).join(' · ')), statusBadge(d)),
      canWrite() && d.status !== 'taken' ? h('div', { class: 'row' },
        h('button', { class: 'btn primary', onclick: (e) => act('take', e.currentTarget) }, '✔ Take'),
        h('button', { class: 'btn hide-simple', onclick: (e) => act('skip', e.currentTarget) }, 'Skip'),
        h('button', { class: 'btn hide-simple', onclick: (e) => act('snooze', e.currentTarget) }, '⏰ +15 min')) : null));
  });
  if (ap[0]) box.append(card(h('h2', {}, 'Next appointment'), h('p', {}, `${ap[0].doctor}${ap[0].specialty ? ' (' + ap[0].specialty + ')' : ''} - ${fmtDT(ap[0].at)}`), h('span', { class: 'badge' }, '🗓 ' + relative(ap[0].at))));
  return box;
}

const MED_FIELDS = [
  { name: 'name', label: 'Medicine name', required: true }, { name: 'dosage', label: 'Dosage (e.g. 500 mg)' },
  { name: 'form', label: 'Form', type: 'select', options: ['tablet', 'capsule', 'syrup', 'injection', 'drops', 'other'] },
  { name: 'times', label: 'Times per day (24h, comma separated)', placeholder: '08:00, 20:00', list: true, required: true },
  { name: 'start_date', label: 'Start date', type: 'date', required: true }, { name: 'end_date', label: 'End date (optional)', type: 'date', nullable: true },
  { name: 'days', label: 'Days of the week', type: 'days' }, { name: 'instructions', label: 'Instructions (e.g. with food)' },
  { name: 'pill_count', label: 'Pills left', type: 'number' }, { name: 'refill_threshold', label: 'Warn me when pills left is at most', type: 'number', default: 5 },
];
async function viewMeds() {
  const [meds, refills, safety] = await Promise.all([api('/meds'), api('/refills'), api('/safety')]);
  const box = h('div', { class: 'page' }, h('h1', { tabindex: '-1', id: 'view-h' }, 'Medicines'));
  const after = (r) => { toast(r.pending ? 'Sent to the elder for approval' : 'Saved'); show('meds'); };
  if (canWrite()) box.append(h('p', {}, h('button', { class: 'btn primary', onclick: () => formDialog('Add medicine', MED_FIELDS, { start_date: new Date().toLocaleDateString('en-CA'), times: '08:00' }, async (d) => after(await api('/meds', { method: 'POST', body: d }))) }, '+ Add medicine')));
  if (safety.warnings.length) box.append(card(h('h2', {}, '⚠ Safety notes'), h('ul', { class: 'plain' }, safety.warnings.map((w) => h('li', {}, w))), h('p', { class: 'muted' }, safety.disclaimer)));
  meds.forEach((m) => {
    const rf = refills.find((r) => r.id === m.id);
    box.append(card(h('div', { class: 'row spread' }, h('h2', {}, `${m.name} ${m.dosage}`), rf?.low ? h('span', { class: 'badge bad' }, `⚠ ~${rf.daysLeft} days of pills left`) : h('span', { class: 'badge ok' }, `${m.pill_count} pills left`)),
      h('p', { class: 'muted' }, `${m.form} · ${m.times.join(', ')} · ${m.days.length === 7 ? 'every day' : m.days.length + ' days/week'}${m.instructions ? ' · ' + m.instructions : ''}`),
      canWrite() && h('div', { class: 'row' },
        h('button', { class: 'btn small', onclick: () => formDialog('Edit ' + m.name, MED_FIELDS, { ...m, times: m.times.join(', ') }, async (d) => after(await api('/meds/' + m.id, { method: 'PUT', body: d }))) }, 'Edit'),
        h('button', { class: 'btn small danger', onclick: guard(async () => { if (confirm(`Delete ${m.name}?`)) after(await api('/meds/' + m.id, { method: 'DELETE' })); }) }, 'Delete'))));
  });
  if (!meds.length) box.append(card(h('p', {}, 'No medicines yet.')));
  return box;
}

const APPT_FIELDS = [
  { name: 'doctor', label: 'Doctor', required: true }, { name: 'specialty', label: 'Specialty' }, { name: 'location', label: 'Location' },
  { name: 'at', label: 'Date and time', type: 'datetime-local', required: true }, { name: 'notes', label: 'Notes', type: 'textarea' },
  { name: 'status', label: 'Status', type: 'select', options: ['scheduled', 'completed', 'cancelled'] },
];
async function viewAppts() {
  const list = await api('/appointments');
  const box = h('div', { class: 'page' }, h('h1', { tabindex: '-1', id: 'view-h' }, 'Appointments'));
  const after = (r) => { toast(r.pending ? 'Sent to the elder for approval' : 'Saved'); show('appts'); };
  if (canWrite()) box.append(h('p', {}, h('button', { class: 'btn primary', onclick: () => formDialog('Add appointment', APPT_FIELDS, {}, async (d) => after(await api('/appointments', { method: 'POST', body: d }))) }, '+ Add appointment')));
  list.forEach((a) => box.append(card(h('div', { class: 'row spread' }, h('h2', {}, `${a.doctor}${a.specialty ? ' · ' + a.specialty : ''}`), h('span', { class: 'badge' }, a.status === 'scheduled' ? '🗓 ' + relative(a.at) : a.status)),
    h('p', {}, fmtDT(a.at) + (a.location ? ' · ' + a.location : '')), a.notes && h('p', { class: 'muted' }, a.notes),
    h('div', { class: 'row' }, h('a', { class: 'btn small', href: `/api/appointments/${a.id}/ics`, download: 'appointment.ics' }, '📅 Add to calendar'),
      canWrite() && h('button', { class: 'btn small', onclick: () => formDialog('Edit appointment', APPT_FIELDS, a, async (d) => after(await api('/appointments/' + a.id, { method: 'PUT', body: d }))) }, 'Edit'),
      canWrite() && h('button', { class: 'btn small danger', onclick: guard(async () => { if (confirm('Delete this appointment?')) after(await api('/appointments/' + a.id, { method: 'DELETE' })); }) }, 'Delete')))));
  if (!list.length) box.append(card(h('p', {}, 'No appointments yet.')));
  return box;
}

async function viewProgress() {
  const [w, m] = await Promise.all([api('/adherence?days=7'), api('/adherence?days=30')]);
  const box = h('div', { class: 'page' }, h('h1', { tabindex: '-1', id: 'view-h' }, 'Adherence'));
  const streak = h('p', { class: 'mood' }); countUp(streak, m.streak, ' 🔥');
  box.append(h('div', { class: 'grid' }, card(h('h2', {}, 'Last 7 days'), ring(w.overall, '7 day adherence', 'week')), card(h('h2', {}, 'Last 30 days'), ring(m.overall, '30 day adherence', 'month')), card(h('h2', {}, 'Day streak'), streak, h('p', { class: 'muted' }, 'Days in a row with every dose taken'))));
  const bars = h('div', { class: 'bars', role: 'img', 'aria-label': 'Daily adherence for the last 30 days' });
  m.days.forEach((d, i) => { const b = h('span', { title: `${d.date}: ${d.pct ?? 'no doses'}%` }); b.style.height = Math.max(3, d.pct ?? 0) + '%'; b.style.setProperty('--i', i); bars.append(b); });
  box.append(card(h('h2', {}, '30 day chart'), bars));
  const lvl = (p) => p == null ? 0 : p < 50 ? 1 : p < 100 ? 2 : 3 + (p === 100 ? 1 : 0);
  const sym = (p) => p == null ? '·' : p === 100 ? '✔' : p < 50 ? '✖' : '◐';
  box.append(card(h('h2', {}, 'Heatmap calendar'), h('div', { class: 'heat' }, m.days.map((d) => h('div', { class: 'l' + lvl(d.pct), title: `${d.date}: ${d.pct ?? 'no doses'}%` }, h('span', { 'aria-hidden': 'true' }, sym(d.pct)), h('span', { class: 'sr', style: null }, `${d.date} ${d.pct ?? 'none'}`)))),
    h('p', { class: 'muted' }, '✔ all taken · ◐ partly · ✖ mostly missed · · no doses')));
  return box;
}

async function viewCare() {
  const [checks, notes] = await Promise.all([api('/checkins'), api('/notes')]);
  const box = h('div', { class: 'page' }, h('h1', { tabindex: '-1', id: 'view-h' }, 'Care & wellbeing'));
  const faces = ['😞', '😕', '😐', '🙂', '😄'];
  if (isElder()) box.append(card(h('h2', {}, 'How are you today?'), h('div', { class: 'row' }, faces.map((f, i) => h('button', { class: 'btn mood', 'aria-label': `Mood ${i + 1} of 5`, onclick: () => formDialog('Daily check-in ' + f, [{ name: 'pain', label: 'Pain level (0 none - 10 severe)', type: 'number', default: 0 }, { name: 'note', label: 'Anything to share?' }], {}, async (d) => { await api('/checkin', { method: 'POST', body: { ...d, mood: i + 1 } }); toast('Check-in saved'); show('care'); }, 'Save check-in') }, f)))));
  box.append(card(h('h2', {}, 'Wellness trend (last 14 check-ins)'), checks.length ? h('ul', { class: 'plain' }, checks.map((c) => h('li', {}, `${c.date}  ${faces[c.mood - 1]}  pain ${c.pain}/10${c.note ? ' - ' + c.note : ''}`))) : h('p', { class: 'muted' }, 'No check-ins yet.')));
  box.append(card(h('h2', {}, 'Family notes'), h('form', { onsubmit: guard(async (e) => { e.preventDefault(); const i = e.target.elements.text; await api('/notes', { method: 'POST', body: { text: i.value } }); show('care'); }) },
    h('label', { for: 'note-text' }, 'Write an encouraging message'), h('input', { id: 'note-text', name: 'text', maxlength: '300', required: true }), h('p', {}, h('button', { class: 'btn primary', type: 'submit' }, 'Post note'))),
    h('ul', { class: 'plain' }, notes.map((n) => h('li', {}, h('strong', {}, n.author), ` (${n.role}): ${n.text}`)))));
  if (canWrite()) box.append(card(h('h2', {}, 'Emergency'), h('p', { class: 'muted' }, `Emergency contact: ${me.circle.emergencyName || 'not set'} ${me.circle.emergencyPhone}`), h('button', { class: 'btn sos', onclick: guard(async () => { if (confirm('Send an SOS email to everyone in the circle?')) { const r = await api('/sos', { method: 'POST' }); toast(`SOS sent to ${r.notified} contact(s)`); } }) }, '🚨 SOS - alert everyone')));
  return box;
}

async function viewCircle() {
  const box = h('div', { class: 'page' }, h('h1', { tabindex: '-1', id: 'view-h' }, 'Circle & settings'));
  const [pend, out] = await Promise.all([canWrite() ? api('/pending') : [], canWrite() ? api('/outbox') : []]);
  if (isElder()) {
    const sw = h('input', { type: 'checkbox', id: 'appr', checked: me.circle.requireApproval, onchange: guard(async (e) => { await api('/settings', { method: 'PUT', body: { requireApproval: e.target.checked } }); me.circle.requireApproval = e.target.checked; toast('Setting saved'); }) });
    box.append(card(h('h2', {}, 'You decide'), h('label', { class: 'row', for: 'appr' }, sw, 'Require my approval for caretaker changes')));
  }
  if (canWrite()) box.append(card(h('h2', {}, `Pending approvals (${pend.length})`), pend.length ? h('ul', { class: 'plain' }, pend.map((p) => h('li', {}, h('p', {}, h('strong', {}, p.by_name), ` wants to: ${p.type} ${p.payload.name || p.payload.doctor || ''}`),
    isElder() ? h('div', { class: 'row' }, h('button', { class: 'btn primary', onclick: guard(async () => { await api(`/pending/${p.id}/approve`, { method: 'POST' }); toast('Approved'); show('circle'); }) }, '✔ Approve'), h('button', { class: 'btn danger', onclick: guard(async () => { await api(`/pending/${p.id}/reject`, { method: 'POST' }); toast('Rejected'); show('circle'); }) }, '✖ Reject')) : h('p', { class: 'muted' }, 'Waiting for the elder.')))) : h('p', { class: 'muted' }, 'Nothing waiting.')));
  if (isElder()) {
    box.append(card(h('h2', {}, 'Passcodes'), h('p', { class: 'muted' }, `Circle code: ${me.circle.id}. Regenerating a passcode instantly locks out the old one.`), h('div', { class: 'row' }, ['elder', 'caretaker', 'family'].map((r) =>
      h('button', { class: 'btn small', onclick: guard(async () => { if (!confirm(`Regenerate the ${r} passcode?`)) return; const x = await api(`/passcodes/${r}/regenerate`, { method: 'POST' }); infoDialog(`New ${r} passcode`, h('p', {}, h('span', { class: 'pc' }, x.passcode), ' ', copyBtn(x.passcode)), h('p', { class: 'muted' }, x.note)); }) }, `New ${r} passcode`)))));
    const by = (r) => me.contacts.find((c) => c.role === r)?.email || '';
    const form = h('form', { onsubmit: guard(async (e) => { e.preventDefault(); const contacts = ['elder', 'caretaker', 'family'].map((r) => ({ role: r, name: r, email: e.target.elements[r].value.trim() })).filter((c) => c.email); await api('/contacts', { method: 'PUT', body: { contacts } }); me.contacts = contacts; toast('Email contacts saved'); }) });
    ['elder', 'caretaker', 'family'].forEach((r) => { const i = h('input', { id: 'c_' + r, name: r, type: 'email' }); i.value = by(r); form.append(h('label', { for: 'c_' + r }, `${r[0].toUpperCase() + r.slice(1)} email`), i); });
    form.append(h('p', {}, h('button', { class: 'btn primary', type: 'submit' }, 'Save email contacts')));
    box.append(card(h('h2', {}, 'Email reminders go to'), form));
  }
  if (canWrite()) box.append(card(h('h2', {}, `Sent emails (${me.mailMode === 'demo' ? 'demo mode: stored here' : 'delivered by SMTP'})`),
    h('p', {}, h('button', { class: 'btn small', onclick: guard(async () => { const r = await api('/digest/test', { method: 'POST' }); toast(`Digest sent to ${r.notified} contact(s)`); show('circle'); }) }, 'Send test digest now')),
    out.length ? h('ul', { class: 'plain' }, out.slice(0, 15).map((o) => h('li', {}, h('strong', {}, o.subject), h('br'), h('span', { class: 'muted' }, `${o.at.replace('T', ' ')} → ${o.to_addr}`)))) : h('p', { class: 'muted' }, 'No emails yet. Reminders appear here as they are triggered.')));
  if (isElder()) { const log = await api('/activity'); box.append(card(h('h2', {}, 'Activity log'), h('ul', { class: 'plain' }, log.slice(0, 20).map((l) => h('li', {}, `${l.at.replace('T', ' ')} - ${l.actor} (${l.role}): ${l.action}`))))); }
  box.append(card(h('h2', {}, 'Doctor visit summary'), h('div', { class: 'row noprint' }, h('button', { class: 'btn', onclick: () => window.print() }, '🖨 Print summary'), h('a', { class: 'btn', href: '/api/export', download: 'health-summary.json' }, '⬇ Export JSON')),
    h('p', { class: 'muted' }, `${me.circle.elderName}, age ${me.circle.age}. Printing this page includes medicines, appointments and adherence.`)));
  return box;
}

/* ---------- shell ---------- */
const NAV = [['today', '🏠', 'Today'], ['meds', '💊', 'Medicines'], ['appts', '🗓', 'Appointments'], ['progress', '📈', 'Progress'], ['care', '💬', 'Care'], ['circle', '⚙️', 'Circle']];
const VIEWS = { today: viewToday, meds: viewMeds, appts: viewAppts, progress: viewProgress, care: viewCare, circle: viewCircle };

function renderShell() {
  const nav = h('nav', { 'aria-label': 'Main' }, h('ul', {}, NAV.map(([k, ic, label]) => h('li', { 'data-simple': k === 'today' ? '' : 'x' }, h('button', { 'data-k': k, onclick: () => show(k) }, h('span', { 'aria-hidden': 'true' }, ic), label)))));
  const cycle = (key, opts) => () => { prefs[key] = opts[(opts.indexOf(prefs[key] || opts[0]) + 1) % opts.length]; applyPrefs(); toast(`${key === 'theme' ? 'Theme' : 'Text size'}: ${prefs[key]}`); };
  const tools = h('div', { class: 'tools' },
    h('button', { class: 'btn small', onclick: cycle('theme', ['dark', 'light', 'contrast']), 'aria-label': 'Change theme: dark, light or high contrast' }, '🎨 Theme'),
    h('button', { class: 'btn small', onclick: () => { prefs.fs = 'sm'; applyPrefs(); }, 'aria-label': 'Smaller text' }, 'A-'), h('button', { class: 'btn small', onclick: () => { prefs.fs = 'md'; applyPrefs(); }, 'aria-label': 'Normal text' }, 'A'), h('button', { class: 'btn small', onclick: () => { prefs.fs = 'lg'; applyPrefs(); }, 'aria-label': 'Larger text' }, 'A+'),
    h('button', { class: 'btn small', 'aria-pressed': String(!!prefs.simple), onclick: (e) => { prefs.simple = !prefs.simple; applyPrefs(); e.currentTarget.setAttribute('aria-pressed', String(!!prefs.simple)); syncNav(); show(prefs.simple ? 'today' : current); } }, '👓 Simple mode'),
    h('button', { class: 'btn small', onclick: guard(async () => { await api('/logout', { method: 'POST' }); me = null; start(); }) }, 'Sign out'));
  root().replaceChildren(h('div', { class: 'shell' },
    h('header', { class: 'side', role: 'banner' }, h('div', {}, h('div', { class: 'brand' }, 'CareCircle'), h('p', { class: 'muted who' }, `${me.name} · ${me.role}`)), nav),
    h('div', { class: 'content' }, h('div', { class: 'topbar' }, h('p', { class: 'muted' }, `${me.circle.elderName}, ${me.circle.age} · signed in as ${me.name} (${me.role})`), tools), h('main', { id: 'main' }))));
  syncNav();
}
function syncNav() { document.querySelectorAll('nav li').forEach((li) => { li.hidden = !!prefs.simple && li.dataset.simple === 'x'; }); }

async function show(name) {
  if (prefs.simple && name !== 'today') name = 'today';
  current = name;
  document.querySelectorAll('nav button').forEach((b) => (b.dataset.k === name ? b.setAttribute('aria-current', 'page') : b.removeAttribute('aria-current')));
  const main = $('#main');
  main.replaceChildren(h('div', { class: 'skel' }), h('div', { class: 'skel' }), h('div', { class: 'skel' }));
  try {
    const node = await VIEWS[name]();
    main.replaceChildren(node);
    stagger(node);
    $('#view-h')?.focus({ preventScroll: true });
  } catch (e) {
    if (e.status === 401) { me = null; return start(); }
    main.replaceChildren(card(h('p', { role: 'alert' }, e.message)));
  }
}

/* ---------- join / create ---------- */
function renderJoin() {
  const err = h('p', { class: 'err', role: 'alert' });
  const join = h('form', { onsubmit: async (e) => {
    e.preventDefault(); err.textContent = '';
    const f = e.target.elements;
    try { await api('/join', { method: 'POST', body: { circleId: f.circleId.value, passcode: f.passcode.value, name: f.name.value } }); start(); } catch (x) { err.textContent = x.message; }
  } },
    h('label', { for: 'circleId' }, 'Circle code'), h('input', { id: 'circleId', name: 'circleId', required: true, autocomplete: 'off' }),
    h('label', { for: 'passcode' }, 'Passcode'), h('input', { id: 'passcode', name: 'passcode', type: 'password', required: true, autocomplete: 'off' }),
    h('label', { for: 'jname' }, 'Your name'), h('input', { id: 'jname', name: 'name', required: true }), err,
    h('p', {}, h('button', { class: 'btn primary', type: 'submit' }, 'Join the circle')),
    h('p', { class: 'muted' }, 'Demo: circle DEMO2026 with passcode ELDER-2026, CARER-2026 or FAMILY-2026.'));
  const mk = (n, label, type = 'text') => [h('label', { for: n }, label), h('input', { id: n, name: n, type, required: n === 'elderName' || n === 'age' })];
  const cerr = h('p', { class: 'err', role: 'alert' });
  const create = h('form', { hidden: true, onsubmit: async (e) => {
    e.preventDefault(); cerr.textContent = '';
    const body = Object.fromEntries([...new FormData(e.target)].filter(([, v]) => v !== ''));
    try {
      const r = await api('/circles', { method: 'POST', body });
      infoDialog('Your Care Circle is ready', h('p', {}, 'Circle code: ', h('span', { class: 'pc' }, r.circleId), ' ', copyBtn(r.circleId)),
        ...['elder', 'caretaker', 'family'].map((k) => h('p', {}, `${k[0].toUpperCase() + k.slice(1)} passcode: `, h('span', { class: 'pc' }, r.passcodes[k]), ' ', copyBtn(r.passcodes[k]))), h('p', { class: 'err' }, r.note));
      tabs[0].click();
    } catch (x) { cerr.textContent = x.message + (x.fields ? ': ' + Object.entries(x.fields).map(([k, v]) => `${k} ${v}`).join(', ') : ''); }
  } },
    ...mk('elderName', "Elder's name"), ...mk('age', 'Age', 'number'), ...mk('elderEmail', "Elder's email", 'email'), ...mk('caretakerEmail', 'Caretaker email', 'email'), ...mk('familyEmail', 'Family email', 'email'),
    ...mk('emergencyName', 'Emergency contact name'), ...mk('emergencyPhone', 'Emergency contact phone', 'tel'), ...mk('emergencyEmail', 'Emergency contact email', 'email'), cerr,
    h('p', {}, h('button', { class: 'btn primary', type: 'submit' }, 'Create circle')));
  const tabs = [
    h('button', { class: 'btn', role: 'tab', 'aria-selected': 'true', onclick: (e) => sel(e, join, create) }, 'Join'),
    h('button', { class: 'btn', role: 'tab', 'aria-selected': 'false', onclick: (e) => sel(e, create, join) }, 'Create a circle'),
  ];
  function sel(e, show1, hide1) { tabs.forEach((t) => t.setAttribute('aria-selected', String(t === (e.currentTarget || e)))); show1.hidden = false; hide1.hidden = true; }
  root().replaceChildren(h('main', { id: 'main', class: 'join' }, h('div', { class: 'card' }, h('h1', { class: 'brand' }, 'CareCircle'),
    h('p', { class: 'muted' }, 'A shared, passcode-protected space for elders, caretakers and family. The elder always stays in control.'),
    h('div', { class: 'tabs', role: 'tablist' }, tabs), join, create),
    h('div', { class: 'tools' }, h('button', { class: 'btn small', onclick: () => { prefs.theme = { dark: 'light', light: 'contrast', contrast: 'dark' }[prefs.theme || 'dark']; applyPrefs(); } }, '🎨 Theme'))));
  stagger($('.join'));
}

async function start() {
  applyPrefs();
  try { me = await api('/me'); renderShell(); show(prefs.simple ? 'today' : current); } catch { me = null; renderJoin(); }
}
start();

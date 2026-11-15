/** Local-time helpers (dates are stored as local "YYYY-MM-DD" / "HH:mm"). */
const p = (n) => String(n).padStart(2, '0');
const ymd = (d) => `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
const hm = (d) => `${p(d.getHours())}:${p(d.getMinutes())}`;
const stamp = (d) => `${ymd(d)}T${hm(d)}`;
const at = (date, time = '00:00') => new Date(`${date}T${time}:00`);
const addDays = (d, n) => {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
};
const addMin = (d, n) => new Date(d.getTime() + n * 60000);
module.exports = { ymd, hm, stamp, at, addDays, addMin };

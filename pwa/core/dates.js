// Dates are plain "YYYY-MM-DD" strings, so time zones can never shift a day.
export const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
  'August', 'September', 'October', 'November', 'December'];
export const pad = (n) => String(n).padStart(2, '0');
export const ymd = (y, m, d) => `${y}-${pad(m)}-${pad(d)}`;

export function parts(s) {
  const [y, m, d] = s.split('-').map(Number);
  return { y, m, d };
}
export function isValidDate(y, m, d) {
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
}
export const daysInMonth = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();

export function addDays(s, n) {
  const { y, m, d } = parts(s);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return ymd(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate());
}
/** a - b, in days */
export function diffDays(a, b) {
  const pa = parts(a), pb = parts(b);
  return Math.round((Date.UTC(pa.y, pa.m - 1, pa.d) - Date.UTC(pb.y, pb.m - 1, pb.d)) / 86400000);
}
/** Monday = 0 ... Sunday = 6 */
export function weekday(s) {
  const { y, m, d } = parts(s);
  return (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7;
}
export function localToday(now = new Date()) {
  return ymd(now.getFullYear(), now.getMonth() + 1, now.getDate());
}
export const clampDate = (y, m, d) => ymd(y, m, Math.min(d, daysInMonth(y, m)));
export function addMonths(y, m, n) {
  const i = y * 12 + (m - 1) + n;
  return [Math.floor(i / 12), (i % 12) + 1];
}
export function monthRange(y, m) {
  return [ymd(y, m, 1), ymd(y, m, daysInMonth(y, m))];
}
export const monthLabel = (y, m) => `${MONTHS[m - 1]} ${y}`;
export function niceDate(s) {
  const { y, m, d } = parts(s);
  return `${pad(d)} ${MONTHS[m - 1].slice(0, 3)} ${y}`;
}
export function shortDate(s) {
  const { m, d } = parts(s);
  return `${pad(d)} ${MONTHS[m - 1].slice(0, 3)}`;
}

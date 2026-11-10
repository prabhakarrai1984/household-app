/** 1234567.5 -> ₹12,34,567.50 (Indian digit grouping) */
export function inr(amount) {
  const negative = amount < 0;
  const [whole, fraction] = Math.abs(amount).toFixed(2).split('.');
  let head = whole;
  if (whole.length > 3) {
    let rest = whole.slice(0, -3);
    const tail = whole.slice(-3);
    const groups = [];
    while (rest.length > 2) { groups.unshift(rest.slice(-2)); rest = rest.slice(0, -2); }
    if (rest) groups.unshift(rest);
    head = groups.join(',') + ',' + tail;
  }
  return `${negative ? '-' : ''}₹${head}.${fraction}`;
}
export const escapeHtml = (s) => String(s ?? '').replace(/[&<>"']/g,
  (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Grocery: read a bill into items, learn how fast each item is used, and plan next month's list.
// Everything is plain rules on this phone's own data. Estimates, not promises.
import { addDays, diffDays, isValidDate, niceDate, ymd } from './dates.js';

// ------------------------------------------------------------------ units

const UNIT_ALIASES = {
  kg: 'kg', kgs: 'kg', kilo: 'kg', kilos: 'kg', g: 'g', gm: 'g', gms: 'g', gram: 'g', grams: 'g',
  l: 'l', lt: 'l', ltr: 'l', ltrs: 'l', litre: 'l', litres: 'l', liter: 'l', liters: 'l', ml: 'ml',
  pc: 'pcs', pcs: 'pcs', piece: 'pcs', pieces: 'pcs', no: 'pcs', nos: 'pcs', pkt: 'pcs', pkts: 'pcs', packet: 'pcs', packets: 'pcs',
  dozen: 'doz', doz: 'doz',
};
const UNIT_WORDS = Object.keys(UNIT_ALIASES).sort((a, b) => b.length - a.length).join('|');
export const DISPLAY_UNITS = ['kg', 'g', 'l', 'ml', 'pcs'];

/** (2, 'kg') -> {qty: 2000, unit: 'g'}. Everything is stored in g, ml or pcs. */
export function toBase(qty, unit) {
  if (qty == null || !unit) return { qty: null, unit: null };
  switch (UNIT_ALIASES[String(unit).toLowerCase()] || unit) {
    case 'kg': return { qty: qty * 1000, unit: 'g' };
    case 'g': return { qty, unit: 'g' };
    case 'l': return { qty: qty * 1000, unit: 'ml' };
    case 'ml': return { qty, unit: 'ml' };
    case 'doz': return { qty: qty * 12, unit: 'pcs' };
    case 'pcs': return { qty, unit: 'pcs' };
    default: return { qty: null, unit: null };
  }
}
/** 5000 g -> {qty: 5, unit: 'kg'} for showing and editing */
export function fromBase(qty, unit) {
  if (qty == null) return { qty: null, unit: '' };
  if (unit === 'g' && qty >= 1000) return { qty: round(qty / 1000), unit: 'kg' };
  if (unit === 'ml' && qty >= 1000) return { qty: round(qty / 1000), unit: 'l' };
  return { qty: round(qty), unit: unit || '' };
}
const round = (n, d = 2) => Math.round(n * 10 ** d) / 10 ** d;
export function formatQty(qty, unit) {
  const d = fromBase(qty, unit);
  return d.qty == null ? '' : `${d.qty} ${d.unit === 'pcs' ? (d.qty === 1 ? 'pc' : 'pcs') : d.unit === 'l' ? 'L' : d.unit}`.trim();
}

// ------------------------------------------------------------------ item names

// Words that mean the same thing (English and Hindi). `use` is a rough per-person-per-day range in g, ml or pcs.
export const KNOWN_ITEMS = [
  { key: 'milk', label: 'Milk', words: ['milk', 'doodh', 'dudh'], use: { low: 150, high: 400, unit: 'ml' } },
  { key: 'curd', label: 'Curd', words: ['curd', 'dahi', 'yogurt', 'yoghurt'] },
  { key: 'paneer', label: 'Paneer', words: ['paneer'] },
  { key: 'butter', label: 'Butter', words: ['butter', 'makhan'] },
  { key: 'ghee', label: 'Ghee', words: ['ghee'] },
  { key: 'eggs', label: 'Eggs', words: ['egg', 'eggs', 'anda'] },
  { key: 'bread', label: 'Bread', words: ['bread', 'loaf'] },
  { key: 'atta', label: 'Atta', words: ['atta', 'aata', 'wheat flour'], use: { low: 120, high: 300, unit: 'g' } },
  { key: 'rice', label: 'Rice', words: ['rice', 'chawal', 'basmati'], use: { low: 80, high: 250, unit: 'g' } },
  { key: 'dal', label: 'Dal', words: ['dal', 'daal', 'toor', 'arhar', 'masoor', 'urad', 'moong'], use: { low: 30, high: 100, unit: 'g' } },
  { key: 'sugar', label: 'Sugar', words: ['sugar', 'cheeni', 'chini'], use: { low: 15, high: 40, unit: 'g' } },
  { key: 'salt', label: 'Salt', words: ['salt', 'namak'], use: { low: 3, high: 8, unit: 'g' } },
  { key: 'oil', label: 'Cooking oil', words: ['oil', 'tel'], use: { low: 20, high: 40, unit: 'ml' } },
  { key: 'tea', label: 'Tea', words: ['tea', 'chai'] },
  { key: 'coffee', label: 'Coffee', words: ['coffee', 'nescafe'] },
  { key: 'onion', label: 'Onion', words: ['onion', 'onions', 'pyaz', 'pyaaz'] },
  { key: 'potato', label: 'Potato', words: ['potato', 'potatoes', 'aloo', 'aalu'] },
  { key: 'tomato', label: 'Tomato', words: ['tomato', 'tomatoes', 'tamatar'] },
  { key: 'biscuit', label: 'Biscuits', words: ['biscuit', 'biscuits', 'cookies'] },
  { key: 'noodles', label: 'Noodles', words: ['noodles', 'maggi'] },
  { key: 'soap', label: 'Soap', words: ['soap'] },
  { key: 'detergent', label: 'Detergent', words: ['detergent', 'surf', 'washing powder'] },
  { key: 'shampoo', label: 'Shampoo', words: ['shampoo'] },
  { key: 'toothpaste', label: 'Toothpaste', words: ['toothpaste'] },
];
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const KNOWN_RE = KNOWN_ITEMS.map((k) => ({ k, re: new RegExp(`(?<![a-z])(?:${k.words.map(esc).join('|')})(?![a-z])`, 'i') }));
const STOP = new Set(['fresh', 'organic', 'pack', 'pouch', 'new', 'premium', 'the', 'of', 'and', 'with', 'for', 'a', 'x', 'rs', 'mrp', 'big', 'small', 'large', 'regular']);

const singular = (w) => (w.length > 4 && w.endsWith('ies') ? w.slice(0, -3) + 'y'
  : w.length > 4 && w.endsWith('oes') ? w.slice(0, -2)
  : w.length > 3 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w);

/** "Aashirvaad Atta 5kg" -> 'atta'. Unknown items get a tidy key made from their first words. */
export function itemKey(name) {
  const low = String(name || '').toLowerCase();
  for (const { k, re } of KNOWN_RE) if (re.test(low)) return k.key;
  const words = low.replace(/[^a-z\s]/g, ' ').split(/\s+/).filter((w) => w.length > 1 && !STOP.has(w)).map(singular);
  return words.slice(0, 3).join(' ');
}
export const itemLabel = (key, fallback = '') => KNOWN_ITEMS.find((k) => k.key === key)?.label
  || (fallback || key).replace(/\b\w/g, (c) => c.toUpperCase());

// ------------------------------------------------------------------ reading a bill

const SKIP = /\b(total|sub\s?total|grand|gst|cgst|sgst|igst|tax|vat|cess|discount|savings?|saved|coupon|delivery|handling|packing|convenience|round\s?off|rounding|amount|amt|paid|payment|cash|upi|card|change|balance|invoice|bill|order|receipt|date|time|phone|mobile|contact|gstin|fssai|thank|visit|customer|cashier|address|www|http|items?|qty|rate|mrp|hsn|description|particulars|sr\.?\s?no)\b/i;
const SIZE = new RegExp(`(\\d+(?:\\.\\d+)?)\\s*(${UNIT_WORDS})\\b`, 'i');
const MULTI = new RegExp(`(\\d+)\\s*[x×]\\s*(\\d+(?:\\.\\d+)?)\\s*(${UNIT_WORDS})\\b`, 'i');
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/** Finds the bill date in the text, or returns `fallback` (today). Day-first, as in India. */
export function findBillDate(text, fallback) {
  const labelled = /\b(?:invoice|bill)\s*date\s*:?\s*(\d{1,2}[/.\-]\d{1,2}[/.\-]\d{2,4})/i.exec(text);
  if (labelled) text = labelled[1];
  let m = /\b(\d{1,2})[/.\-](\d{1,2})[/.\-](\d{2,4})\b/.exec(text);
  if (m) {
    let y = Number(m[3]); if (y < 100) y += 2000;
    if (isValidDate(y, Number(m[2]), Number(m[1]))) return ymd(y, Number(m[2]), Number(m[1]));
  }
  m = /\b(\d{1,2})[\s\-]*([A-Za-z]{3})[a-z]*[\s\-,]*(\d{2,4})\b/.exec(text);
  if (m && MONTHS.includes(m[2].toLowerCase())) {
    let y = Number(m[3]); if (y < 100) y += 2000;
    if (isValidDate(y, MONTHS.indexOf(m[2].toLowerCase()) + 1, Number(m[1]))) return ymd(y, MONTHS.indexOf(m[2].toLowerCase()) + 1, Number(m[1]));
  }
  return fallback;
}

const titleCase = (s) => s.replace(/\s+/g, ' ').trim().replace(/(^|\s)([a-z])/g, (_, a, b) => a + b.toUpperCase());

/** One bill line -> {name, qty, unit, price} (qty/unit as printed, e.g. 5 kg), or null if it isn't an item. */
export function parseBillLine(raw, { table = false } = {}) {
  let line = String(raw || '').replace(/[₹]/g, ' ').replace(/\brs\.?\s*(?=\d)/gi, ' ').trim();
  line = line.replace(/^\s*\d{1,3}\s*[.)\-:]\s+/, '');                      // "1. Atta ..." serial numbers
  if (!/[A-Za-z]{2,}/.test(line) || (!table && SKIP.test(line))) return null;
  line = line.replace(/\d[\d.]*\s*\/\s*(?:kg|g|l|ltr|ml|pc|pcs)\b/gi, ' ').replace(/@/g, ' '); // "30/kg" rates

  let count = 1, qty = null, unit = null, sized = false;
  const multi = MULTI.exec(line);
  if (multi) {
    count = Number(multi[1]); ({ qty, unit } = { qty: Number(multi[2]), unit: UNIT_ALIASES[multi[3].toLowerCase()] }); sized = true;
    line = line.replace(multi[0], ' ');
  } else {
    const size = SIZE.exec(line);
    if (size) { qty = Number(size[1]); unit = UNIT_ALIASES[size[2].toLowerCase()]; sized = true; line = line.replace(size[0], ' '); }
  }
  const nums = [...line.matchAll(/\d[\d,]*(?:\.\d+)?/g)].map((m) => Number(m[0].replace(/,/g, ''))).filter((n) => n < 1e6);
  const name = titleCase(line.replace(/\d[\d,]*(?:\.\d+)?/g, ' ').replace(/[x×*|()]/gi, (c) => (c === '(' || c === ')' ? c : ' '))
    .replace(/[(){}\[\]]/g, ' ').replace(/\s[-:.,]+\s/g, ' ').replace(/^[\s\-:.,]+|[\s\-:.,]+$/g, ''));
  if (name.replace(/[^A-Za-z]/g, '').length < 2) return null;

  let price = null;
  if (nums.length >= 3) {
    const [c, r, a] = nums.slice(-3);
    if (Number.isInteger(c) && Math.abs(c * r - a) <= Math.max(1, a * 0.02)) { count = c; price = a; } else price = nums[nums.length - 1];
  } else if (nums.length === 2) {
    const [a, b] = nums;
    if (Number.isInteger(a) && a >= 1 && a <= 24) { count = a; price = b; }
    else { price = b; const c = b / a; if (Number.isInteger(round(c, 1)) && c >= 1 && c <= 24) count = Math.round(c); }
  } else if (nums.length === 1) price = nums[0];

  let outQty = null, outUnit = null;
  if (sized) { outQty = round(qty * count); outUnit = unit === 'doz' ? 'pcs' : unit; if (unit === 'doz') outQty = round(qty * count * 12); }
  else if (nums.length >= 2 && count > 1) { outQty = count; outUnit = 'pcs'; }
  return { name, qty: outQty, unit: outUnit, price };
}

// A GST tax-invoice row (DMart and others): "1.  08023200  2  Bazana Walnut Kernels 250g  2.0  352.00  704.00"
//   = serial, HSN code, tax class, item (with pack size), packs bought, rate, value.
const TABLE_ROW = /^\s*\d{1,3}\s*\.\s+(\d{4,8})\s+\d\s+(.+?)\s+(\d+(?:\.\d+)?)\s+(\d[\d,]*(?:\.\d+)?)\s+(\d[\d,]*(?:\.\d+)?)\s*$/;
const num = (v) => Number(String(v).replace(/,/g, ''));
/** One invoice-table row -> an item line (food and household things alike), null if it isn't one. */
export function parseTableRow(raw) {
  const m = TABLE_ROW.exec(String(raw || '').replace(/\s{2,}/g, ' '));
  if (!m) return null;
  const [, , name, count, rate, value] = m;
  const item = parseBillLine(`${name} ${num(count)} ${num(rate)} ${num(value)}`, { table: true });
  if (!item) return null;
  return { ...item, price: num(value) };
}

/** Whole bill text -> {date, lines, skipped}. The person reviews every line before it is saved. */
export function parseBill(text, { today }) {
  const lines = [], skipped = [];
  const rows = String(text || '').split(/\r?\n/).map((r) => ({ r, t: parseTableRow(r) }));
  if (rows.filter((x) => x.t).length >= 2) {   // it is a tax invoice: read only the item table, ignore addresses, totals and headers
    // some invoices print the item table twice (a second copy in another order); "TOTAL ITEMS: 56" says how many are real
    const declared = Number(/total\s+items\s*:?\s*(\d+)/i.exec(text)?.[1]);
    const tableRows = rows.filter((x) => x.t);
    if (declared && tableRows.length === declared * 2) {
      const sig = (r) => r.replace(/^\s*\d+\s*\./, '').replace(/\d+\.0\b/g, (n) => n.replace('.0', '')).replace(/\.00\b/g, '').replace(/,/g, '').replace(/\s+/g, ' ').trim();
      const seen = new Map(), keep = new Set();
      for (const x of tableRows) { const k = sig(x.r); seen.set(k, (seen.get(k) || 0) + 1); if (seen.get(k) % 2 === 1) keep.add(x); }
      if (keep.size === declared) { for (const x of tableRows) if (!keep.has(x)) x.t = null; }
    }
    for (const { r, t } of rows) { if (t) lines.push({ name: t.name, qty: t.qty, unit: t.unit, price: t.price, raw: r.trim() });; }
    return { date: findBillDate(text, today), lines, skipped };
  }
  for (const raw of String(text || '').split(/\r?\n/)) {
    if (!raw.trim()) continue;
    // an item line has a price or a quantity; a line of words only is a shop name or a footer
    const item = /\d/.test(raw) ? parseBillLine(raw) : null;
    if (item) lines.push({ ...item, raw: raw.trim() }); else skipped.push(raw.trim());
  }
  return { date: findBillDate(text, today), lines, skipped };
}

// ------------------------------------------------------------------ saving bills

export function addBill(state, { date, store = '', lines }) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '')) throw new Error('Pick the bill date.');
  const good = (lines || []).filter((l) => (l.name || '').trim());
  if (!good.length) throw new Error('There are no items to save.');
  const bill = { id: state.nextId++, date, store: store.trim(), total: 0, count: 0 };
  for (const l of good) {
    const name = titleCase(l.name);
    const price = l.price === '' || l.price == null ? null : Number(l.price);
    const q = l.qty === '' || l.qty == null ? null : Number(l.qty);
    if (price !== null && !(price >= 0)) throw new Error(`The price for ${name} isn't a number.`);
    if (q !== null && !(q > 0)) throw new Error(`The quantity for ${name} must be above zero.`);
    const base = toBase(q, l.unit);
    state.purchases.push({ id: state.nextId++, billId: bill.id, date, key: itemKey(name), name, qty: base.qty, unit: base.unit, price });
    bill.total += price || 0; bill.count++;
  }
  bill.total = round(bill.total);
  state.bills.push(bill);
  return bill;
}
/** True if a bill with the same date, item count and total is already saved (pasting the same bill twice). */
export const looksSaved = (state, date, lines) => {
  const total = round(lines.reduce((s, l) => s + (Number(l.price) || 0), 0));
  const count = lines.filter((l) => (l.name || '').trim()).length;
  return state.bills.some((b) => b.date === date && b.count === count && b.total === total);
};
export function deleteBill(state, billId) {
  state.purchases = state.purchases.filter((p) => p.billId !== billId);
  state.bills = state.bills.filter((b) => b.id !== billId);
}
export function markFinished(state, key, date) {
  state.finished = state.finished.filter((f) => !(f.key === key && f.date === date));
  state.finished.push({ key, date });
}
export const unmarkFinished = (state, key, date) => { state.finished = state.finished.filter((f) => !(f.key === key && f.date === date)); };

// ------------------------------------------------------------------ how fast things get used

const median = (xs) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

function mergedBuys(purchases) {
  const byDate = new Map();
  for (const p of [...purchases].sort((a, b) => a.date.localeCompare(b.date) || a.id - b.id)) {
    const cur = byDate.get(p.date);
    if (!cur) byDate.set(p.date, { date: p.date, qty: p.qty, unit: p.unit, price: p.price, name: p.name });
    else {
      cur.qty = cur.qty != null && p.qty != null && cur.unit === p.unit ? cur.qty + p.qty : (cur.qty ?? p.qty);
      cur.price = (cur.price || 0) + (p.price || 0) || null;
    }
  }
  return [...byDate.values()];
}

/**
 * One entry per item. `people` is the household size (for the rough per-person guide).
 * status: 'first' (bought once), 'learning' (one gap so far), 'normal', 'fast' (used up quicker than usual), 'slow'.
 */
export function analyze(state, today, people = 4) {
  const groups = new Map();
  for (const p of state.purchases) { if (!p.key) continue; (groups.get(p.key) || groups.set(p.key, []).get(p.key)).push(p); }
  const out = [];
  for (const [key, ps] of groups) {
    const buys = mergedBuys(ps);
    const last = buys[buys.length - 1];
    const marks = state.finished.filter((f) => f.key === key).map((f) => f.date).sort();
    const intervals = [];
    for (let i = 0; i < buys.length - 1; i++) {
      const from = buys[i].date, nextBuy = buys[i + 1].date;
      const finished = marks.filter((d) => d >= from && d <= nextBuy).pop();
      const end = finished || nextBuy;
      const days = diffDays(end, from);
      if (days < 1) continue;
      const qty = buys[i].qty != null && buys[i].unit && buys[i].unit === buys[i + 1].unit ? buys[i].qty : null;
      intervals.push({ from, to: end, days, qty, unit: buys[i].unit, perDay: qty != null ? qty / days : null, finished: !!finished });
    }
    const rates = intervals.map((i) => i.perDay).filter((x) => x != null);
    const perDay = median(rates);
    const medianDays = median(intervals.map((i) => i.days));
    const label = itemLabel(key, last.name);
    const known = KNOWN_ITEMS.find((k) => k.key === key);
    const a = { key, label, unit: last.unit, buys: buys.length, lastBought: last.date, lastQty: last.qty, lastPrice: last.price,
      intervals, perDay, medianDays, status: 'first', message: '', note: '', remaining: null, daysLeft: null };

    // status of the latest completed gap against the earlier ones
    if (intervals.length) {
      const latest = intervals[intervals.length - 1], earlier = intervals.slice(0, -1);
      if (!earlier.length) {
        a.status = 'learning';
        a.message = `Lasted ${latest.days} day${latest.days === 1 ? '' : 's'}. I'll compare once you buy it again.`;
      } else {
        const baseDays = median(earlier.map((i) => i.days));
        const baseRate = median(earlier.map((i) => i.perDay).filter((x) => x != null));
        const ratio = latest.perDay != null && baseRate ? latest.perDay / baseRate : baseDays / latest.days;
        if (baseDays >= 3 && ratio > 1.3) {
          a.status = 'fast';
          a.message = `Lasted ${latest.days} days; it usually lasts about ${Math.round(baseDays)}. Used about ${Math.round((ratio - 1) * 100)}% faster than usual. (If you topped up before it ran out, ignore this.)`;
        } else if (baseDays >= 3 && ratio < 0.7) {
          a.status = 'slow';
          a.message = `Lasted ${latest.days} days, longer than the usual ${Math.round(baseDays)}.`;
        } else { a.status = 'normal'; a.message = `Lasted ${latest.days} days, about the usual ${Math.round(baseDays)}.`; }
      }
    } else a.message = 'Bought once so far. I need a second purchase to learn how fast it is used.';

    // compared with a rough guide, when there is one
    if (known?.use && perDay && known.use.unit === last.unit && people > 0) {
      const each = perDay / people, u = known.use;
      if (each > u.high) a.note = `About ${Math.round(each)} ${u.unit} per person per day. The usual range is roughly ${u.low}–${u.high}, so this looks on the high side.`;
      else if (each < u.low * 0.6) a.note = `About ${Math.round(each)} ${u.unit} per person per day, below the usual ${u.low}–${u.high}.`;
    }

    // what is probably left at home now
    const sinceLast = diffDays(today, last.date);
    if (marks.some((d) => d >= last.date)) { a.remaining = 0; a.daysLeft = 0; }
    else if (perDay && last.qty != null) {
      a.remaining = Math.max(0, last.qty - perDay * sinceLast); a.daysLeft = a.remaining / perDay;
    } else if (medianDays) a.daysLeft = Math.max(0, medianDays - sinceLast);
    out.push(a);
  }
  const rank = { fast: 0, slow: 1, normal: 2, learning: 3, first: 4 };
  return out.sort((a, b) => (rank[a.status] - rank[b.status]) || a.label.localeCompare(b.label));
}

/**
 * How full the cupboard probably is for one analysed item -> {band, level 0..1 | null, daysLeft | null}.
 * band: 'full' (just restocked), 'fine', 'low' (nearing restock), 'restock' (out or about to be), 'learning' (not enough history).
 */
export function stockLevel(a, today) {
  if (a.remaining === 0 && a.daysLeft === 0) return { band: 'restock', level: 0, daysLeft: 0 };
  let level = null;
  if (a.perDay && a.lastQty != null && a.lastQty > 0 && a.remaining != null) level = a.remaining / a.lastQty;
  else if (a.medianDays && a.daysLeft != null) level = a.daysLeft / a.medianDays;
  if (level == null) return { band: 'learning', level: null, daysLeft: null, sinceBought: diffDays(today, a.lastBought) };
  level = Math.max(0, Math.min(1, level));
  const band = level <= 0.12 || (a.daysLeft != null && a.daysLeft < 1.5) ? 'restock' : level < 0.35 ? 'low' : level < 0.7 ? 'fine' : 'full';
  return { band, level, daysLeft: a.daysLeft };
}

// ------------------------------------------------------------------ next month's list

/**
 * What to buy for the next `horizon` days: the usual rate x days, minus what is probably left.
 * Only items bought at least twice, and bought lately, get a quantity. The rest are listed separately.
 */
export function monthlyList(state, today, { people = 4, horizon = 30, recentDays = 120 } = {}) {
  const items = [], needMoreData = [];
  for (const a of analyze(state, today, people)) {
    if (diffDays(today, a.lastBought) > recentDays) continue;
    const buysAll = mergedBuys(state.purchases.filter((p) => p.key === a.key));
    const packs = buysAll.map((b) => b.qty).filter((q) => q != null);
    const pack = median(packs);
    if (a.perDay && pack) {
      const need = a.perDay * horizon, left = a.remaining ?? 0;
      const toBuy = Math.max(0, need - left);
      let n = Math.ceil(toBuy / pack - 0.2);
      if (toBuy >= pack * 0.4) n = Math.max(1, n); else n = 0;
      if (n > 0) {
        const qty = n * pack;
        const unitPrice = a.lastPrice != null && a.lastQty ? a.lastPrice / a.lastQty : null;
        items.push({ key: a.key, label: a.label, qty, unit: a.unit, packs: n, pack, daysLeft: a.daysLeft,
          cost: unitPrice != null ? round(unitPrice * qty) : null,
          why: a.daysLeft != null && a.daysLeft < 7 ? 'running low' : `about ${Math.round(a.perDay * 10) / 10} ${a.unit}/day` });
      }
    } else if (a.medianDays && a.buys >= 2) {
      if ((a.daysLeft ?? 0) <= horizon) items.push({ key: a.key, label: a.label, qty: null, unit: null, packs: 1, pack: null, daysLeft: a.daysLeft,
        cost: a.lastPrice, why: `bought about every ${Math.round(a.medianDays)} days` });
    } else needMoreData.push(a.label);
  }
  items.sort((a, b) => (a.daysLeft ?? 99) - (b.daysLeft ?? 99) || a.label.localeCompare(b.label));
  const costs = items.map((i) => i.cost).filter((c) => c != null);
  return { items, needMoreData, estimate: costs.length ? round(costs.reduce((s, c) => s + c, 0)) : null, horizon };
}

export function listShareText(list, today) {
  const lines = list.items.map((i) => `☐ ${i.label}${i.qty != null ? ' – ' + formatQty(i.qty, i.unit) : ''}`);
  return [`Grocery list (next ${list.horizon} days, from ${niceDate(today)})`, ...lines,
    ...(list.estimate != null ? [`Estimated cost about ₹${Math.round(list.estimate)}`] : [])].join('\n');
}
export { addDays };

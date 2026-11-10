import { addDays, diffDays, monthLabel, monthRange, niceDate, parts, weekday, ymd, MONTHS } from './dates.js';
import { INCOME, UNCATEGORIZED, categorize } from './parser.js';
import { allCategoryNames } from './store.js';

export const PERIODS = [['month', 'This month'], ['last_month', 'Last month'], ['week', 'This week'], ['today', 'Today'],
  ['year', 'This year'], ['all', 'All time'], ['custom', 'Custom dates']];
export const TYPES = [['', 'Everything'], ['Expense', 'Expenses only'], ['Income', 'Income only']];

const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s || '');

/** -> {first, last, label}; null first/last means no limit */
export function resolvePeriod(period, start, end, today) {
  const { y, m } = parts(today);
  if (period === 'all') return { first: null, last: null, label: 'All time' };
  if (period === 'today') return { first: today, last: today, label: `Today, ${niceDate(today)}` };
  if (period === 'week') { const mon = addDays(today, -weekday(today)); return { first: mon, last: addDays(mon, 6), label: 'This week' }; }
  if (period === 'month') { const [a, b] = monthRange(y, m); return { first: a, last: b, label: monthLabel(y, m) }; }
  if (period === 'last_month') {
    const py = m === 1 ? y - 1 : y, pm = m === 1 ? 12 : m - 1; const [a, b] = monthRange(py, pm);
    return { first: a, last: b, label: monthLabel(py, pm) };
  }
  if (period === 'year') return { first: `${y}-01-01`, last: `${y}-12-31`, label: String(y) };
  if (period === 'custom') {
    const first = isDate(start) ? start : null, last = isDate(end) ? end : null;
    if (!first && !last) throw new Error('Pick a start date, an end date, or both.');
    if (first && last && first > last) throw new Error('The start date is after the end date.');
    let label;
    if (first && last) {
      const p = parts(first);
      label = first.endsWith('-01') && last === monthRange(p.y, p.m)[1] ? monthLabel(p.y, p.m) : `${niceDate(first)} to ${niceDate(last)}`;
    } else label = first ? `From ${niceDate(first)}` : `Up to ${niceDate(last)}`;
    return { first, last, label };
  }
  throw new Error('Unknown period.');
}

const round2 = (n) => Math.round(n * 100) / 100;

function group(rows, keyFn, label) {
  const map = new Map();
  for (const r of rows) {
    const k = keyFn(r);
    const g = map.get(k) || { [label]: k, entries: 0, total: 0 };
    g.entries++; g.total += r.amount; map.set(k, g);
  }
  return [...map.values()].sort((a, b) => b.total - a.total);
}
const withPercent = (rows, expenses) => rows.map((r) => ({ ...r, total: round2(r.total), percent: expenses ? Math.round((r.total / expenses) * 1000) / 10 : 0 }));

export function filterEntries(state, { first = null, last = null, category = '', person = '', type = '', text = '' } = {}) {
  const t = text.trim().toLowerCase();
  return state.entries.filter((e) => (!first || e.date >= first) && (!last || e.date <= last)
    && (!category || e.category === category) && (!person || e.addedBy === person) && (!type || e.type === type)
    && (!t || `${e.description} ${e.category} ${e.addedBy}`.toLowerCase().includes(t)));
}
export const newestFirst = (rows) => [...rows].sort((a, b) => b.date.localeCompare(a.date) || b.id - a.id);

export function buildReport(state, { period = 'month', start = '', end = '', category = '', person = '', type = '', today }) {
  const { first, last, label } = resolvePeriod(period, start, end, today);
  if (category && ![...allCategoryNames(state), INCOME].includes(category)) throw new Error(`Unknown category: ${category}.`);
  if (type !== 'Expense' && type !== 'Income') type = '';
  const narrowed = filterEntries(state, { first, last, category, person });
  const entries = newestFirst(type ? narrowed.filter((e) => e.type === type) : narrowed);
  const expRows = narrowed.filter((e) => e.type === 'Expense');
  const incRows = narrowed.filter((e) => e.type === 'Income');
  const expenses = round2(expRows.reduce((s, e) => s + e.amount, 0));
  const income = round2(incRows.reduce((s, e) => s + e.amount, 0));
  const sources = group(filterEntries(state, { first, last, person, type: 'Income' }), (e) => e.description || 'Income', 'source')
    .map((r) => ({ ...r, total: round2(r.total) }));
  return {
    label, period, category, person, type, first, last, entries, income, expenses, balance: round2(income - expenses),
    byCategory: withPercent(group(expRows, (e) => e.category, 'category'), expenses),
    byPerson: withPercent(group(expRows, (e) => e.addedBy || 'Unknown', 'person'), expenses),
    incomeSources: sources, showBalance: !category,
  };
}

export function monthOverview(state, today) {
  const { y, m } = parts(today);
  const [first, last] = monthRange(y, m);
  const rows = filterEntries(state, { first, last });
  const expenses = round2(rows.filter((e) => e.type === 'Expense').reduce((s, e) => s + e.amount, 0));
  const income = round2(rows.filter((e) => e.type === 'Income').reduce((s, e) => s + e.amount, 0));
  return { label: monthLabel(y, m), income, expenses, balance: round2(income - expenses) };
}

export const totalExpenses = (state) => round2(state.entries.filter((e) => e.type === 'Expense').reduce((s, e) => s + e.amount, 0));

const MONTH_LOOKUP = {};
MONTHS.forEach((n, i) => { MONTH_LOOKUP[n.toLowerCase()] = i + 1; MONTH_LOOKUP[n.slice(0, 3).toLowerCase()] = i + 1; });
MONTH_LOOKUP.sept = 9;
const MONTH_RE = new RegExp(`\\b(${Object.keys(MONTH_LOOKUP).sort((a, b) => b.length - a.length).join('|')})\\b(?:\\s+((?:19|20)\\d{2}))?`);

/** 'report grocery october' -> arguments for buildReport */
export function parseReportCommand(text, today, categories) {
  const rest = text.toLowerCase().replace(/^\s*report\b/, '').trim();
  const cat = categorize(rest, categories);
  const req = { period: 'month', start: '', end: '', category: cat === UNCATEGORIZED ? '' : cat };
  const mm = MONTH_RE.exec(rest);
  const { y, m } = parts(today);
  if (mm) {
    const n = MONTH_LOOKUP[mm[1]];
    const year = mm[2] ? Number(mm[2]) : (n <= m ? y : y - 1);
    const [a, b] = monthRange(year, n);
    Object.assign(req, { period: 'custom', start: a, end: b });
  } else if (/\blast month\b/.test(rest)) req.period = 'last_month';
  else if (/\btoday\b/.test(rest)) req.period = 'today';
  else if (/\b(?:this )?week\b/.test(rest)) req.period = 'week';
  else if (/\b(?:this )?year\b/.test(rest)) req.period = 'year';
  else if (/\b(?:all|overall|everything)\b/.test(rest)) req.period = 'all';
  return req;
}
export { ymd, diffDays };

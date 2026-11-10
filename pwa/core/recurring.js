// Recurring expenses: monthly / quarterly / yearly, always on the same day of the month.
// A day a month doesn't have falls on its last day, but the original day is kept (31st -> 28 Feb -> 31 Mar).
import { addMonths, clampDate, diffDays, niceDate, shortDate, parts } from './dates.js';
import { ParseError, parseMessage, UNCATEGORIZED } from './parser.js';
import { pushEntry } from './store.js';
import { inr } from './format.js';

export const FREQUENCY_MONTHS = { monthly: 1, quarterly: 3, yearly: 12 };
const FREQUENCY_WORDS = { monthly: 'monthly', 'every month': 'monthly', quarterly: 'quarterly', 'every quarter': 'quarterly',
  yearly: 'yearly', annual: 'yearly', annually: 'yearly', 'every year': 'yearly' };
const MONTH_WORDS = {};
['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december']
  .forEach((m, i) => { MONTH_WORDS[m] = i + 1; MONTH_WORDS[m.slice(0, 3)] = i + 1; });

export function nextDueAfter(due, frequency, dueDay) {
  const { y, m } = parts(due);
  const [ny, nm] = addMonths(y, m, FREQUENCY_MONTHS[frequency]);
  return clampDate(ny, nm, dueDay);
}

/** First due date on or after today. For yearly items `month` says which month. */
export function firstDue(frequency, dueDay, today, month = null) {
  const { y, m } = parts(today);
  if (frequency === 'yearly') {
    const mm = month || m;
    const c = clampDate(y, mm, dueDay);
    return c >= today ? c : clampDate(y + 1, mm, dueDay);
  }
  const c = clampDate(y, m, dueDay);
  return c >= today ? c : nextDueAfter(c, 'monthly', dueDay);
}

export function status(item, today) {
  const days = diffDays(item.nextDue, today);
  if (days < 0) return ['overdue', days];
  if (days === 0) return ['today', 0];
  return [days <= item.remindDays ? 'soon' : 'later', days];
}

export function dueText(item, today) {
  const [state, days] = status(item, today);
  if (state === 'overdue') return `${item.name} was due ${shortDate(item.nextDue)} (${-days} day${days !== -1 ? 's' : ''} ago)`;
  if (state === 'today') return `${item.name} is due today`;
  return `${item.name} is due ${shortDate(item.nextDue)} (in ${days} day${days !== 1 ? 's' : ''})`;
}

export function dueSoon(state, today) {
  return state.recurring.filter((r) => r.active !== false)
    .map((item) => ({ item, state: status(item, today)[0], text: dueText(item, today) }))
    .filter((x) => x.state !== 'later')
    .sort((a, b) => a.item.nextDue.localeCompare(b.item.nextDue));
}

export function addRecurring(state, { name, amount, category, frequency, dueDay, month = null, remindDays = 2 }, today) {
  if (!name || !(amount > 0)) throw new ParseError('A recurring expense needs a name and an amount above zero.');
  if (!(frequency in FREQUENCY_MONTHS)) throw new ParseError('Say how often: monthly, quarterly or yearly.');
  if (!(dueDay >= 1 && dueDay <= 31)) throw new ParseError('The day of the month must be between 1 and 31.');
  const item = { id: state.nextId++, name: name.slice(0, 60), amount, category: category || UNCATEGORIZED, frequency, dueDay,
    nextDue: firstDue(frequency, dueDay, today, month), remindDays, active: true };
  state.recurring.push(item);
  return item;
}

/** Records the expense and moves the due date on by one period. */
export function markPaid(state, id, paidBy, paidOn) {
  const item = state.recurring.find((r) => r.id === id);
  if (!item) return null;
  pushEntry(state, { date: paidOn, amount: item.amount, category: item.category, description: item.name, addedBy: paidBy });
  item.nextDue = nextDueAfter(item.nextDue, item.frequency, item.dueDay);
  return item;
}

export const removeRecurring = (state, id) => {
  const i = state.recurring.findIndex((r) => r.id === id);
  if (i >= 0) state.recurring.splice(i, 1);
};

export const reminderShareText = (item, today) => `Reminder: ${dueText(item, today)}. Amount ${inr(item.amount)}.`;
/** A line the group's importer reads back as this expense (name, amount, explicit category). */
export const paidShareText = (item) => `${item.name} ${item.amount}${item.category === UNCATEGORIZED ? '' : ' ' + item.category}`;

export function findByName(state, query) {
  query = query.trim().toLowerCase();
  const rows = state.recurring;
  const exact = rows.filter((r) => r.name.toLowerCase() === query);
  if (exact.length) return exact[0];
  const partial = rows.filter((r) => query && r.name.toLowerCase().includes(query));
  return partial.length === 1 ? partial[0] : null;
}

/** "recurring rent 25000 monthly on 1", "recurring LIC 24000 yearly on 5 march remind 7" */
export function parseRecurring(text, { today, categories }) {
  let rest = text.replace(/^\s*recurring\s*(add)?\s*/i, '');
  let frequency = null;
  for (const word of Object.keys(FREQUENCY_WORDS).sort((a, b) => b.length - a.length)) {
    const re = new RegExp(`\\b${word}\\b`, 'i');
    if (re.test(rest)) { frequency = FREQUENCY_WORDS[word]; rest = rest.replace(re, ' '); break; }
  }
  if (!frequency) throw new ParseError('Say how often: monthly, quarterly or yearly. Example: recurring rent 25000 monthly on 1');
  let remindDays = 2;
  const r = /\bremind(?:\s+me)?\s+(\d{1,2})\b(?:\s+days?(?:\s+before)?)?/i.exec(rest);
  if (r) { remindDays = Number(r[1]); rest = rest.replace(r[0], ' '); }
  let dueDay = null, month = null;
  const names = Object.keys(MONTH_WORDS).sort((a, b) => b.length - a.length).join('|');
  const d = new RegExp(`\\bon\\s+(?:the\\s+)?(\\d{1,2})(?:st|nd|rd|th)?(?:\\s+(?:of\\s+)?(${names}))?\\b`, 'i').exec(rest);
  if (d) { dueDay = Number(d[1]); month = d[2] ? MONTH_WORDS[d[2].toLowerCase()] : null; rest = rest.replace(d[0], ' '); }
  if (dueDay === null) dueDay = parts(today).d;
  if (dueDay < 1 || dueDay > 31) throw new ParseError('The day of the month must be between 1 and 31.');
  const parsed = parseMessage(rest, { today, categories });
  const name = parsed.description && parsed.description !== parsed.category ? parsed.description : parsed.category;
  return { name, amount: parsed.amount, category: parsed.category, frequency, dueDay, month, remindDays };
}
export { niceDate };

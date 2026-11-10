// handleMessage(): the one place a typed message is understood and saved. The chat box calls this.
import { ParseError, UNCATEGORIZED, parseEdit, parseMessage } from './parser.js';
import { addEntry, lastEntryBy, updateEntry, deleteEntry } from './store.js';
import { inr } from './format.js';
import { niceDate } from './dates.js';
import { buildReport, monthOverview, parseReportCommand, totalExpenses } from './reports.js';
import * as rec from './recurring.js';

export const HELP_TEXT = [
  'Send a message with an amount, for example:',
  '• Spent 450 on vegetables', '• Medicine 320 yesterday', '• Gift 1500 birthday', '• Income 85000 salary',
  'Commands: total, month, report grocery october, undo, edit 500, help',
  'Recurring: recurring rent 25000 monthly on 1 · due · paid rent · recurring remove rent',
].join('\n');

const reply = (text, ok = true, extra = {}) => ({ text, ok, ...extra });
const monthLine = (o) => `${o.label}: income ${inr(o.income)}, expenses ${inr(o.expenses)}, balance ${inr(o.balance)}.`;
const entryText = (e) => (e.type === 'Income'
  ? `income of ${inr(e.amount)} (${e.description}, ${niceDate(e.date)})`
  : `${inr(e.amount)} under ${e.category} (${e.description}, ${niceDate(e.date)})`);
const totalsLine = (state, e) => (e.type === 'Income' ? monthLine(monthOverview(state, e.date)) : `Total so far: ${inr(totalExpenses(state))}.`);
const isReportCommand = (c) => (c === 'report' || c.startsWith('report ')) && !/\d/.test(c.replace(/\b(?:19|20)\d{2}\b/g, ''));

const LABELS = [['amount', 'amount'], ['category', 'category'], ['date', 'date'], ['description', 'description']];
const show = (k, v) => (k === 'amount' ? inr(v) : k === 'date' ? niceDate(v) : String(v));
const differences = (a, b) => LABELS.filter(([k]) => a[k] !== b[k]).map(([k, l]) => `${l} ${show(k, a[k])} → ${show(k, b[k])}`);

export function reportReply(r) {
  const scope = [r.category, r.person, r.label].filter(Boolean).join(' · ');
  if (r.category) {
    const n = r.byCategory.reduce((s, x) => s + x.entries, 0);
    return `${scope}: ${inr(r.expenses)} across ${n} entr${n === 1 ? 'y' : 'ies'}.`;
  }
  const lines = [`${scope}: income ${inr(r.income)}, expenses ${inr(r.expenses)}, balance ${inr(r.balance)}.`];
  for (const row of r.byCategory.slice(0, 5)) lines.push(`• ${row.category}: ${inr(row.total)} (${Math.round(row.percent)}%)`);
  return lines.join('\n');
}

function recurringCommand(state, text, command, sender, today) {
  const categories = state.categories;
  if (command === 'due' || command === 'reminders') {
    const items = rec.dueSoon(state, today);
    return reply(items.length ? 'Due soon:\n' + items.map((i) => `• ${i.text} - ${inr(i.item.amount)}`).join('\n') : 'Nothing is due soon.');
  }
  if (command === 'recurring') {
    const rows = state.recurring;
    return reply(rows.length ? 'Recurring expenses:\n' + rows.map((r) => `• ${r.name} - ${inr(r.amount)} ${r.frequency}, next ${r.nextDue}`).join('\n')
      : 'No recurring expenses yet. Add one: recurring rent 25000 monthly on 1');
  }
  if (command.startsWith('recurring remove ') || command.startsWith('recurring stop ')) {
    const name = text.split(/\s+/).slice(2).join(' ');
    const row = rec.findByName(state, name);
    if (!row) return reply(`I couldn't find exactly one recurring expense matching '${name}'. Send 'recurring' to see the list.`, false);
    rec.removeRecurring(state, row.id);
    return reply(`Stopped recurring ${row.name}. Past payments stay.`, true, { changed: true });
  }
  if (command.startsWith('recurring ')) {
    try {
      const item = rec.addRecurring(state, rec.parseRecurring(text, { today, categories }), today);
      return reply(`Added recurring ${item.name}: ${inr(item.amount)} ${item.frequency}. Next due ${item.nextDue}, reminder ${item.remindDays} days before.`, true, { changed: true });
    } catch (e) { if (e instanceof ParseError) return reply(e.message, false); throw e; }
  }
  const paid = /^paid\s+([^\d]+)$/.exec(command);
  if (paid) {
    const row = rec.findByName(state, paid[1]);
    if (row) {
      rec.markPaid(state, row.id, sender, today);
      return reply(`Recorded ${row.name} ${inr(row.amount)}. Next due ${row.nextDue}. To tell the group, post: ${rec.paidShareText(row)}`,
        true, { changed: true, share: rec.paidShareText(row) });
    }
  }
  return null;
}

export function handleMessage(state, text, sender, today) {
  text = (text || '').trim();
  sender = (sender || '').trim() || 'Me';
  const command = text.toLowerCase().replace(/[?!. ]+$/, '');
  const categories = state.categories;

  if (command === 'help') return reply(HELP_TEXT);
  if (command === 'total' || command === 'totals') return reply(`Total expenses so far: ${inr(totalExpenses(state))}`);
  if (command === 'month' || command === 'summary') return reply(monthLine(monthOverview(state, today)));

  if (command === 'undo') {
    const e = lastEntryBy(state, sender);
    if (!e) return reply('You have no entries to undo.', false);
    deleteEntry(state, e.id, sender);
    return reply(`Removed ${entryText(e)}. ${totalsLine(state, e)}`, true, { changed: true });
  }
  if (command === 'edit' || command.startsWith('edit ')) {
    let changes;
    try { changes = parseEdit(text, { today, categories }); } catch (e) { if (e instanceof ParseError) return reply(e.message, false); throw e; }
    const e = lastEntryBy(state, sender);
    if (!e) return reply('You have no entries to edit.', false);
    if (e.type === 'Income' && changes.category) return reply("Income entries don't have a category. You can change the amount, for example: edit 90000.", false);
    const before = { ...e };
    const updated = updateEntry(state, e.id, sender, changes);
    const diffs = differences(before, updated);
    if (!diffs.length) return reply('Nothing to change: your last entry already looks like that.');
    return reply(`Updated your last entry (${before.description}): ${diffs.join(', ')}. ${totalsLine(state, updated)}`, true, { changed: true });
  }

  const r = recurringCommand(state, text, command, sender, today);
  if (r) return r;

  if (isReportCommand(command)) {
    try { return reply(reportReply(buildReport(state, { today, ...parseReportCommand(command, today, categories) }))); }
    catch (e) { return reply(e.message, false); }
  }

  let parsed;
  try { parsed = parseMessage(text, { today, categories }); }
  catch (e) { if (e instanceof ParseError) return reply(`${e.message}\n\n${HELP_TEXT}`, false); throw e; }

  addEntry(state, { ...parsed, addedBy: sender });
  let out;
  if (parsed.type === 'Income') out = `Recorded income of ${inr(parsed.amount)} (${parsed.description}). ${monthLine(monthOverview(state, parsed.date))}`;
  else {
    out = `Recorded ${inr(parsed.amount)} under ${parsed.category}`;
    if (parsed.date !== today) out += ` for ${niceDate(parsed.date)}`;
    out += `. Total so far: ${inr(totalExpenses(state))}.`;
    if (parsed.category === UNCATEGORIZED) out += " I couldn't tell the category. Next time include one, like Grocery or Travel.";
  }
  return reply(out, true, { changed: true, share: text });
}

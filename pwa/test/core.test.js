import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseMessage, parseEdit, ParseError, findAmount } from '../core/parser.js';
import { inr } from '../core/format.js';
import { addDays, diffDays } from '../core/dates.js';
import * as store from '../core/store.js';
import * as rec from '../core/recurring.js';
import { buildReport, monthOverview } from '../core/reports.js';
import { handleMessage } from '../core/service.js';
import { parseChat, stageImport, confirmImport, readExport } from '../core/chat.js';
import { entriesWorkbook, zipStore } from '../core/xlsx.js';
import { TODAY, fresh } from './helpers.js';

const P = (t) => parseMessage(t, { today: TODAY });
const send = (s, text, who = 'Asha') => handleMessage(s, text, who, TODAY);

test('parser: amount, category, description, date', () => {
  const r = P('Spent 450 on vegetables');
  assert.deepEqual([r.amount, r.category, r.description, r.date], [450, 'Grocery', 'Vegetables', TODAY]);
  assert.equal(P('Medicine 320 yesterday').date, '2026-11-09');
  assert.throws(() => P('bought some vegetables'), ParseError);
  for (const t of ['', '   ', 'groceries 0']) assert.throws(() => P(t), ParseError, t);
});

test('parser: keyword categories and explicit category wins', () => {
  const cases = { 'petrol 2000': 'Vehicle', 'netflix 649': 'Entertainment', 'SIP 5000': 'Investment', 'train ticket 1200': 'Travel',
    'saree 3500': 'Clothes', 'school fees 25000': 'School Fees', 'engine oil 900': 'Vehicle', 'Gift 800 movie tickets': 'Gift',
    'Spent 450 on random stuff': 'Uncategorized' };
  for (const [t, c] of Object.entries(cases)) assert.equal(P(t).category, c, t);
});

test('parser: amount formats, quantities, times and dates are not money', () => {
  assert.equal(P('petrol 2,000').amount, 2000);
  assert.equal(P('Paid ₹1,250.50 for netflix').amount, 1250.5);
  assert.equal(P('Rs 300 milk').amount, 300);
  assert.equal(P('2k fuel').amount, 2000);
  assert.equal(P('2 kg onions 80').amount, 80);
  assert.equal(P('dinner at 7 pm 1200').amount, 1200);
  assert.equal(P('PTM on 15/11 fees 500').amount, 500);
  assert.equal(P('movie at 8:30 600').amount, 600);
  assert.equal(findAmount('no numbers here'), null);
});

test('parser: income', () => {
  const r = P('Income 85000 salary');
  assert.deepEqual([r.type, r.category, r.amount], ['Income', 'Income', 85000]);
  assert.equal(P('salary 85000').type, 'Income');
  assert.equal(P('Income tax 5000').type, 'Expense');
  assert.equal(P('Maid salary 8000').type, 'Expense');
});

test('parser: real-world Hinglish lines', () => {
  assert.deepEqual([P('70 rs for Dhaniya and mirchi').category, P('70 rs for Dhaniya and mirchi').description], ['Grocery', 'Dhaniya and mirchi']);
  assert.equal(P('1000 to didi for gift bhaiya Dooj').category, 'Gift');
  assert.equal(P('18000 for tyre change').category, 'Vehicle');
  assert.equal(P('2850 for D mart(sweets,oil,soap,milk,honey)').amount, 2850);
});

test('parseEdit', () => {
  const E = (t) => parseEdit(t, { today: TODAY });
  assert.deepEqual(E('edit 500'), { amount: 500 });
  assert.deepEqual(E('edit gift'), { category: 'Gift' });
  assert.deepEqual(E('edit 500 grocery'), { amount: 500, category: 'Grocery' });
  assert.deepEqual(E('edit yesterday'), { date: '2026-11-09' });
  assert.throws(() => E('edit'), ParseError);
});

test('custom categories: add, use, rename, delete', () => {
  const s = fresh();
  store.addCategory(s, 'Pets', 'dog food, vet, kutta');
  assert.equal(send(s, 'vet 1200').text.includes('under Pets'), true);
  assert.equal(send(s, 'Pets 300 toys').text.includes('under Pets'), true);   // category name wins
  assert.throws(() => store.addCategory(s, 'pets'), /already exists/);
  assert.throws(() => store.addCategory(s, 'Income'), /already exists/);
  store.updateCategory(s, 'Pets', { name: 'Pet care' });
  assert.equal(s.entries.every((e) => e.category === 'Pet care'), true);
  assert.equal(send(s, 'dog food 900').text.includes('Pet care'), true);
  assert.equal(store.deleteCategory(s, 'Pet care'), 3);
  assert.equal(s.entries.every((e) => e.category === 'Uncategorized'), true);
});

test('custom keywords can be non-English', () => {
  const s = fresh();
  store.addCategory(s, 'Dudh', 'दूध');
  assert.equal(P_with(s, 'दूध 60').category, 'Dudh');
});
const P_with = (s, t) => parseMessage(t, { today: TODAY, categories: s.categories });

test('editing built-in keywords changes categorizing', () => {
  const s = fresh();
  store.updateCategory(s, 'Travel', { keywords: 'train, flight, rickshaw' });
  assert.equal(P_with(s, 'rickshaw 40').category, 'Travel');
  assert.equal(P_with(s, 'metro 40').category, 'Uncategorized');
});

test('undo and edit act on your own last typed entry', () => {
  const s = fresh();
  send(s, 'Spent 450 on vegetables'); send(s, 'Spent 300 on petrol', 'Rahul');
  assert.match(send(s, 'edit 500').text, /₹450.00 → ₹500.00/);
  assert.equal(s.entries[0].amount, 500);
  assert.match(send(s, 'undo').text, /Removed ₹500.00 under Grocery/);
  assert.equal(send(s, 'undo').ok, false);
  assert.equal(s.entries.length, 1);
  assert.equal(s.changes.length, 2);
});

test('commands: total, month, report, help', () => {
  const s = fresh();
  send(s, 'Spent 450 on vegetables'); send(s, 'Income 85000 salary'); send(s, 'petrol 2000 yesterday');
  assert.match(send(s, 'total').text, /₹2,450.00/);
  assert.match(send(s, 'month').text, /income ₹85,000.00, expenses ₹2,450.00, balance ₹82,550.00/);
  assert.match(send(s, 'report grocery').text, /₹450.00 across 1 entry/);
  assert.match(send(s, 'help').text, /Spent 450/);
  assert.equal(send(s, 'report card fees 200').text.startsWith('Recorded'), true);
});

test('inr uses Indian grouping', () => {
  assert.equal(inr(1234567.5), '₹12,34,567.50'); assert.equal(inr(999), '₹999.00'); assert.equal(inr(100000), '₹1,00,000.00');
});

test('reports: periods, filters, shares', () => {
  const s = fresh();
  store.addEntry(s, { date: '2026-11-03', amount: 600, category: 'Grocery', description: 'x', addedBy: 'A' });
  store.addEntry(s, { date: '2026-11-04', amount: 400, category: 'Vehicle', description: 'y', addedBy: 'B' });
  store.addEntry(s, { date: '2026-10-30', amount: 100, category: 'Grocery', description: 'z', addedBy: 'A' });
  store.addEntry(s, { date: '2026-11-01', amount: 5000, category: 'Income', description: 'Salary', addedBy: 'A', type: 'Income' });
  const r = buildReport(s, { today: TODAY });
  assert.deepEqual([r.expenses, r.income, r.balance], [1000, 5000, 4000]);
  assert.deepEqual(r.byCategory.map((c) => [c.category, c.percent]), [['Grocery', 60], ['Vehicle', 40]]);
  assert.equal(buildReport(s, { today: TODAY, period: 'last_month' }).expenses, 100);
  assert.equal(buildReport(s, { today: TODAY, period: 'all', person: 'A' }).expenses, 700);
  assert.equal(buildReport(s, { today: TODAY, category: 'Grocery' }).showBalance, false);
  assert.equal(buildReport(s, { today: TODAY, period: 'week' }).first, '2026-11-09');
  assert.throws(() => buildReport(s, { today: TODAY, category: 'Nope' }), /Unknown category/);
  assert.equal(monthOverview(s, TODAY).label, 'November 2026');
});

test('recurring: date rules', () => {
  assert.equal(rec.nextDueAfter('2026-01-31', 'monthly', 31), '2026-02-28');
  assert.equal(rec.nextDueAfter('2026-02-28', 'monthly', 31), '2026-03-31');
  assert.equal(rec.nextDueAfter('2028-01-30', 'monthly', 30), '2028-02-29');
  assert.equal(rec.nextDueAfter('2026-11-15', 'quarterly', 15), '2027-02-15');
  assert.equal(rec.nextDueAfter('2026-03-05', 'yearly', 5), '2027-03-05');
  assert.equal(rec.firstDue('monthly', 10, TODAY), TODAY);
  assert.equal(rec.firstDue('monthly', 5, TODAY), '2026-12-05');
  assert.equal(rec.firstDue('yearly', 5, TODAY, 3), '2027-03-05');
});

test('recurring: add, due, paid, overdue, remove', () => {
  const s = fresh();
  assert.match(send(s, 'recurring rent 25000 monthly on 12').text, /Next due 2026-11-12/);
  assert.match(send(s, 'due').text, /Rent is due 12 Nov \(in 2 days\)/);
  const paid = send(s, 'paid rent');
  assert.match(paid.text, /Next due 2026-12-12/); assert.match(paid.text, /Rent 25000/);
  assert.equal(s.entries[0].amount, 25000);
  assert.equal(send(s, 'due').text, 'Nothing is due soon.');
  s.recurring[0].nextDue = '2026-11-03';
  assert.match(send(s, 'due').text, /7 days ago/);
  assert.equal(send(s, 'recurring rent 25000').ok, false);
  assert.equal(send(s, 'recurring remove school').ok, false);
  assert.match(send(s, 'recurring remove rent').text, /Stopped/);
  assert.match(send(s, 'paid 300 for tea').text, /Recorded ₹300/);
  const item = rec.parseRecurring('recurring LIC 24000 yearly on 5 march remind 7', { today: TODAY, categories: s.categories });
  assert.deepEqual([item.frequency, item.dueDay, item.month, item.remindDays], ['yearly', 5, 3, 7]);
  assert.throws(() => rec.parseRecurring('recurring rent 5000 monthly on 40', { today: TODAY, categories: s.categories }), ParseError);
});

test('recurring: the paid line is read back by the chat importer', () => {
  const s = fresh();
  send(s, 'recurring school fees 12000 quarterly on 12');
  const line = `10/11/26, 9:00 am - Asha: ${rec.paidShareText(s.recurring[0])}`;
  const { rows } = stageImport(fresh(), line);
  assert.deepEqual([rows[0].amount, rows[0].category], [12000, 'School Fees']);
});

// ------------------------------------------------------------------ chat import
const ANDROID = readFileSync(new URL('../../samples/family_chat_android.txt', import.meta.url), 'utf8');
const IPHONE = readFileSync(new URL('../../samples/family_chat_iphone.txt', import.meta.url), 'utf8');
const HINGLISH = readFileSync(new URL('../../samples/family_chat_hinglish.txt', import.meta.url), 'utf8');

test('chat: Android format, multi-line message, system notice skipped', () => {
  const m = parseChat(ANDROID);
  assert.equal(m.length, 16);
  assert.deepEqual([m[1].sender, m[1].text, m[1].date], ['Asha', 'Spent 450 on vegetables', '2026-11-05']);
  assert.equal(m.find((x) => x.text.startsWith('Bought groceries')).text, 'Bought groceries,\nmilk, bread, eggs - 340');
});

test('chat: iPhone format with seconds and brackets', () => {
  const m = parseChat(IPHONE);
  assert.equal(m.length, 4);
  assert.equal(m[0].minuteKey, '2026-11-05 08:45');
});

test('chat: month-first dates are detected', () => {
  const m = parseChat('11/25/26, 9:00 am - A: x 5\n11/26/26, 9:00 am - A: y 6');
  assert.equal(m[0].date, '2026-11-25');
});

test('chat: only listed members count once a family list exists', () => {
  const s = fresh();
  store.addMember(s, { name: 'Asha' });
  const { rows, summary } = stageImport(s, ANDROID);
  assert.equal(rows.every((r) => r.addedBy === 'Asha'), true);
  assert.equal(Object.keys(summary.ignoredSenders).length > 0, true);
});

test('chat: with no family list everyone counts', () => {
  const { rows, summary } = stageImport(fresh(), ANDROID);
  assert.equal(new Set(rows.map((r) => r.addedBy)).size > 1, true);
  assert.deepEqual(summary.ignoredSenders, {});
});

test('chat: times, dates and chatter are not expenses', () => {
  const s = fresh();
  const chat = '05/11/26, 9:00 am - Asha: dinner at 7 pm\n05/11/26, 9:01 am - Asha: PTM on 15/11\n05/11/26, 9:02 am - Asha: <Media omitted>\n05/11/26, 9:03 am - Asha: Spent 450 on vegetables';
  const { rows } = stageImport(s, chat);
  assert.equal(rows.length, 1);
});

test('chat: undo and edit are replayed in order', () => {
  const s = fresh();
  store.addMember(s, { name: 'Asha' }); store.addMember(s, { name: 'Rahul' });
  const chat = `10/11/26, 9:00 am - Asha: Spent 500 on vegetables
10/11/26, 9:05 am - Asha: undo
10/11/26, 9:10 am - Asha: Spent 700 on medicine
10/11/26, 9:12 am - Asha: edit 750
10/11/26, 9:13 am - Rahul: Gift 1000 birthday
10/11/26, 9:14 am - Rahul: edit 1200 clothes
10/11/26, 9:15 am - Rahul: undo
10/11/26, 9:16 am - Rahul: undo
10/11/26, 9:20 am - Asha: Spent 40 on milk`;
  const { rows, summary } = stageImport(s, chat);
  assert.deepEqual(rows.map((r) => [r.addedBy, r.amount, r.category]).sort(), [['Asha', 40, 'Grocery'], ['Asha', 750, 'Medicine']]);
  assert.deepEqual([summary.undone, summary.edited], [2, 2]);
});

test('chat: re-import never duplicates; undo cannot touch already-saved entries', () => {
  const s = fresh();
  const first = '10/11/26, 9:00 am - Asha: Spent 500 on vegetables';
  let { rows } = stageImport(s, first);
  assert.deepEqual(confirmImport(s, rows, new Set([0]), {}, store.pushEntry), { saved: 1, duplicates: 0 });
  ({ rows } = stageImport(s, first));
  assert.equal(rows.length, 0);
  ({ rows } = stageImport(s, first + '\n10/11/26, 9:05 am - Asha: undo'));
  assert.equal(rows.length, 0);
  assert.equal(s.entries.length, 1);
  // overlapping export with seconds (iPhone style) is the same message
  ({ rows } = stageImport(s, '[10/11/26, 9:00:30 AM] Asha: Spent 500 on vegetables'));
  assert.equal(rows.length, 0);
});

test('chat: deleting an imported entry stops it coming back', () => {
  const s = fresh();
  const chat = '10/11/26, 9:00 am - Asha: Spent 500 on vegetables';
  let { rows } = stageImport(s, chat);
  confirmImport(s, rows, new Set([0]), {}, store.pushEntry);
  store.deleteEntry(s, s.entries[0].id, 'Me');
  ({ rows } = stageImport(s, chat));
  assert.equal(rows.length, 0);
});

test('chat: the same text twice in one minute is two entries', () => {
  const { rows } = stageImport(fresh(), '10/11/26, 9:00 am - Asha: tea 20\n10/11/26, 9:00 am - Asha: tea 20');
  assert.equal(rows.length, 2);
  assert.notEqual(rows[0].sourceKey, rows[1].sourceKey);
});

test('chat: category override on review, income stays Income', () => {
  const s = fresh();
  const { rows } = stageImport(s, '10/11/26, 9:00 am - Asha: Spent 450 on random\n10/11/26, 9:01 am - Asha: Income 5000 rent received');
  confirmImport(s, rows, new Set([0, 1]), { 0: 'Gift', 1: 'Gift' }, store.pushEntry);
  const byAmount = Object.fromEntries(s.entries.map((e) => [e.amount, e]));
  assert.equal(byAmount[450].category, 'Gift');
  assert.equal(byAmount[5000].category, 'Income');
});

test('chat: Hinglish export in the real WhatsApp format', () => {
  const s = fresh();
  store.addMember(s, { name: 'Asha' }); store.addMember(s, { name: 'Rahul' });
  const { rows, summary } = stageImport(s, HINGLISH);
  const by = Object.fromEntries(rows.map((r) => [r.description, r]));
  assert.equal(summary.messagesRead, 8);
  assert.equal(by['Dhaniya and mirchi'].category, 'Grocery');
  assert.equal(by['D mart(sweets,oil,soap,milk,honey)'].amount, 2850);
  assert.equal(by['Tyre change'].category, 'Vehicle');
  assert.equal(by['Didi for gift bhaiya Dooj'].category, 'Gift');
  assert.equal(by.Movie.amount, 9000);
  assert.equal(by.Iron, undefined);
});

test('chat: zip export (stored and deflated) is read', async () => {
  const text = 'hello ₹ chat';
  const stored = zipStore([{ name: '_chat.txt', data: text }]);
  assert.equal(await readExport(stored.buffer.slice(stored.byteOffset, stored.byteOffset + stored.byteLength)), text);
  assert.equal(await readExport(new TextEncoder().encode(text).buffer), text);
});

// ------------------------------------------------------------------ storage + backup
test('store: damaged save is kept aside, not overwritten', () => {
  const mem = new Map(); const storage = { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, v) };
  storage.setItem(store.KEY, '{not json');
  const { state, problem } = store.load(storage);
  assert.ok(problem); assert.equal(mem.get(store.KEY + '.damaged'), '{not json'); assert.equal(state.entries.length, 0);
  const s = fresh(); store.addEntry(s, { date: TODAY, amount: 5, category: 'Gift', description: 'x', addedBy: 'A' });
  assert.equal(store.save(storage, s), true);
  assert.equal(store.load(storage).state.entries.length, 1);
});

test('store: member matching by name, chat name and phone', () => {
  const s = fresh();
  store.addMember(s, { name: 'Meera', phone: '98765 43210' });
  store.addMember(s, { name: 'Prabhakar', chatName: 'Prabhakar Rai' });
  assert.equal(store.matchMember('+91 98765 43210', s.members).name, 'Meera');
  assert.equal(store.matchMember('prabhakar rai', s.members).name, 'Prabhakar');
  assert.equal(store.matchMember('Stranger', s.members), null);
  assert.throws(() => store.addMember(s, { name: 'meera' }), /already/);
});

test('excel: workbook builds a zip with sheets', async () => {
  const bytes = entriesWorkbook([{ date: TODAY, type: 'Expense', category: 'Gift', description: '=1+1 <b>', amount: 5, addedBy: 'A' }]);
  assert.equal(bytes[0], 0x50); assert.equal(bytes[1], 0x4b);
  assert.equal(new TextDecoder().decode(bytes).includes('t="inlineStr"'), true);
});

test('dates', () => { assert.equal(addDays('2026-12-31', 1), '2027-01-01'); assert.equal(diffDays('2026-11-12', '2026-11-10'), 2); });

test('chat: a row matching something you typed yourself is flagged as a possible duplicate', () => {
  const s = fresh();
  store.addEntry(s, { date: '2026-11-10', amount: 450, category: 'Grocery', description: 'Vegetables', addedBy: 'Asha' });
  const { rows } = stageImport(s, '10/11/26, 9:00 am - Asha: Spent 450 on vegetables\n10/11/26, 9:05 am - Asha: Spent 99 on milk');
  assert.deepEqual(rows.map((r) => r.maybeDuplicate), [true, false]);
});

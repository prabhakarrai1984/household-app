import test from 'node:test';
import assert from 'node:assert/strict';
import { parseBillLine, parseBill, findBillDate, itemKey, addBill, deleteBill, looksSaved, markFinished,
  analyze, monthlyList, listShareText, toBase, fromBase, formatQty } from '../core/grocery.js';
import { newState } from '../core/store.js';

const TODAY = '2026-11-10';
const fresh = () => newState();
const buy = (s, date, name, qty, unit, price) => addBill(s, { date, lines: [{ name, qty, unit, price }] });

test('bill lines: sizes, counts, rates, serial numbers', () => {
  const L = parseBillLine;
  assert.deepEqual(L('Aashirvaad Atta 5kg 250.00'), { name: 'Aashirvaad Atta', qty: 5, unit: 'kg', price: 250 });
  assert.deepEqual(L('Amul Taaza Milk 500ml 2 28.00 56.00'), { name: 'Amul Taaza Milk', qty: 1000, unit: 'ml', price: 56 });
  assert.deepEqual(L('Onion 2 kg @ 30/kg 60'), { name: 'Onion', qty: 2, unit: 'kg', price: 60 });
  assert.deepEqual(L('Tomato 40'), { name: 'Tomato', qty: null, unit: null, price: 40 });
  assert.deepEqual(L('Eggs 12 pcs 84'), { name: 'Eggs', qty: 12, unit: 'pcs', price: 84 });
  assert.deepEqual(L('3. Dahi 400g 35'), { name: 'Dahi', qty: 400, unit: 'g', price: 35 });
  assert.deepEqual(L('Banana 1 dozen 60'), { name: 'Banana', qty: 12, unit: 'pcs', price: 60 });
  assert.deepEqual(L('2 x 500g Maggi 28'), { name: 'Maggi', qty: 1000, unit: 'g', price: 28 });
  assert.deepEqual(L('Sugar ₹48 1kg'), { name: 'Sugar', qty: 1, unit: 'kg', price: 48 });
});

test('bill lines: totals, tax, headers and numbers-only lines are not items', () => {
  for (const t of ['Total 1234.00', 'Sub Total: 1200', 'CGST 9% 12.00', 'Delivery charges 30', 'Invoice No 99812', 'Thank you, visit again',
    '12345.00', '----------', 'GSTIN 27AAAPL1234C1ZV', 'Paid via UPI', 'Items: 12', '']) assert.equal(parseBillLine(t), null, t);
  assert.notEqual(parseBillLine('Cashew nuts 250g 180'), null);       // "cash" is not a word here
  assert.notEqual(parseBillLine('Dates 500g 120'), null);
});

test('whole bill: date found, junk skipped, items listed', () => {
  const text = `BIG MART
Invoice No 4412   Date: 05/11/2026
1. Aashirvaad Atta 5kg 250.00
2. Amul Taaza Milk 500ml 2 28.00 56.00
3. Onion 2 kg 60
Sub Total 366.00
CGST 9% 0.00
Total 366.00`;
  const b = parseBill(text, { today: TODAY });
  assert.equal(b.date, '2026-11-05');
  assert.deepEqual(b.lines.map((l) => l.name), ['Aashirvaad Atta', 'Amul Taaza Milk', 'Onion']);
  assert.ok(b.skipped.length >= 4);
  assert.equal(findBillDate('no date here', TODAY), TODAY);
  assert.equal(findBillDate('12 Nov 2026', TODAY), '2026-11-12');
  assert.equal(findBillDate('Date 31/02/2026', TODAY), TODAY);          // not a real day
});

test('item keys: brands, plurals and Hindi names collapse to one item', () => {
  assert.equal(itemKey('Aashirvaad Atta'), 'atta'); assert.equal(itemKey('aata'), 'atta');
  assert.equal(itemKey('Amul Taaza Toned Milk'), 'milk'); assert.equal(itemKey('doodh'), 'milk');
  assert.equal(itemKey('Fortune Sunflower Oil'), 'oil'); assert.equal(itemKey('Tomatoes'), 'tomato');
  assert.equal(itemKey('Fresh Bananas'), 'banana'); assert.equal(itemKey('Parle-G Biscuits'), 'biscuit');
  assert.equal(itemKey('Kurkure Masala Munch'), 'kurkure masala munch');
});

test('units convert to g / ml / pcs and back', () => {
  assert.deepEqual(toBase(5, 'kg'), { qty: 5000, unit: 'g' }); assert.deepEqual(toBase(1.5, 'l'), { qty: 1500, unit: 'ml' });
  assert.deepEqual(toBase(1, 'dozen'), { qty: 12, unit: 'pcs' }); assert.deepEqual(toBase(null, 'kg'), { qty: null, unit: null });
  assert.deepEqual(fromBase(5000, 'g'), { qty: 5, unit: 'kg' }); assert.equal(formatQty(250, 'g'), '250 g'); assert.equal(formatQty(1500, 'ml'), '1.5 L');
});

test('saving a bill: items stored in base units, delete removes them', () => {
  const s = fresh();
  const bill = addBill(s, { date: '2026-11-05', store: 'Big Mart', lines: [
    { name: 'aashirvaad atta', qty: 5, unit: 'kg', price: 250 }, { name: 'Tomato', qty: '', unit: '', price: 40 }] });
  assert.deepEqual([bill.total, bill.count, s.purchases[0].qty, s.purchases[0].unit, s.purchases[0].key], [290, 2, 5000, 'g', 'atta']);
  assert.equal(looksSaved(s, '2026-11-05', [{ name: 'x', price: 250 }, { name: 'y', price: 40 }]), true);
  assert.throws(() => addBill(s, { date: '', lines: [{ name: 'a' }] }), /date/);
  assert.throws(() => addBill(s, { date: TODAY, lines: [] }), /no items/);
  assert.throws(() => addBill(s, { date: TODAY, lines: [{ name: 'a', qty: -1, unit: 'kg' }] }), /above zero/);
  deleteBill(s, bill.id); assert.equal(s.purchases.length, 0); assert.equal(s.bills.length, 0);
});

test('consumption: days between purchases, rate, usual vs fast vs slow', () => {
  const s = fresh();
  buy(s, '2026-08-01', 'Atta', 5, 'kg', 250); buy(s, '2026-08-26', 'Atta', 5, 'kg', 250);   // 25 days
  let a = analyze(s, '2026-08-27', 4)[0];
  assert.equal(a.status, 'learning'); assert.equal(a.intervals[0].days, 25); assert.equal(Math.round(a.perDay), 200);
  buy(s, '2026-09-20', 'Atta', 5, 'kg', 250);                                               // 25 days again
  a = analyze(s, '2026-09-21', 4)[0]; assert.equal(a.status, 'normal'); assert.match(a.message, /about the usual 25/);
  buy(s, '2026-10-08', 'Atta', 5, 'kg', 250);                                               // only 18 days: faster
  a = analyze(s, '2026-10-09', 4)[0]; assert.equal(a.status, 'fast'); assert.match(a.message, /Lasted 18 days.*usually lasts about 25/);
  assert.match(a.message, /topped up/);
  buy(s, '2026-11-30', 'Atta', 5, 'kg', 250);                                               // 53 days: slow
  a = analyze(s, '2026-11-30', 4)[0]; assert.equal(a.status, 'slow');
});

test('consumption: quantity matters, not just the gap', () => {
  const s = fresh();
  buy(s, '2026-08-01', 'Sugar', 1, 'kg', 48); buy(s, '2026-08-21', 'Sugar', 1, 'kg', 48);   // 1kg / 20 days
  buy(s, '2026-09-10', 'Sugar', 1, 'kg', 48); buy(s, '2026-09-30', 'Sugar', 2, 'kg', 96);   // same gap
  buy(s, '2026-10-20', 'Sugar', 1, 'kg', 48);                                               // 2kg in 20 days = double rate
  const a = analyze(s, '2026-10-21', 4)[0];
  assert.equal(a.status, 'fast'); assert.match(a.message, /faster than usual/);
});

test('consumption: a "finished" tap makes the gap exact', () => {
  const s = fresh();
  buy(s, '2026-10-01', 'Oil', 1, 'l', 150); buy(s, '2026-10-30', 'Oil', 1, 'l', 150);
  markFinished(s, 'oil', '2026-10-20');                                                     // ran out 10 days before restocking
  const a = analyze(s, '2026-10-31', 4)[0];
  assert.equal(a.intervals[0].days, 19); assert.equal(a.intervals[0].finished, true);
});

test('consumption: compared with a rough per-person guide', () => {
  const s = fresh();
  buy(s, '2026-09-01', 'Oil', 1, 'l', 150); buy(s, '2026-09-11', 'Oil', 1, 'l', 150);       // 100 ml/day
  assert.match(analyze(s, '2026-09-12', 2)[0].note, /50 ml per person per day.*high side/);  // 2 people
  assert.equal(analyze(s, '2026-09-12', 6)[0].note, '');                                     // 6 people: ~17 ml, fine
});

test('stock left: estimated from the usual rate, zero after "finished"', () => {
  const s = fresh();
  buy(s, '2026-08-01', 'Atta', 5, 'kg', 250); buy(s, '2026-08-26', 'Atta', 5, 'kg', 250);   // 200 g/day
  let a = analyze(s, '2026-09-05', 4)[0];                                                    // 10 days after last buy
  assert.equal(Math.round(a.remaining), 3000); assert.equal(Math.round(a.daysLeft), 15);
  markFinished(s, 'atta', '2026-09-06');
  a = analyze(s, '2026-09-07', 4)[0]; assert.equal(a.remaining, 0);
});

test('monthly list: usual rate x 30 days minus what is left, in pack sizes', () => {
  const s = fresh();
  buy(s, '2026-08-01', 'Atta', 5, 'kg', 250); buy(s, '2026-08-26', 'Atta', 5, 'kg', 250);   // 200 g/day -> 6 kg a month
  buy(s, '2026-09-20', 'Atta', 5, 'kg', 250);
  buy(s, '2026-10-01', 'Salt', 1, 'kg', 20);                                                  // bought once: not enough data
  const list = monthlyList(s, '2026-10-15', { people: 4 });
  const atta = list.items.find((i) => i.key === 'atta');
  assert.ok(atta); assert.equal(atta.unit, 'g'); assert.equal(atta.qty % 5000, 0); assert.ok(atta.qty >= 5000);
  assert.ok(list.needMoreData.includes('Salt'));
  assert.equal(list.items.some((i) => i.key === 'salt'), false);
  assert.ok(list.estimate > 0);
  const text = listShareText(list, '2026-10-15');
  assert.match(text, /☐ Atta – \d+ kg/); assert.match(text, /Estimated cost/);
});

test('monthly list: nothing needed when well stocked, old items ignored', () => {
  const s = fresh();
  buy(s, '2026-08-01', 'Rice', 5, 'kg', 400); buy(s, '2026-09-01', 'Rice', 5, 'kg', 400);   // ~161 g/day
  buy(s, '2026-11-09', 'Rice', 25, 'kg', 2000);                                              // just bought a big sack
  assert.equal(monthlyList(s, '2026-11-10').items.length, 0);
  const old = fresh(); buy(old, '2025-01-01', 'Atta', 5, 'kg', 250); buy(old, '2025-02-01', 'Atta', 5, 'kg', 250);
  assert.equal(monthlyList(old, TODAY).items.length, 0);                                     // not bought for ages
});

test('items without quantities still learn how often they are bought', () => {
  const s = fresh();
  for (const d of ['2026-09-01', '2026-09-15', '2026-09-29', '2026-10-13']) buy(s, d, 'Tomato', '', '', 40);
  const a = analyze(s, '2026-10-25', 4)[0];
  assert.equal(a.medianDays, 14); assert.equal(a.perDay, null);
  const item = monthlyList(s, '2026-10-25').items.find((i) => i.key === 'tomato');
  assert.ok(item); assert.equal(item.qty, null);
});

test('DMart-style tax invoice: reads only the item table, keeps household items too, ignores the address number', () => {
  const text = [
    'INVOICE DATE: 25/10/26  CUSTOMER NAME: Someone', 'ORDER DATE: 24/10/26', 'DELIVERY ADDRESS: 381, Villa, Pune 412207', 'TOTAL ITEMS: 3',
    '1.  08023200  2  Bazana Walnut Kernels 250g   2.0   352.00   704.00',
    '2.  33061020  2  Colgate Strawberry Flavor Tp-40G   1.0   93.00   93.00',
    '3.  10063020  2  Daawat Premium Rice 5Kgs   2.0   545.00   1,090.00',
    'Sub Total 1,887.00',
  ].join('\n');
  const r = parseBill(text, { today: '2026-11-11' });
  assert.equal(r.date, '2026-10-25');                      // the invoice date, not the order date
  assert.equal(r.lines.length, 3);                         // toothpaste counts too: it is part of the household
  assert.deepEqual([r.lines[0].name, r.lines[0].qty, r.lines[0].unit, r.lines[0].price], ['Bazana Walnut Kernels', 500, 'g', 704]);
  assert.deepEqual([r.lines[2].name, r.lines[2].qty, r.lines[2].unit, r.lines[2].price], ['Daawat Premium Rice', 10, 'kg', 1090]);
  // the same table printed twice (second copy in another order, one-decimal prices) counts once
  const twice = text.replace('TOTAL ITEMS: 3', 'TOTAL ITEMS: 3') + '\n' + [
    '1.  10063020  2  Daawat Premium Rice 5Kgs   2.0   545.0   1090.0', '2.  08023200  2  Bazana Walnut Kernels 250g   2.0   352.0   704.0', '3.  33061020  2  Colgate Strawberry Flavor Tp-40G   1.0   93.0   93.0'].join('\n');
  assert.equal(parseBill(twice, { today: '2026-11-11' }).lines.length, 3);
});

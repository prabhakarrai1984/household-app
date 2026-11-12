import test from 'node:test';
import assert from 'node:assert/strict';
import { parsePrescription, parseSchedule, addPrescription, dosesOn, markTaken, buildIcs, mealTimeFor, clock, peopleWithMeds, stopMed } from '../core/medicine.js';
import { newState } from '../core/store.js';

const RX = `Dr. Sharma MBBS
Date 12/11/2026
1. Tab. Metformin 500mg  1-0-1 after food x 30 days
2. Tab Paracetamol 650 mg TDS after meals for 5 days
3. Cap Omeprazole 20mg OD before breakfast
Syp. Cough Relief 5ml twice daily after breakfast and dinner x 1 week
Tab Vitamin D3 60000 IU once a week
Tab Cetirizine 10mg HS x 5 days
Tab. Dolo 650 SOS if fever
Tab Atorvastatin 10 mg
1-0-0 after dinner
Advice: drink water`;

test('prescription lines become medicines with times, relation and days', () => {
  const { items } = parsePrescription(RX);
  const by = (n) => items.find((i) => i.name.startsWith(n));
  assert.equal(items.length, 8);
  assert.deepEqual(by('Metformin').slots.map((s) => s.meal), ['breakfast', 'dinner']);
  assert.equal(by('Metformin').relation, 'after'); assert.equal(by('Metformin').days, 30);
  assert.deepEqual(by('Paracetamol').slots.map((s) => s.meal), ['breakfast', 'lunch', 'dinner']); assert.equal(by('Paracetamol').days, 5);
  assert.equal(by('Omeprazole').relation, 'before'); assert.deepEqual(by('Omeprazole').slots.map((s) => s.meal), ['breakfast']);
  assert.deepEqual(by('Cough').slots.map((s) => s.meal), ['breakfast', 'dinner']); assert.equal(by('Cough').days, 7);
  assert.deepEqual(by('Cetirizine').slots.map((s) => s.meal), ['bedtime']);
  assert.equal(by('Dolo').asNeeded, true); assert.equal(by('Dolo').slots.length, 0);
  assert.deepEqual(by('Atorvastatin').slots.map((s) => s.meal), ['dinner']);   // directions on the next line
  assert.equal(by('Vitamin D3').slots.length, 0); assert.match(by('Vitamin D3').flags[0], /not a daily/);   // weekly is not guessed
});
test('post breakfast / lunch / dinner, Hinglish, and quantities', () => {
  const s = parseSchedule('3 times a day post breakfast, post lunch and post dinner');
  assert.deepEqual(s.slots.map((x) => x.meal), ['breakfast', 'lunch', 'dinner']); assert.equal(s.relation, 'after');
  assert.deepEqual(parseSchedule('subah aur raat khane ke baad').slots.map((x) => x.meal), ['breakfast', 'dinner']);
  const two = parseSchedule('2-0-1 after food');
  assert.deepEqual(two.slots.map((x) => [x.meal, x.qty]), [['breakfast', 2], ['dinner', 1]]);
});

test('doses are due 5 minutes before each meal, per person, with their own meal times', () => {
  const st = newState();
  addPrescription(st, { person: 'Papa', date: '2026-11-12', items: [{ name: 'Metformin 500mg', slots: [{ meal: 'breakfast' }, { meal: 'dinner' }], relation: 'after', days: 3 }] });
  addPrescription(st, { person: 'Aarav', date: '2026-11-12', items: [{ name: 'Syrup', slots: [{ meal: 'lunch' }], relation: 'after', days: null }] });
  st.settings.mealTimesBy.Papa = { breakfast: '07:30' };
  let d = dosesOn(st, '2026-11-12');
  assert.deepEqual(d.map((x) => [x.person, x.remindAt]), [['Papa', '07:25'], ['Aarav', '13:25'], ['Papa', '20:25']]);
  assert.equal(dosesOn(st, '2026-11-14').length, 3);          // day 3 of 3 for Papa, Aarav ongoing
  assert.equal(dosesOn(st, '2026-11-15').length, 1);          // Papa's course is over
  assert.equal(dosesOn(st, '2026-11-11').length, 0);          // not started
  markTaken(st, d[0].key); assert.equal(dosesOn(st, '2026-11-12')[0].taken, true);
  assert.equal(clock(-5), '23:55');
  assert.deepEqual(peopleWithMeds(st), ['Aarav', 'Papa']); stopMed(st, st.meds[1].id); assert.deepEqual(peopleWithMeds(st), ['Papa']);
});
test('saving needs a person and a time', () => {
  const st = newState();
  assert.throws(() => addPrescription(st, { person: '', date: '2026-11-12', items: [{ name: 'X', slots: [{ meal: 'lunch' }] }] }), /who/);
  assert.throws(() => addPrescription(st, { person: 'A', date: '2026-11-12', items: [{ name: 'X', slots: [] }] }), /pick at least one time/);
  assert.equal(addPrescription(st, { person: 'A', date: '2026-11-12', items: [{ name: 'X', slots: [], asNeeded: true }] }).length, 1);
});
test('calendar file: one repeating event per person and meal, alarm at the reminder time', () => {
  const st = newState();
  addPrescription(st, { person: 'Papa', date: '2026-11-12', items: [
    { name: 'Metformin 500mg', slots: [{ meal: 'breakfast' }, { meal: 'dinner' }], relation: 'after', days: 30 },
    { name: 'Aspirin', slots: [{ meal: 'breakfast' }], relation: 'after', days: 30 }, { name: 'Dolo', slots: [], asNeeded: true }] });
  const { text, events } = buildIcs(st, '2026-11-12');
  assert.equal(events, 2);                                    // breakfast (two tablets together) + dinner
  assert.match(text, /DTSTART:20261112T082500/); assert.match(text, /DTSTART:20261112T202500/);
  assert.match(text, /RRULE:FREQ=DAILY;COUNT=30/); assert.match(text, /TRIGGER:PT0M/);
  assert.match(text, /Metformin 500mg\\, Aspirin/); assert.ok(!/Dolo/.test(text));
  assert.ok(text.split('\r\n').every((l) => new TextEncoder().encode(l).length <= 75));
  assert.equal(buildIcs(st, '2026-11-12', { person: 'Nobody' }).events, 0);
  assert.equal(buildIcs(st, '2026-12-20').events, 0);         // course already finished
  assert.match(buildIcs(st, '2026-11-20').text, /COUNT=22/);   // 22 days left on 20 Nov
  st.settings.remindLead = 10; assert.match(buildIcs(st, '2026-11-12').text, /DTSTART:20261112T082000/);
  assert.equal(mealTimeFor(st, 'Papa', 'lunch'), '13:30');
});

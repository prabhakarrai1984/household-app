// Medicines: read a prescription's text into lines the person confirms, then work out WHEN each dose is due
// from the usual meal times, per family member. Reminders go out `remindLead` minutes before the meal.
// This is a reminder aid. It never replaces what the doctor or pharmacist said, and every line is checked by a person.
import { addDays, diffDays } from './dates.js';

export const MEALS = ['breakfast', 'lunch', 'dinner', 'bedtime'];
export const MEAL_LABEL = { breakfast: 'breakfast', lunch: 'lunch', dinner: 'dinner', bedtime: 'bedtime' };
export const REL_TEXT = { before: 'before', after: 'after', with: 'with', any: 'at' };
export const DEFAULT_TIMES = { breakfast: '08:30', lunch: '13:30', dinner: '20:30', bedtime: '22:00' };

const FORM = '(?:tab(?:let)?s?|cap(?:sule)?s?|syp|syrup|susp(?:ension)?|inj(?:ection)?|drops?|oint(?:ment)?|cream|gel|lotion|powder|sachet|inhaler|spray)';
const FORM_START = new RegExp(`^\\s*(?:\\d{1,2}\\s*[.)]\\s*)?(${FORM})\\b\\.?\\s*`, 'i');
const DIGIT_PATTERN = /(?<![\d./:])([0-3](?:\.5)?|½)\s*[-–—]\s*([0-3](?:\.5)?|½)\s*[-–—]\s*([0-3](?:\.5)?|½)(?:\s*[-–—]\s*([0-3](?:\.5)?|½))?(?![\d/:])/;
const MEAL_WORDS = [
  ['breakfast', /\b(breakfast|bkfast|nashta|nashte|subah|morning)\b/i], ['lunch', /\b(lunch|dopahar|afternoon|noon)\b/i],
  ['dinner', /\b(dinner|supper|raat|night|evening)\b/i], ['bedtime', /\b(bed\s?time|at bed|before sleep|sleeping|sone se pehle)\b|\bhs\b/i],
];
const BEFORE = /\b(before|b\/f|bbf|a\.?c\.?|ante cibum|empty stomach|khali pet|khane se pehle|pehle)\b/i;
const AFTER = /\b(after|a\/f|p\.?c\.?|post|khane ke baad|baad)\b/i;
const WITH = /\b(with (?:food|meals?|breakfast|lunch|dinner)|during meals?)\b/i;
const DURATION = /(?:\bx|×|\bfor|\bfor next|\bnext)?\s*(\d{1,3})\s*(days?|d|weeks?|wks?|months?)\b/i;
const FREQ_WORDS = /\b(od|qd|bd|bid|bds|tds|tid|tid|qid|qds|hs|sos|prn|once|twice|thrice|daily|every\s+\d+\s*(?:hours?|hrs?)|\d\s*(?:times|x)\s*(?:a|per)?\s*day|q\d+h)\b/i;

const FRACTION = (v) => (v === '½' ? 0.5 : Number(v));
const cleanName = (t) => t.replace(/\s+/g, ' ').replace(/^[\s\-–:.,;|]+|[\s\-–:.,;|(]+$/g, '').trim();

/** The schedule words in one medicine's text -> {slots:[{meal,qty}], relation, days, asNeeded, flags}. */
export function parseSchedule(text) {
  const t = String(text || '');
  const flags = [];
  let slots = [];
  let asNeeded = /\b(sos|prn|if needed|when needed|as needed|jarurat)\b/i.test(t);

  // explicit meal words win: "after breakfast and dinner", "subah aur raat"
  const named = MEAL_WORDS.filter(([, re]) => re.test(t)).map(([m]) => m);
  const dm = DIGIT_PATTERN.exec(t);
  const perSlot = dm ? [dm[1], dm[2], dm[3], dm[4]].map((v) => (v == null ? 0 : FRACTION(v))) : null;

  if (named.length && !(dm && named.length < perSlot.filter((q) => q > 0).length)) {
    slots = named.map((m) => ({ meal: m, qty: 1 }));
    if (dm && named.length === perSlot.filter((q) => q > 0).length) { let i = 0; for (const q of perSlot) if (q > 0) slots[i++].qty = q; }
  } else if (dm) {
    const order = perSlot[3] != null && dm[4] != null ? ['breakfast', 'lunch', 'dinner', 'bedtime'] : ['breakfast', 'lunch', 'dinner'];
    order.forEach((m, i) => { if (perSlot[i] > 0) slots.push({ meal: m, qty: perSlot[i] }); });
  } else {
    const every = /every\s+(\d+)\s*(?:hours?|hrs?)|\bq(\d+)h\b/i.exec(t);
    if (/\b(qid|qds)\b|\b4\s*(?:times|x)\b/i.test(t)) slots = ['breakfast', 'lunch', 'dinner', 'bedtime'].map((meal) => ({ meal, qty: 1 }));
    else if (/\b(tds|tid|thrice)\b|\b3\s*(?:times|x)\b/i.test(t)) slots = ['breakfast', 'lunch', 'dinner'].map((meal) => ({ meal, qty: 1 }));
    else if (/\b(bd|bid|bds|twice)\b|\b2\s*(?:times|x)\b/i.test(t)) slots = ['breakfast', 'dinner'].map((meal) => ({ meal, qty: 1 }));
    else if (/\b(od|qd|once)\b|\b1\s*(?:time|x)\b|\bdaily\b/i.test(t)) slots = [{ meal: 'breakfast', qty: 1 }];
    else if (every) {
      const h = Number(every[1] || every[2]);
      const n = h <= 6 ? 4 : h <= 8 ? 3 : 2;
      slots = (n === 4 ? ['breakfast', 'lunch', 'dinner', 'bedtime'] : n === 3 ? ['breakfast', 'lunch', 'dinner'] : ['breakfast', 'dinner']).map((meal) => ({ meal, qty: 1 }));
      flags.push(`"every ${h} hours" was turned into ${n} meal-time doses. Check it.`);
    }
  }
  if (/\b(once\s+(?:a|per|every)\s+week|weekly|every\s+week|alternate\s+days?|every\s+other\s+day)\b/i.test(t)) { slots = []; flags.push('This is not a daily medicine (weekly or alternate days). Reminders here repeat daily, so choose the times yourself or mark it "only if needed".'); }
  if (!slots.length && !asNeeded && !flags.length) flags.push('I could not tell when to take it. Pick the times below.');
  if (asNeeded) slots = [];

  let relation = 'any';
  if (WITH.test(t)) relation = 'with';
  else if (BEFORE.test(t) && !/\bbefore sleep/i.test(t)) relation = 'before';
  else if (AFTER.test(t)) relation = 'after';

  let days = null;
  const d = DURATION.exec(t.replace(DIGIT_PATTERN, ' '));
  if (d) { const n = Number(d[1]); const u = d[2].toLowerCase(); days = u.startsWith('w') ? n * 7 : u.startsWith('m') ? n * 30 : n; if (days > 365) days = null; }
  return { slots, relation, days, asNeeded, flags };
}

/** Prescription text -> {items, skipped}. One item per medicine, the person confirms each. */
export function parsePrescription(text) {
  const lines = String(text || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const blocks = [];
  for (const line of lines) {
    const starts = FORM_START.test(line);
    const hasSched = FREQ_WORDS.test(line) || DIGIT_PATTERN.test(line) || /\b(after|before)\s+(food|meal|breakfast|lunch|dinner)/i.test(line);
    if (starts || (hasSched && !blocks.length) || (hasSched && blocks.at(-1)?.sched && /[A-Za-z]{4,}\s/.test(line.replace(FREQ_WORDS, '')) && !blocks.at(-1)?.open)) {
      blocks.push({ lines: [line], sched: hasSched, open: !hasSched });
    } else if (blocks.length && (hasSched || DURATION.test(line) || /\b(food|meal|tablet|water|continue)\b/i.test(line))) {
      blocks.at(-1).lines.push(line); if (hasSched) { blocks.at(-1).sched = true; blocks.at(-1).open = false; }
    }
  }
  const items = [], skipped = [];
  for (const b of blocks) {
    const all = b.lines.join(' ');
    if (!b.sched) { skipped.push(b.lines[0]); continue; }
    const sched = parseSchedule(all);
    const first = b.lines[0];
    const fm = FORM_START.exec(first);
    let nameText = first.replace(FORM_START, ' ');
    nameText = nameText.replace(DIGIT_PATTERN, ' ').replace(/\s*(?:x|×|for)?\s*\d{1,3}\s*(?:days?|weeks?|wks?|months?)\b/gi, ' ');
    const cut = nameText.search(new RegExp(`\\b(?:${FREQ_WORDS.source.slice(2, -2)}|after|before|with food|with meals|morning|night|subah|raat|dopahar|breakfast|lunch|dinner)\\b`, 'i'));
    const name = cleanName(cut > 0 ? nameText.slice(0, cut) : nameText);
    if (name.replace(/[^A-Za-z]/g, '').length < 2) { skipped.push(first); continue; }
    items.push({ form: fm ? fm[1].toLowerCase().replace(/s$/, '') : '', name, ...sched, raw: all });
  }
  return { items, skipped };
}

// ------------------------------------------------------------------ schedule

const mins = (hhmm) => { const [h, m] = String(hhmm).split(':').map(Number); return h * 60 + m; };
export const clock = (n) => { n = ((n % 1440) + 1440) % 1440; return `${String(Math.floor(n / 60)).padStart(2, '0')}:${String(n % 60).padStart(2, '0')}`; };
export const prettyTime = (hhmm) => { const [h, m] = hhmm.split(':').map(Number); return `${h % 12 || 12}:${String(m).padStart(2, '0')} ${h < 12 ? 'am' : 'pm'}`; };

export function mealTimeFor(state, person, meal) {
  const by = state.settings.mealTimesBy?.[person] || {};
  return by[meal] || state.settings.mealTimes?.[meal] || DEFAULT_TIMES[meal];
}
export const leadOf = (state) => Math.max(0, Math.min(60, Number(state.settings.remindLead ?? 5)));

export function addPrescription(state, { person, date, doctor = '', items }) {
  if (!String(person || '').trim()) throw new Error('Choose who these medicines are for.');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '')) throw new Error('Pick the start date.');
  const good = (items || []).filter((i) => String(i.name || '').trim());
  if (!good.length) throw new Error('There are no medicines to save.');
  const added = [];
  for (const i of good) {
    const slots = (i.slots || []).filter((s) => MEALS.includes(s.meal)).map((s) => ({ meal: s.meal, qty: Number(s.qty) > 0 ? Number(s.qty) : 1 }));
    if (!slots.length && !i.asNeeded) throw new Error(`${i.name}: pick at least one time, or mark it "only if needed".`);
    const days = i.days === '' || i.days == null ? null : Math.round(Number(i.days));
    if (days !== null && !(days >= 1)) throw new Error(`${i.name}: the number of days must be 1 or more.`);
    const med = { id: state.nextId++, person: person.trim(), name: String(i.name).trim(), form: i.form || '', slots, relation: i.relation || 'any', start: date, days, asNeeded: !!i.asNeeded, doctor: doctor.trim(), active: true };
    state.meds.push(med); added.push(med);
  }
  return added;
}
export const stopMed = (state, id) => { const m = state.meds.find((x) => x.id === id); if (m) m.active = false; };
export const deleteMed = (state, id) => { state.meds = state.meds.filter((m) => m.id !== id); for (const k of Object.keys(state.doseLog)) if (k.startsWith(id + '|')) delete state.doseLog[k]; };
export const medEnd = (m) => (m.days ? addDays(m.start, m.days - 1) : null);
export const isRunningOn = (m, date) => m.active && date >= m.start && (!m.days || date <= medEnd(m));

/** Every dose due on `date`, earliest first: {key, med, person, meal, relation, qty, mealTime, remindAt, taken}. */
export function dosesOn(state, date) {
  const lead = leadOf(state), out = [];
  for (const med of state.meds) {
    if (!isRunningOn(med, date)) continue;
    for (const s of med.slots) {
      const mealTime = mealTimeFor(state, med.person, s.meal);
      const key = `${med.id}|${date}|${s.meal}`;
      out.push({ key, med, person: med.person, meal: s.meal, relation: med.relation, qty: s.qty, mealTime, remindAt: clock(mins(mealTime) - lead), taken: !!state.doseLog[key] });
    }
  }
  return out.sort((a, b) => a.remindAt.localeCompare(b.remindAt) || a.person.localeCompare(b.person) || a.med.name.localeCompare(b.med.name));
}
export const markTaken = (state, key, taken = true) => { if (taken) state.doseLog[key] = new Date().toISOString(); else delete state.doseLog[key]; };
export const doseWords = (d) => `${REL_TEXT[d.relation] || 'at'} ${MEAL_LABEL[d.meal]}`;
export const doseLine = (d) => `${d.med.name}${d.qty !== 1 ? ` × ${d.qty}` : ''}`;
/** People who have medicines, for the family picker. */
export const peopleWithMeds = (state) => [...new Set(state.meds.filter((m) => m.active).map((m) => m.person))].sort();

// ------------------------------------------------------------------ phone calendar file (.ics)

const esc = (t) => String(t).replace(/\\/g, '\\\\').replace(/;/g, '\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
function fold(line) {   // calendar lines are limited to 75 BYTES; emoji and bullets take several
  const enc = new TextEncoder(), out = []; let cur = '', size = 0;
  for (const ch of line) {
    const n = enc.encode(ch).length;
    if (size + n > (out.length ? 74 : 75)) { out.push(cur); cur = ''; size = 0; }
    cur += ch; size += n;
  }
  out.push(cur); return out.map((l, i) => (i ? ' ' + l : l)).join('\r\n');
}
const stamp = (date, hhmm) => `${date.replace(/-/g, '')}T${hhmm.replace(':', '')}00`;
function hash(s) { let h = 5381; for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0; return h.toString(36); }

/**
 * A calendar file whose events repeat daily and ring `remindLead` minutes before each meal.
 * Medicines for the same person, meal and last day share one event, so there is one alarm per meal, not one per tablet.
 * Open-ended medicines are written for `openDays` days; export again to extend.
 */
export function buildIcs(state, today, { person = null, openDays = 30 } = {}) {
  const lead = leadOf(state), groups = new Map();
  for (const med of state.meds) {
    if (!med.active || med.asNeeded || (person && med.person !== person)) continue;
    const startDay = med.start > today ? med.start : today;
    const left = med.days ? diffDays(medEnd(med), startDay) + 1 : openDays;
    if (left < 1) continue;
    for (const s of med.slots) {
      const k = [med.person, s.meal, startDay, left, med.relation].join('|');
      (groups.get(k) || groups.set(k, { person: med.person, meal: s.meal, startDay, left, relation: med.relation, meds: [] }).get(k)).meds.push({ med, qty: s.qty });
    }
  }
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Household App//Medicines//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH', 'X-WR-CALNAME:Medicines'];
  for (const g of groups.values()) {
    const mealTime = mealTimeFor(state, g.person, g.meal), at = clock(mins(mealTime) - lead);
    const names = g.meds.map((m) => `${m.med.name}${m.qty !== 1 ? ` x${m.qty}` : ''}`);
    const title = `💊 ${g.person}: ${REL_TEXT[g.relation]} ${MEAL_LABEL[g.meal]} - ${names.length > 2 ? `${names.slice(0, 2).join(', ')} +${names.length - 2}` : names.join(', ')}`;
    const desc = `${g.person} - ${REL_TEXT[g.relation]} ${MEAL_LABEL[g.meal]} (usually ${prettyTime(mealTime)})\n${names.map((n) => '• ' + n).join('\n')}\nReminder aid only. Follow your doctor's instructions.`;
    const uid = `med-${hash(g.person + g.meal + g.relation + names.join())}-${g.startDay}-${g.left}@household-app`;
    lines.push('BEGIN:VEVENT', `UID:${uid}`, `DTSTAMP:${stamp(today, '0000')}`, `DTSTART:${stamp(g.startDay, at)}`, `DTEND:${stamp(g.startDay, clock(mins(at) + 10))}`,
      `RRULE:FREQ=DAILY;COUNT=${g.left}`, fold(`SUMMARY:${esc(title)}`), fold(`DESCRIPTION:${esc(desc)}`),
      'BEGIN:VALARM', 'ACTION:DISPLAY', fold(`DESCRIPTION:${esc(title)}`), 'TRIGGER:PT0M', 'END:VALARM', 'END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  return { text: lines.join('\r\n') + '\r\n', events: groups.size };
}

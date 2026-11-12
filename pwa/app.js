// Household App - screens. All data stays on this phone (localStorage); there is no server.
import { escapeHtml as esc, inr } from './core/format.js';
import { localToday, niceDate, shortDate } from './core/dates.js';
import { UNCATEGORIZED, INCOME } from './core/parser.js';
import * as store from './core/store.js';
import * as rec from './core/recurring.js';
import { PERIODS, TYPES, buildReport, filterEntries, monthOverview, newestFirst, totalExpenses } from './core/reports.js';
import { handleMessage } from './core/service.js';
import { readExport, stageImport, confirmImport } from './core/chat.js';
import { ENTRY_HEADER, entriesWorkbook, entryRow } from './core/xlsx.js';
import * as grocery from './core/grocery.js';
import * as food from './core/food.js';
import { scanBill } from './ocr.js';
import { readPdf } from './pdfbill.js';
import * as med from './core/medicine.js';

export const VERSION = 'Build 7 · 2026-11-12 · medicines & reminders';   // build 1 Kitchen, 2 PDF upload, 3 DMart invoice, 4 non-food kept, 5 update button, 6 stock board and roomy bill lines, 7 medicines. Add 1 on every change.
const loaded = store.load(window.localStorage);
let state = loaded.state;
const ui = { rx: null, rxText: '', rxOcr: '', bill: null, billText: '', ocr: '', reply: null, report: { period: 'month' }, search: '', limit: 60, staged: null, install: null };
const today = () => localToday();
const me = () => state.settings.me || 'Me';
const $ = (sel) => document.querySelector(sel);

function persist() {
  if (!store.save(window.localStorage, state)) toast('Could not save on this phone (storage full or blocked). Download a backup.');
}
let toastTimer;
function toast(text) {
  const el = $('#toast'); el.textContent = text; el.classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => el.classList.remove('show'), 3500);
}
const options = (list, selected) => list.map((o) => {
  const [v, t] = Array.isArray(o) ? o : [o, o];
  return `<option value="${esc(v)}" ${v === selected ? 'selected' : ''}>${esc(t)}</option>`;
}).join('');
const catList = () => store.allCategoryNames(state);

function download(name, data, mime) {
  const url = URL.createObjectURL(new Blob([data], { type: mime }));
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 2000);
}
async function shareText(text) {
  if (navigator.share) { try { await navigator.share({ text }); return; } catch (e) { if (e.name === 'AbortError') return; } }
  window.open('https://wa.me/?text=' + encodeURIComponent(text), '_blank', 'noopener');
}
const csvCell = (v) => { let s = String(v ?? ''); if (/^[=+\-@]/.test(s) && typeof v !== 'number') s = "'" + s; return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
const toCsv = (rows) => '﻿' + rows.map((r) => r.map(csvCell).join(',')).join('\r\n');

// ------------------------------------------------------------------ shared pieces

function entryRowHtml(e) {
  return `<div class="item" data-act="edit-entry" data-id="${e.id}">
    <div class="l"><div class="t">${esc(e.description || e.category)}</div>
      <div class="muted">${niceDate(e.date)} · ${esc(e.category)} · ${esc(e.addedBy)}${e.sourceKey ? '<span class="tag">chat</span>' : ''}</div></div>
    <div class="r ${e.type === 'Income' ? 'in' : ''}">${e.type === 'Income' ? '+' : ''}${inr(e.amount)}</div></div>`;
}
const dueCard = () => {
  const items = rec.dueSoon(state, today());
  if (!items.length) return '';
  return `<div class="card"><h2>Due soon</h2>${items.map((i) => `<div class="item" style="cursor:default">
    <div class="l"><div class="t ${i.state === 'overdue' ? 'neg' : ''}">${esc(i.text)}</div></div>
    <div class="r">${inr(i.item.amount)} <button class="small" data-act="paid" data-id="${i.item.id}">Paid</button></div></div>`).join('')}</div>`;
};
const kitchenCard = () => {
  const alerts = state.meals.length ? food.foodAlerts(state, today(), { stockKeys: stockKeys() }) : [];
  const low = state.purchases.length ? grocery.analyze(state, today(), state.settings.people || 4).filter((a) => a.daysLeft != null && a.daysLeft <= 3 && a.buys >= 2) : [];
  if (!alerts.length && !low.length) return '';
  return `<div class="card alert info"><h2>Kitchen</h2>${alerts.slice(0, 2).map((a) => `<div>${esc(food.alertText(a))}</div>`).join('')}
    ${low.length ? `<div class="muted" style="margin-top:6px">Running low: ${esc(low.slice(0, 6).map((a) => a.label).join(', '))}</div>` : ''}
    <p style="margin:8px 0 0"><a href="#kitchen">Open Kitchen</a></p></div>`;
};
const nowClock = () => { const d = new Date(); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };
const medicineHomeCard = () => {
  if (!state.meds.some((m) => m.active)) return '';
  const left = med.dosesOn(state, today()).filter((d) => !d.taken);
  if (!left.length) return `<div class="card"><h2>Medicines today</h2><p style="margin:0">All of today's doses are done. ✅</p><p style="margin:8px 0 0"><a href="#medicine">Open Medicines</a></p></div>`;
  const now = nowClock(), due = left.filter((d) => d.remindAt <= now);
  return `<div class="card ${due.length ? 'alert' : 'alert info'}"><h2>💊 ${due.length ? 'Medicine due now' : 'Next medicines'}</h2>
    ${(due.length ? due : left).slice(0, 4).map((d) => `<div class="doserow"><span class="dtime">${esc(med.prettyTime(d.remindAt))}</span><span><b>${esc(d.person)}</b> · ${esc(med.doseWords(d))}<br><span class="muted">${esc(med.doseLine(d))}</span></span></div>`).join('')}
    <p style="margin:8px 0 0"><a href="#medicine">Open Medicines</a></p></div>`;
};
const replyBox = () => {
  if (!ui.reply) return '';
  const r = ui.reply;
  const share = r.share && state.settings.shareAfterSave
    ? `<div style="margin-top:8px"><button class="small secondary" data-act="share" data-text="${esc(r.share)}">Share to group chat</button></div>` : '';
  return `<div class="msg ${r.ok ? 'ok' : 'error'}">${esc(r.text)}${share}</div>`;
};

// ------------------------------------------------------------------ screens

const screens = {};

screens.home = () => {
  const o = monthOverview(state, today());
  const welcome = state.settings.me ? '' : `<div class="card"><h2>Welcome</h2>
    <form data-form="set-me"><label>Your name, exactly as it shows in your WhatsApp group
      <input name="me" placeholder="e.g. Prabhakar Rai" required></label><button>Save</button></form>
    <p class="muted">Everything stays on this phone. Nothing is uploaded anywhere.</p></div>`;
  return `${welcome}
  <div class="card"><h2>Total expenses (all time)</h2><div class="total">${inr(totalExpenses(state))}</div></div>
  ${dueCard()}
  ${medicineHomeCard()}
  ${kitchenCard()}
  <div class="card"><h2>${esc(o.label)}</h2><div class="stats">
    <div class="stat"><div class="label">Income</div><div class="value pos">${inr(o.income)}</div></div>
    <div class="stat"><div class="label">Expenses</div><div class="value">${inr(o.expenses)}</div></div>
    <div class="stat"><div class="label">Balance</div><div class="value ${o.balance < 0 ? 'neg' : 'pos'}">${inr(o.balance)}</div></div></div></div>
  <div class="card"><h2>Add an expense or income</h2>
    <form data-form="message" class="row"><input name="text" placeholder="Spent 450 on vegetables" autocomplete="off" enterkeyhint="send" required><button>Add</button></form>
    <p class="muted">Try: Medicine 320 yesterday · Income 85000 salary · month · undo · edit 500 · help</p></div>
  ${replyBox()}
  <div class="card"><h2>Recent</h2>${state.entries.length ? newestFirst(state.entries).slice(0, 8).map(entryRowHtml).join('')
    : '<p class="muted">Nothing yet. Add your first one above, or import your family WhatsApp chat from More.</p>'}</div>`;
};

function entryListHtml() {
  const rows = newestFirst(filterEntries(state, { text: ui.search }));
  const shown = rows.slice(0, ui.limit);
  return (shown.map(entryRowHtml).join('') || '<p class="muted">Nothing found.</p>')
    + (rows.length > shown.length ? `<p style="text-align:center"><button class="secondary small" data-act="more-entries">Show more (${rows.length - shown.length} left)</button></p>` : '');
}
screens.entries = () => `<div class="card"><input id="search" type="search" placeholder="Search entries" value="${esc(ui.search)}" style="width:100%">
  <div id="entryList">${entryListHtml()}</div></div>
  <div class="card"><h2>Recent changes</h2>${state.changes.length
    ? state.changes.slice(-8).reverse().map((c) => `<div class="muted" style="padding:4px 0">${esc(store.describeChange(c))}</div>`).join('')
    : '<p class="muted">Edits and deletions are listed here.</p>'}</div>`;

screens['entries/edit'] = (id) => {
  const e = store.getEntry(state, Number(id));
  if (!e) return '<div class="card">That entry no longer exists. <a href="#entries">Back</a></div>';
  const cats = e.type === 'Income' ? [INCOME] : catList();
  return `<div class="card"><h2>Edit entry</h2><form data-form="edit-entry" data-id="${e.id}">
    <label>Date<input type="date" name="date" value="${e.date}" required></label>
    <label>Amount<input name="amount" inputmode="decimal" value="${e.amount}" required></label>
    <label>Category<select name="category" ${e.type === 'Income' ? 'disabled' : ''}>${options(cats, e.category)}</select></label>
    <label>Description<input name="description" value="${esc(e.description)}"></label>
    <p class="muted">Added by ${esc(e.addedBy)}${e.sourceKey ? ' · from an imported chat' : ''}</p>
    <div class="row"><button>Save</button><a class="btn secondary" href="#entries">Cancel</a>
    <button type="button" class="danger" data-act="delete-entry" data-id="${e.id}">Delete</button></div></form></div>`;
};

screens.reports = () => {
  const f = ui.report;
  let r, problem = '';
  try { r = buildReport(state, { today: today(), ...f }); } catch (e) { problem = e.message; r = buildReport(state, { today: today(), period: 'month' }); }
  const people = [...new Set(state.entries.map((e) => e.addedBy).filter(Boolean))];
  return `<div class="card"><h2>Filter</h2><form data-form="report" class="grid2">
    <label>Period<select name="period">${options(PERIODS, f.period || 'month')}</select></label>
    <label>Category<select name="category"><option value="">All</option>${options([...catList(), INCOME], f.category || '')}</select></label>
    <label>Person<select name="person"><option value="">Everyone</option>${options(people, f.person || '')}</select></label>
    <label>Show<select name="type">${options(TYPES, f.type || '')}</select></label>
    <label>From (custom)<input type="date" name="start" value="${esc(f.start || '')}"></label>
    <label>To (custom)<input type="date" name="end" value="${esc(f.end || '')}"></label>
    <button style="grid-column:1/-1">Show report</button></form>
    ${problem ? `<div class="msg error" style="margin-top:10px">${esc(problem)}</div>` : ''}</div>
  <div class="card"><h2>${esc(r.label)}${r.category ? ' · ' + esc(r.category) : ''}${r.person ? ' · ' + esc(r.person) : ''}</h2>
    <div class="stats">${r.showBalance ? `<div class="stat"><div class="label">Income</div><div class="value pos">${inr(r.income)}</div></div>` : ''}
    <div class="stat"><div class="label">Expenses</div><div class="value">${inr(r.expenses)}</div></div>
    ${r.showBalance ? `<div class="stat"><div class="label">Balance</div><div class="value ${r.balance < 0 ? 'neg' : 'pos'}">${inr(r.balance)}</div></div>` : ''}</div>
    <div class="row" style="margin-top:12px"><button class="small" data-act="export-report-xlsx">Download Excel</button>
    <button class="small secondary" data-act="export-report-csv">CSV</button></div></div>
  ${r.byCategory.length ? `<div class="card"><h2>By category</h2>${r.byCategory.map((c) => `<div style="margin-bottom:10px"><div class="item" style="padding:0;border:0;cursor:default"><span>${esc(c.category)} <span class="muted">${c.entries}×</span></span><b>${inr(c.total)} <span class="muted">${c.percent}%</span></b></div><div class="bar"><span style="width:${c.percent}%"></span></div></div>`).join('')}</div>` : ''}
  ${r.byPerson.length > 1 || (r.byPerson.length === 1 && !r.person) ? `<div class="card"><h2>By person</h2>${r.byPerson.map((p) => `<div class="item" style="cursor:default"><span>${esc(p.person)}</span><b>${inr(p.total)} <span class="muted">${p.percent}%</span></b></div>`).join('')}</div>` : ''}
  ${r.incomeSources.length && r.showBalance ? `<div class="card"><h2>Income sources</h2>${r.incomeSources.map((s) => `<div class="item" style="cursor:default"><span>${esc(s.source)}</span><b class="in">${inr(s.total)}</b></div>`).join('')}</div>` : ''}
  <div class="card"><h2>Entries (${r.entries.length})</h2>${r.entries.slice(0, 100).map(entryRowHtml).join('') || '<p class="muted">Nothing matches these filters.</p>'}
    ${r.entries.length > 100 ? '<p class="muted">Showing the newest 100. The Excel download has all of them.</p>' : ''}</div>`;
};

screens.recurring = () => {
  const t = today();
  const items = state.recurring.slice().sort((a, b) => a.nextDue.localeCompare(b.nextDue));
  return `<div class="card"><h2>Recurring expenses</h2>${items.length ? items.map((r) => {
    const [st] = rec.status(r, t);
    return `<div style="padding:10px 0;border-bottom:1px solid var(--line)">
      <div class="item" style="border:0;padding:0;cursor:default"><div class="l"><div class="t">${esc(r.name)}</div>
      <div class="muted">${esc(r.category)} · ${r.frequency}, day ${r.dueDay}</div>
      <div class="${st === 'overdue' ? 'neg' : 'muted'}">${esc(rec.dueText(r, t))}</div></div><div class="r">${inr(r.amount)}</div></div>
      <div class="row" style="margin-top:8px"><button class="small" data-act="paid" data-id="${r.id}">Mark paid</button>
      <button class="small secondary" data-act="share" data-text="${esc(rec.reminderShareText(r, t))}">Remind group</button>
      <button class="small secondary" data-act="stop-recurring" data-id="${r.id}">Stop</button></div></div>`;
  }).join('') : '<p class="muted">Nothing yet. Add rent, EMIs, insurance or school fees below.</p>'}
  <p class="muted">Reminders show here and on Home when they are near. (The app can't wake your phone while closed; open it to see what's due.)</p></div>
  ${replyBox()}
  <div class="card"><h2>Add a recurring expense</h2><form data-form="recurring" class="grid2">
    <label>Name<input name="name" placeholder="Rent" required></label>
    <label>Amount<input name="amount" inputmode="decimal" placeholder="25000" required></label>
    <label>How often<select name="frequency"><option value="monthly">Monthly</option><option value="quarterly">Every 3 months</option><option value="yearly">Yearly</option></select></label>
    <label>Day of month<input name="dueDay" type="number" min="1" max="31" required></label>
    <label>Month (yearly only)<select name="month"><option value="">This month</option>${['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'].map((m, i) => `<option value="${i + 1}">${m}</option>`).join('')}</select></label>
    <label>Category<select name="category">${options(catList(), UNCATEGORIZED)}</select></label>
    <label>Remind (days before)<input name="remindDays" type="number" min="0" max="60" value="2"></label>
    <button style="grid-column:1/-1">Add</button></form></div>`;
};

screens.more = () => `<div class="card">
  <a class="linkrow" href="#import"><span>📥 Import WhatsApp chat</span><span>›</span></a>
  <a class="linkrow" href="#medicine"><span>💊 Medicines &amp; reminders</span><span>›</span></a>
  <a class="linkrow" href="#family"><span>👨‍👩‍👧 Family</span><span>›</span></a>
  <a class="linkrow" href="#categories"><span>🏷️ Categories</span><span>›</span></a>
  <a class="linkrow" href="#backup"><span>💾 Backup, restore, Excel</span><span>›</span></a></div>
  <div class="card"><h2>Your name</h2><form data-form="set-me" class="row"><input name="me" value="${esc(state.settings.me)}" placeholder="As shown in WhatsApp" required><button>Save</button></form>
  <label class="row" style="margin-top:12px"><input type="checkbox" data-act="toggle-share" ${state.settings.shareAfterSave ? 'checked' : ''}> <span>Offer "Share to group chat" after saving</span></label></div>
  ${ui.install ? '<div class="card"><button data-act="install">Install on this phone</button></div>' : ''}
  <div class="card"><h2>About</h2><p class="muted">Version ${esc(VERSION)}<br>Your data is stored only on this phone. The WhatsApp group chat is the shared record: post expenses there, and anyone who wants the full picture imports the exported chat here.</p>
    <button class="secondary" data-act="refresh-app">🔄 Update app now</button><p class="muted">Throws away the app's saved copy of itself and loads the newest version. Your entries are not touched.</p></div>`;


// ------------------------------------------------------------------ medicines

const MEAL_ICON = { breakfast: '🌅', lunch: '☀️', dinner: '🌙', bedtime: '😴' };
const peopleChoices = () => [...new Set([state.settings.me, ...state.members.map((m) => m.name), ...med.peopleWithMeds(state)].filter(Boolean))];
const timeInput = (name, v) => `<input type="time" name="${name}" value="${esc(v)}" required>`;

function rxIntro() {
  const r = ui.rx;
  return `<div class="card"><h2>Add a prescription</h2>
    <p class="muted">Type or paste the prescription, or scan or upload it. I suggest the medicines and times; you check every line before anything is saved.</p>
    <form data-form="read-rx"><div class="grid2"><label>Who is it for?<input name="person" id="rxperson" list="rxpeople" value="${esc(r?.person || '')}" placeholder="Choose or type a name" required autocomplete="off"></label>
      <label>Start date<input type="date" name="date" id="rxdate" value="${esc(r?.date || today())}" required></label></div>
    <datalist id="rxpeople">${peopleChoices().map((n) => `<option value="${esc(n)}">`).join('')}</datalist>
    <label>Doctor (optional)<input name="doctor" id="rxdoctor" value="${esc(r?.doctor || '')}" placeholder="e.g. Dr. Sharma"></label>
    <textarea name="text" id="rxtext" rows="5" placeholder="Tab Metformin 500mg 1-0-1 after food x 30 days&#10;Tab Paracetamol 650mg TDS after meals x 5 days&#10;Cap Omeprazole 20mg OD before breakfast">${esc(ui.rxText)}</textarea>
    <div class="row"><button>Read prescription</button>
      <label class="btn secondary" style="margin:0">📷 Scan photo<input type="file" id="rxphoto" accept="image/*" capture="environment" hidden></label>
      <label class="btn secondary" style="margin:0">📄 Upload PDF / image<input type="file" id="rxfile" accept="application/pdf,.pdf,image/*" hidden></label></div></form>
    <p class="muted" id="rxStatus">${esc(ui.rxOcr)}</p></div>`;
}
function rxReview() {
  const r = ui.rx; if (!r?.items) return '';
  return `<div class="card"><h2>Check the medicines for ${esc(r.person)}</h2>
    <p class="muted">${r.skipped?.length ? `${r.skipped.length} other lines (doctor name, advice, headings) were skipped. ` : ''}Handwritten prescriptions are hard to read: please check every name, time and number of days. This is a reminder aid and does not replace your doctor's advice.</p>
    <form data-form="save-rx">
    ${r.items.map((m, i) => `<div class="billrow"><textarea name="name${i}" rows="2" placeholder="Medicine name and strength">${esc(m.name)}</textarea>
      ${m.flags?.length ? m.flags.map((f) => `<p class="muted neg" style="margin:0 0 6px">⚠ ${esc(f)}</p>`).join('') : ''}
      <div class="mealpick">${med.MEALS.map((ml) => `<label class="chk"><input type="checkbox" name="t${i}_${ml}" ${m.slots.some((s) => s.meal === ml) ? 'checked' : ''}> ${MEAL_ICON[ml]} ${ml}</label>`).join('')}</div>
      <div class="billnums" style="grid-template-columns:1.3fr 1fr 40px">
        <label>When<select name="rel${i}">${options([['after', 'After food'], ['before', 'Before food'], ['with', 'With food'], ['any', 'At that time']], m.relation)}</select></label>
        <label>Days<input name="days${i}" inputmode="numeric" value="${m.days ?? ''}" placeholder="ongoing"></label>
        <button type="button" class="small secondary" data-act="rx-del-line" data-i="${i}" aria-label="Remove medicine">✕</button></div>
      <label class="chk" style="margin-top:6px"><input type="checkbox" name="need${i}" ${m.asNeeded ? 'checked' : ''}> only if needed (no reminders)</label></div>`).join('')}
    <div class="row"><button type="button" class="small secondary" data-act="rx-add-line">+ Add a medicine</button></div>
    <div class="row"><button>Save medicines</button><button type="button" class="secondary" data-act="rx-cancel">Cancel</button></div></form></div>`;
}
function medToday() {
  const t = today(), doses = med.dosesOn(state, t);
  if (!doses.length) return `<div class="card"><h2>Today</h2><p class="muted">No medicines due today.</p></div>`;
  const now = nowClock(), groups = new Map();
  for (const d of doses) { const k = `${d.remindAt}|${d.person}|${d.meal}|${d.relation}`; (groups.get(k) || groups.set(k, []).get(k)).push(d); }
  return `<div class="card"><h2>Today</h2>${[...groups.values()].map((g) => { const f = g[0], done = g.every((d) => d.taken), late = !done && f.remindAt < now;
    return `<div class="dosegroup ${done ? 'done' : late ? 'late' : ''}"><div class="dhead"><b>${esc(med.prettyTime(f.remindAt))}</b> · ${esc(f.person)}<div class="muted">${MEAL_ICON[f.meal]} ${esc(med.doseWords(f))} (${esc(med.prettyTime(f.mealTime))})</div></div>
      ${g.map((d) => `<label class="chk"><input type="checkbox" data-act="dose" data-key="${esc(d.key)}" ${d.taken ? 'checked' : ''}> ${esc(med.doseLine(d))}</label>`).join('')}</div>`; }).join('')}</div>`;
}
function medList() {
  const active = state.meds.filter((m) => m.active);
  if (!active.length) return '';
  const people = med.peopleWithMeds(state);
  return `<div class="card"><h2>Medicines</h2>${people.map((p) => `<h3 class="pperson">${esc(p)}</h3>${active.filter((m) => m.person === p).map((m) => {
    const end = med.medEnd(m);
    const when = m.asNeeded ? 'only if needed' : `${med.REL_TEXT[m.relation]} ${m.slots.map((s) => s.meal).join(', ')}`;
    return `<div class="item" style="cursor:default"><div class="l"><div class="t">${esc(m.name)}</div><div class="muted">${esc(when)} · ${end ? `until ${niceDate(end)}` : 'ongoing'}${m.doctor ? ' · ' + esc(m.doctor) : ''}</div></div>
      <div class="r"><button class="small secondary" data-act="med-stop" data-id="${m.id}">Stop</button> <button class="small danger" data-act="med-delete" data-id="${m.id}">✕</button></div></div>`; }).join('')}`).join('')}</div>`;
}
function medSettings() {
  const st = state.settings, people = med.peopleWithMeds(state);
  return `<div class="card"><h2>Meal times &amp; reminders</h2>
    <p class="muted">Reminders come ${med.leadOf(state)} minutes before the meal. Set when the family usually eats.</p>
    <form data-form="med-times"><div class="grid2">${med.MEALS.map((ml) => `<label>${MEAL_ICON[ml]} ${ml[0].toUpperCase() + ml.slice(1)}${timeInput('t_' + ml, st.mealTimes[ml])}</label>`).join('')}
      <label>Remind minutes before<input name="lead" inputmode="numeric" value="${med.leadOf(state)}"></label></div>
    ${people.length ? `<details><summary><span>Different times for one person</span></summary><p class="muted">Leave a box empty to use the family time.</p>
      ${people.map((p, pi) => `<div class="billrow"><b>${esc(p)}</b><div class="grid2" style="margin-top:6px">${med.MEALS.map((ml) => `<label>${ml}<input type="time" name="by${pi}_${ml}" value="${esc(st.mealTimesBy?.[p]?.[ml] || '')}"></label>`).join('')}</div></div>`).join('')}</details>` : ''}
    <button>Save times</button></form></div>`;
}
function medAlarms() {
  const people = med.peopleWithMeds(state);
  if (!people.length) return '';
  const perm = typeof Notification === 'undefined' ? 'unsupported' : Notification.permission;
  return `<div class="card"><h2>Get reminders on this phone</h2>
    <p class="muted"><b>Phone calendar (recommended):</b> download the file, open it, and add it to your Calendar. Your phone then rings before every meal even when this app is closed. Add again after saving new medicines.</p>
    <form data-form="med-ics" class="row"><select name="person"><option value="">Everyone</option>${options(people, '')}</select><button>📅 Download calendar file</button></form>
    <p class="muted" style="margin-top:12px"><b>While this app is open:</b> ${perm === 'granted' ? 'notifications are on.' : perm === 'denied' ? 'notifications are blocked in the browser settings.' : perm === 'unsupported' ? 'notifications are not available in this browser.' : 'tap to get a notification at reminder time.'}</p>
    ${perm === 'default' ? '<button class="small secondary" data-act="notify-on">🔔 Turn on notifications</button>' : ''}</div>`;
}
screens.medicine = () => `${rxReview()}${medToday()}${rxIntro()}${medList()}${medAlarms()}${medSettings()}`;

function syncRx(form) {
  if (!form || !ui.rx?.items) return;
  const f = new FormData(form);
  ui.rx.items = ui.rx.items.map((m, i) => ({ ...m, name: f.get('name' + i) ?? m.name, relation: f.get('rel' + i) || m.relation, days: f.get('days' + i) ?? m.days, asNeeded: f.has('need' + i),
    slots: med.MEALS.filter((ml) => f.has(`t${i}_${ml}`)).map((meal) => ({ meal, qty: m.slots.find((s) => s.meal === meal)?.qty || 1 })), flags: m.flags }));
}
function startRx(text, note) {
  const person = $('#rxperson')?.value || ui.rx?.person || '', date = $('#rxdate')?.value || ui.rx?.date || today(), doctor = $('#rxdoctor')?.value || ui.rx?.doctor || '';
  ui.rxText = text;
  const parsed = med.parsePrescription(text);
  ui.rx = { person, date, doctor, items: parsed.items.length ? parsed.items : null, skipped: parsed.skipped };
  return parsed.items.length;
}
const notified = new Set();
function checkDueDoses() {
  if (!state.meds.length || typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
  const now = nowClock();
  for (const d of med.dosesOn(state, today())) {
    if (d.taken || notified.has(d.key) || d.remindAt > now || d.remindAt < med.clock(Number(now.slice(0, 2)) * 60 + Number(now.slice(3)) - 10)) continue;
    notified.add(d.key);
    const title = `💊 ${d.person}: ${med.doseWords(d)}`, body = `${med.doseLine(d)} · ${d.meal} at ${med.prettyTime(d.mealTime)}`;
    (navigator.serviceWorker?.ready || Promise.reject()).then((r) => r.showNotification(title, { body, tag: d.key, icon: './icon-192.png' })).catch(() => { try { new Notification(title, { body }); } catch { /* ignore */ } });
    toast(`${title}: ${body}`);
  }
}
setInterval(checkDueDoses, 30000);

screens.import = () => {
  const st = ui.staged;
  const intro = `<div class="card"><h2>Import a WhatsApp chat</h2>
    <p><b>Easiest, no file hunting:</b> in WhatsApp open the group → ⋮ → More → Export chat → <i>Without media</i> → pick <b>Household</b> in the list.
    <span class="muted">(Works once the app is installed from Chrome.)</span></p>
    <p class="muted"><b>Saved it to Drive?</b> Open Drive, tap ⋮ on the file → <i>Send a copy</i> → <b>Household</b>.<br>
    <b>Saved it to the phone?</b> Use the button below. The file is called <b>“WhatsApp Chat with …”</b>; look under <b>Recent</b> or <b>Downloads</b>
    (Samsung: My Files → Downloads), or choose <b>Drive</b> from the picker's menu.</p>
    <input type="file" id="chatfile" accept=".txt,.zip,text/plain,application/zip"></div>
  <div class="card"><h2>Or paste messages</h2>
    <p class="muted">In the WhatsApp chat press and hold a message, tick the others you want, tap copy, then paste here. Good for a few recent messages.</p>
    <form data-form="paste-import"><textarea name="text" placeholder="[10:12 am, 11/11/2026] Asha: Spent 450 on vegetables" rows="4" required></textarea><button>Read pasted messages</button></form></div>`;
  if (!st) return intro;
  const { rows, summary } = st;
  const s = summary;
  const ign = Object.entries(s.ignoredSenders);
  return `${intro}<div class="card"><h2>Review</h2>
    <p class="muted">From: <b>${esc(ui.stagedName || 'chat file')}</b></p>
    <p class="muted">${s.messagesRead} messages read · ${s.candidates} look like entries${s.undone ? ` · ${s.undone} undone` : ''}${s.edited ? ` · ${s.edited} edited` : ''}${s.alreadyImported ? ` · ${s.alreadyImported} already imported` : ''}</p>
    ${ign.length ? `<p class="muted">Ignored (not on the Family list): ${ign.map(([n, c]) => `${esc(n)} (${c})`).join(', ')}</p>` : ''}
    <form data-form="confirm-import">${rows.length ? rows.map((r, i) => `<div class="review"><input type="checkbox" name="pick" value="${i}" ${r.likely && !r.maybeDuplicate ? 'checked' : ''}>
      <div><div><b>${esc(r.type === 'Income' ? '+' + inr(r.amount) : inr(r.amount))}</b> · ${esc(r.description)}
      ${r.maybeDuplicate ? '<span class="tag warn">may be a duplicate</span>' : ''}</div>
      <div class="muted">${niceDate(r.date)} · ${esc(r.addedBy)} · “${esc(r.originalText.slice(0, 80))}”</div>
      ${r.type === 'Income' ? '' : `<select name="cat${i}">${options(catList(), r.category)}</select>`}</div></div>`).join('')
      : '<p class="muted">Nothing new to import.</p>'}
    ${rows.length ? '<button>Save ticked entries</button>' : ''}</form></div>`;
};

screens.family = () => `<div class="card"><h2>Family</h2>
  <p class="muted">Add everyone whose messages count. With nobody listed, everyone in an imported chat counts.</p>
  ${state.members.map((m) => `<div class="item" style="cursor:default"><div class="l"><div class="t">${esc(m.name)}${m.active ? '' : '<span class="tag warn">paused</span>'}</div>
    <div class="muted">${m.chatName ? 'WhatsApp name: ' + esc(m.chatName) : ''} ${m.phone ? esc(m.phone) : ''}</div></div>
    <div class="r"><button class="small secondary" data-act="toggle-member" data-id="${m.id}">${m.active ? 'Pause' : 'Resume'}</button>
    <button class="small danger" data-act="delete-member" data-id="${m.id}">Remove</button></div></div>`).join('') || '<p class="muted">No one yet.</p>'}</div>
  <div class="card"><h2>Add a person</h2><form data-form="member">
    <label>Name<input name="name" required></label>
    <label>Name in the WhatsApp chat (if different)<input name="chatName" placeholder="e.g. Prabhakar Rai"></label>
    <label>Phone (if the chat shows a number)<input name="phone" inputmode="tel" placeholder="+91 98765 43210"></label><button>Add</button></form></div>`;

screens.categories = () => `<div class="card"><h2>Categories</h2>
  <p class="muted">Type a category's own name in a message and it always wins. Keywords are everyday words that point to it (comma separated, any language).</p>
  ${state.categories.map((c, i) => `<form data-form="category" data-name="${esc(c.name)}" style="padding:10px 0;border-bottom:1px solid var(--line)">
    <label>Name<input name="name" value="${esc(c.name)}" required></label>
    <label>Keywords<textarea name="keywords">${esc(c.keywords.join(', '))}</textarea></label>
    <div class="row"><button class="small">Save</button><button type="button" class="small danger" data-act="delete-category" data-name="${esc(c.name)}">Delete</button></div></form>`).join('')}</div>
  <div class="card"><h2>Add a category</h2><form data-form="add-category">
    <label>Name<input name="name" placeholder="e.g. Pets" required></label>
    <label>Keywords<textarea name="keywords" placeholder="dog food, vet"></textarea></label><button>Add</button></form>
    <p class="muted" style="margin-top:10px"><a href="#" data-act="reset-categories">Restore the original categories and keywords</a> (your own categories stay)</p></div>`;

screens.backup = () => `<div class="card"><h2>Excel</h2><p class="muted">Everything you have recorded, as an Excel file.</p>
  <div class="row"><button data-act="export-all-xlsx">Download Excel</button><button class="secondary" data-act="export-all-csv">CSV</button></div></div>
  <div class="card"><h2>Backup</h2><p class="muted">Your data lives only on this phone. If you clear the browser data or change phones it is gone, so keep a backup file somewhere safe (for example, email it to yourself).</p>
  <button data-act="backup">Download backup file</button>
  <label style="margin-top:12px">Restore from a backup file<input type="file" id="restorefile" accept=".json,application/json"></label>
  <p class="muted" id="persistInfo"></p></div>
  <div class="card"><h2>Delete everything</h2><button class="danger" data-act="wipe">Delete all data on this phone</button></div>`;


// ------------------------------------------------------------------ kitchen: grocery + meals

const stockKeys = () => grocery.analyze(state, today(), state.settings.people || 4)
  .filter((a) => (a.remaining ?? a.daysLeft ?? 0) > 0).map((a) => a.key);
const kitchenTabs = (sub) => `<div class="seg"><a href="#kitchen" class="${sub === 'meals' ? '' : 'active'}">🛒 Grocery</a><a href="#kitchen/meals" class="${sub === 'meals' ? 'active' : ''}">🍽️ Meals</a></div>`;
const STATUS_TAG = { fast: '<span class="tag warn">used faster than usual</span>', slow: '<span class="tag">lasted longer</span>',
  normal: '<span class="tag">as usual</span>', learning: '<span class="muted">learning</span>', first: '<span class="muted">bought once</span>' };

function billCard() {
  const b = ui.bill;
  const intro = `<div class="card"><h2>Add a grocery bill</h2>
    <p class="muted">Paste the bill text (BigBasket, Blinkit, DMart and similar emails or messages), type it, scan a photo, or upload the PDF / screenshot from an online order. One item per line, like <i>Atta 5kg 250</i>.</p>
    <form data-form="read-bill"><textarea name="text" id="billtext" rows="5" placeholder="Atta 5kg 250&#10;Milk 500ml 2 28 56&#10;Onion 2 kg 60">${esc(ui.billText)}</textarea>
    <div class="row"><button>Read bill</button><label class="btn secondary" style="margin:0">📷 Scan photo<input type="file" id="billphoto" accept="image/*" capture="environment" hidden></label>
    <label class="btn secondary" style="margin:0">📄 Upload PDF / image<input type="file" id="billfile" accept="application/pdf,.pdf,image/*" hidden></label></div></form>
    <p class="muted" id="ocrStatus">${esc(ui.ocr)}</p></div>`;
  if (!b) return intro;
  const total = b.lines.reduce((t, l) => t + (Number(l.price) || 0), 0);
  return intro + `<div class="card"><h2>Check the items</h2>
    <p class="muted">Fix anything that was read wrongly. ${b.skipped ? `${b.skipped} other lines (totals, tax, headings) were skipped.` : ''} Photo scans especially need a look.</p>
    <form data-form="save-bill"><div class="grid2"><label>Bill date<input type="date" name="date" value="${esc(b.date)}" required></label>
    <label>Shop (optional)<input name="store" value="${esc(b.store || '')}" placeholder="e.g. DMart"></label></div>
    ${b.lines.map((l, i) => `<div class="billrow"><textarea name="name${i}" rows="2" placeholder="Item name">${esc(l.name)}</textarea>
      <div class="billnums"><label>Qty<input name="qty${i}" inputmode="decimal" value="${l.qty ?? ''}" placeholder="–"></label>
      <label>Unit<select name="unit${i}"><option value=""></option>${options(grocery.DISPLAY_UNITS, l.unit || '')}</select></label>
      <label>₹ Price<input name="price${i}" inputmode="decimal" value="${l.price ?? ''}" placeholder="–"></label>
      <button type="button" class="small secondary" data-act="bill-del-line" data-i="${i}" aria-label="Remove line">✕</button></div></div>`).join('')}
    <div class="row"><button type="button" class="small secondary" data-act="bill-add-line">+ Add a line</button><span class="muted">Lines total ${inr(total)}</span></div>
    <label class="row"><input type="checkbox" name="record"> <span>Also record ${inr(total)} as a Grocery expense <span class="muted">(skip if you already posted it)</span></span></label>
    <div class="row"><button>Save bill</button><button type="button" class="secondary" data-act="bill-cancel">Cancel</button></div></form></div>`;
}

function listCard() {
  const people = state.settings.people || 4;
  const list = grocery.monthlyList(state, today(), { people });
  return `<div class="card"><h2>Next 30 days: what to buy</h2>
    <label class="row" style="margin-bottom:10px"><span>People at home</span><input type="number" min="1" max="20" value="${people}" data-act="people" style="max-width:80px"></label>
    ${list.items.length ? list.items.map((i) => `<div class="item" style="cursor:default"><div class="l"><div class="t">${esc(i.label)}</div><div class="muted">${esc(i.why)}</div></div>
      <div class="r">${i.qty != null ? esc(grocery.formatQty(i.qty, i.unit)) : 'restock'}${i.cost != null ? `<div class="muted">≈ ${inr(i.cost)}</div>` : ''}</div></div>`).join('')
      : '<p class="muted">No list yet. The app learns from your bills: after an item has been bought twice or more, it can estimate how much you need.</p>'}
    ${list.estimate != null ? `<p class="muted">Estimated total about ${inr(list.estimate)}. Prices come from your last purchases.</p>` : ''}
    ${list.needMoreData.length ? `<p class="muted">Not enough history yet: ${esc(list.needMoreData.slice(0, 12).join(', '))}.</p>` : ''}
    ${list.items.length ? '<button class="small" data-act="share-list">Share list</button>' : ''}</div>`;
}

const BANDS = [
  ['restock', '🔴', 'Restock now', 'Finished or about to run out'],
  ['low', '🟠', 'Running low', 'Nearing restock time'],
  ['fine', '🟡', 'Good for now', 'Some time left'],
  ['full', '🟢', 'Well stocked', 'Restocked recently'],
  ['learning', '⚪', 'Still learning', 'Buy it once more and I can tell'],
];
function pantryRow(x, st) {
  const days = st.daysLeft != null ? Math.round(st.daysLeft) : null;
  const when = st.band === 'learning' ? `bought ${st.sinceBought === 0 ? 'today' : st.sinceBought + ' days ago'}`
    : st.band === 'restock' ? 'restock now' : days <= 0 ? 'almost out' : `about ${days} day${days === 1 ? '' : 's'} left`;
  const cap = { restock: 12, low: 34 }[st.band] ?? 100;   // the bar never contradicts the colour
  const pct = st.level == null ? 0 : Math.max(6, Math.min(cap, Math.round(st.level * 100)));
  return `<details class="pitem ${st.band}"><summary><span class="pname"><b>${esc(x.label)}</b><span class="muted">last bought ${niceDate(x.lastBought)}${x.lastQty != null ? ' · ' + esc(grocery.formatQty(x.lastQty, x.unit)) : ''}</span></span>
    <span class="pwhen">${esc(when)}</span><span class="pbar"><i style="width:${pct}%"></i></span></summary>
    <p class="muted" style="margin:8px 0 4px">${esc(x.message)}</p>
    ${x.note ? `<p class="muted" style="margin:4px 0">${esc(x.note)}</p>` : ''}
    ${x.intervals.length ? `<p class="muted" style="margin:4px 0">Past gaps: ${x.intervals.slice(-4).map((i) => `${i.days} days${i.qty != null ? ` (${esc(grocery.formatQty(i.qty, i.unit))})` : ''}${i.finished ? ' ✓' : ''}`).join(' · ')}</p>` : ''}
    <button class="small secondary" data-act="finish-item" data-key="${esc(x.key)}">It ran out today</button></details>`;
}
function itemsCard() {
  const t = today(), all = grocery.analyze(state, t, state.settings.people || 4);
  if (!all.length) return '';
  const rows = all.map((x) => ({ x, st: grocery.stockLevel(x, t) }));
  const groups = BANDS.map(([band, icon, title, hint]) => {
    const list = rows.filter((r) => r.st.band === band).sort((p, q) => (p.st.level ?? 9) - (q.st.level ?? 9) || p.x.label.localeCompare(q.x.label));
    if (!list.length) return '';
    return `<div class="pgroup ${band}"><h3>${icon} ${title} <span class="count">${list.length}</span><span class="muted"> · ${hint}</span></h3>${list.map((r) => pantryRow(r.x, r.st)).join('')}</div>`;
  }).join('');
  const need = rows.filter((r) => r.st.band === 'restock' || r.st.band === 'low').length;
  return `<div class="card"><h2>Your kitchen stock</h2>
    <p class="pnote">${need ? `<b>${need}</b> item${need === 1 ? '' : 's'} need${need === 1 ? 's' : ''} restocking soon.` : 'Nothing needs restocking right now. 🎉'} <span class="muted">Tap an item for details.</span></p>${groups}</div>`;
}

function billsCard() {
  if (!state.bills.length) return '';
  return `<div class="card"><h2>Saved bills</h2>${[...state.bills].sort((a, b) => b.date.localeCompare(a.date) || b.id - a.id).slice(0, 15).map((b) => `<div class="item" style="cursor:default">
    <div class="l"><div class="t">${niceDate(b.date)}${b.store ? ' · ' + esc(b.store) : ''}</div><div class="muted">${b.count} item${b.count === 1 ? '' : 's'}</div></div>
    <div class="r">${inr(b.total)} <button class="small secondary" data-act="delete-bill" data-id="${b.id}">✕</button></div></div>`).join('')}</div>`;
}

const TAG = { healthy: '🟢', less: '🟠', mixed: '🟡', unknown: '⚪' };
function mealsView() {
  const t = today(), cfg = { ...food.DEFAULT_FOOD_SETTINGS, ...(state.settings.food || {}) };
  const alerts = food.foodAlerts(state, t, { stockKeys: stockKeys() });
  const next = food.mealForHour(new Date().getHours());
  const ideas = food.suggest(state, { meal: next, today: t, stockKeys: stockKeys(), diet: cfg.diet, count: 4 });
  const words = food.wordsFor(state);
  const from = addDaysLocal(t, -6);
  const recent = food.newestFirstMeals(state.meals.filter((m) => m.date >= from));
  const days = [...new Set(recent.map((m) => m.date))];
  return `${alerts.map((a) => `<div class="card alert ${a.level}"><div>${esc(a.text)}</div>${a.ideas?.length ? `<p class="muted" style="margin:6px 0 0"><b>${esc(a.ideasLabel)}:</b> ${esc(a.ideas.join(' · '))}</p>` : ''}</div>`).join('')}
  <div class="card"><h2>What did you have?</h2><form data-form="meal">
    <div class="grid2"><label>Meal<select name="meal">${options(food.MEALS, next)}</select></label>
    <label>Where<select name="place"><option value="Home">At home</option><option value="Outside">Outside</option><option value="Ordered">Ordered in</option></select></label></div>
    <label>What<input name="dish" placeholder="e.g. dal, rice, sabzi" autocomplete="off" required></label>
    <label>Date<input type="date" name="date" value="${t}" required></label><button>Add meal</button></form>
    <p class="muted">You can also type it in the Home box: <i>lunch dal rice at home</i> · <i>dinner outside pizza</i>.</p></div>
  <div class="card"><h2>Ideas for ${next.toLowerCase()}</h2>${ideas.length ? ideas.map((d) => `<div class="item" style="cursor:default"><span>${esc(d.name)}</span>${d.uses.some((u) => stockKeys().includes(u)) ? '<span class="tag">uses what you have</span>' : ''}</div>`).join('')
    : '<p class="muted">Nothing new to suggest right now.</p>'}<p class="muted">Ideas skip anything you had this week.</p></div>
  <div class="card"><h2>Last 7 days</h2>${days.length ? days.map((d) => `<div style="margin-bottom:10px"><div class="muted"><b>${niceDate(d)}</b></div>${recent.filter((m) => m.date === d).map((m) => `<div class="item" style="cursor:default">
    <div class="l"><div class="t">${TAG[food.classify(m.dish, words)]} ${esc(m.dish)}</div><div class="muted">${m.meal} · ${m.place === 'Home' ? 'home' : m.place === 'Ordered' ? 'ordered in' : 'outside'}</div></div>
    <div class="r"><button class="small secondary" data-act="delete-meal" data-id="${m.id}">✕</button></div></div>`).join('')}</div>`).join('')
    : '<p class="muted">Nothing logged in the last week.</p>'}
    <p class="muted">🟢 lighter · 🟠 heavier or fried · 🟡 mixed · ⚪ not sure. These are simple word-based tags, not medical advice.</p></div>
  <div class="card"><h2>Alert settings</h2><form data-form="food-settings">
    <div class="grid2"><label>Diet for ideas<select name="diet">${options([['any', 'Anything'], ['egg', 'Vegetarian + eggs'], ['veg', 'Vegetarian']], cfg.diet)}</select></label>
    <label>Outside meals a week before an alert<input type="number" name="outsideMax" min="0" max="20" value="${cfg.outsideMax}"></label>
    <label>Heavier meals in a row before an alert<input type="number" name="unhealthyStreak" min="2" max="10" value="${cfg.unhealthyStreak}"></label>
    <label>Same dish this many times is okay<input type="number" name="repeatMax" min="1" max="10" value="${cfg.repeatMax}"></label></div>
    <label>Your own lighter foods (comma separated)<textarea name="healthy">${esc((state.foodWords?.healthy || []).join(', '))}</textarea></label>
    <label>Your own heavier foods (comma separated)<textarea name="less">${esc((state.foodWords?.less || []).join(', '))}</textarea></label>
    <button>Save</button></form></div>`;
}
const addDaysLocal = (d, n) => { const [y, m, dd] = d.split('-').map(Number); const t = new Date(Date.UTC(y, m - 1, dd + n)); return t.toISOString().slice(0, 10); };

screens.kitchen = (sub) => kitchenTabs(sub) + (sub === 'meals' ? mealsView() : `${itemsCard()}${billCard()}${listCard()}${billsCard()}`);

// ------------------------------------------------------------------ routing

function route() {
  const hash = location.hash.replace(/^#/, '') || 'home';
  const [name, ...rest] = hash.split('/');
  const key = name === 'entries' && rest[0] === 'edit' ? 'entries/edit' : name;
  const screen = screens[key] || screens.home;
  $('#view').innerHTML = screen(key === 'entries/edit' ? rest[1] : rest[0]);
  const tab = ['import', 'family', 'categories', 'backup', 'medicine'].includes(name) ? 'more' : (name === 'entries' ? 'entries' : name);
  document.querySelectorAll('#tabs a').forEach((a) => a.classList.toggle('active', a.dataset.tab === tab));
  $('#sub').textContent = ({ home: monthOverview(state, today()).label, entries: 'Entries', kitchen: 'Kitchen', reports: 'Reports', recurring: 'Recurring', medicine: 'Medicines' })[name] || '';
  if (name === 'backup' && navigator.storage?.persisted) {
    navigator.storage.persisted().then((p) => { const el = $('#persistInfo'); if (el) el.textContent = p ? 'This phone has agreed to keep the data safe from automatic clean-up.' : 'The phone may clear this data if it runs low on space, so keep a backup.'; });
  }
  window.scrollTo(0, 0);
}
const refresh = () => { const y = window.scrollY; route(); window.scrollTo(0, y); };
window.addEventListener('hashchange', route);

// ------------------------------------------------------------------ events

/** Copies what is typed in the bill-check form back into ui.bill, so re-drawing the screen loses nothing. */
function syncBill(form) {
  if (!form || !ui.bill) return;
  const f = Object.fromEntries(new FormData(form));
  ui.bill.date = f.date || ui.bill.date; ui.bill.store = f.store ?? ui.bill.store;
  ui.bill.lines = ui.bill.lines.map((l, i) => ({ name: f['name' + i] ?? l.name, qty: f['qty' + i] ?? l.qty, unit: f['unit' + i] ?? l.unit, price: f['price' + i] ?? l.price }));
}
const ALLOWED_ENTRY_CATS = () => new Set([...catList(), INCOME]);
const fail = (e) => toast(e.message || String(e));

document.addEventListener('submit', (ev) => {
  const form = ev.target.closest('form[data-form]');
  if (!form) return;
  ev.preventDefault();
  const f = Object.fromEntries(new FormData(form));
  try {
    switch (form.dataset.form) {
      case 'set-me': state.settings.me = (f.me || '').trim(); persist(); toast('Saved'); refresh(); break;
      case 'message': {
        const reply = handleMessage(state, f.text, me(), today());
        ui.reply = reply; if (reply.changed) persist(); refresh();
        const input = document.querySelector('form[data-form=message] input'); if (input) input.focus();
        break;
      }
      case 'edit-entry': {
        const id = Number(form.dataset.id), e = store.getEntry(state, id);
        const amount = parseFloat(String(f.amount).replace(/,/g, ''));
        if (!(amount > 0)) return toast('Enter an amount above zero.');
        if (!/^\d{4}-\d{2}-\d{2}$/.test(f.date)) return toast('Pick a date.');
        const category = e.type === 'Income' ? INCOME : f.category;
        if (!ALLOWED_ENTRY_CATS().has(category)) return toast('Pick a category from the list.');
        store.updateEntry(state, id, me(), { date: f.date, amount, category, description: (f.description || '').trim() });
        persist(); toast('Saved'); location.hash = '#entries'; break;
      }
      case 'report': ui.report = { ...f }; refresh(); break;
      case 'recurring': {
        const item = rec.addRecurring(state, { name: f.name.trim(), amount: parseFloat(String(f.amount).replace(/,/g, '')), category: f.category,
          frequency: f.frequency, dueDay: Number(f.dueDay), month: f.month ? Number(f.month) : null, remindDays: Math.min(60, Math.max(0, Number(f.remindDays) || 0)) }, today());
        persist(); toast(`Added ${item.name}. Next due ${niceDate(item.nextDue)}.`); refresh(); break;
      }
      case 'confirm-import': {
        const picks = new Set(new FormData(form).getAll('pick').map(Number));
        const overrides = {}; ui.staged.rows.forEach((_, i) => { if (f['cat' + i]) overrides[i] = f['cat' + i]; });
        const { saved, duplicates } = confirmImport(state, ui.staged.rows, picks, overrides, store.pushEntry);
        ui.staged = null; persist(); toast(`Saved ${saved} entr${saved === 1 ? 'y' : 'ies'}${duplicates ? ` (${duplicates} duplicates skipped)` : ''}.`); location.hash = '#home'; break;
      }
      case 'paste-import': {
        const staged = stageImport(state, f.text || '');
        if (!staged.summary.messagesRead) return toast("I couldn't find WhatsApp messages in that text. Copy them from the chat (press and hold, select, copy) so the date, time and name come along.");
        ui.staged = staged; ui.stagedName = 'pasted messages'; refresh(); break;
      }
      case 'read-bill': {
        ui.billText = f.text || '';
        const parsed = grocery.parseBill(ui.billText, { today: today() });
        if (!parsed.lines.length) return toast("I couldn't find any items. Put one item per line, like: Atta 5kg 250");
        ui.bill = { date: parsed.date, store: '', lines: parsed.lines.map((l) => ({ name: l.name, qty: l.qty, unit: l.unit, price: l.price })), skipped: parsed.skipped.length };
        refresh(); break;
      }
      case 'save-bill': {
        syncBill(form);
        const lines = ui.bill.lines.filter((l) => (l.name || '').trim());
        if (grocery.looksSaved(state, ui.bill.date, lines) && !confirm('A bill with the same date and total is already saved. Save it again?')) return;
        const bill = grocery.addBill(state, { date: ui.bill.date, store: ui.bill.store, lines });
        if (f.record && bill.total > 0) store.addEntry(state, { date: bill.date, amount: bill.total, category: 'Grocery', description: bill.store ? `Groceries · ${bill.store}` : 'Groceries (bill)', addedBy: me() });
        ui.bill = null; ui.billText = ''; ui.ocr = ''; persist();
        toast(`Saved ${bill.count} item${bill.count === 1 ? '' : 's'} (${inr(bill.total)})`); refresh(); break;
      }
      case 'read-rx': {
        if (!startRx(f.text || '', '')) { ui.rx = { person: f.person, date: f.date, doctor: f.doctor, items: null }; return toast("I couldn't find any medicines. Put one medicine per line, like: Tab Metformin 500mg 1-0-1 after food x 30 days"); }
        ui.rx.person = f.person; ui.rx.date = f.date; ui.rx.doctor = f.doctor; refresh(); break;
      }
      case 'save-rx': {
        syncRx(form);
        const added = med.addPrescription(state, { person: f.person ?? ui.rx.person, date: ui.rx.date, doctor: ui.rx.doctor, items: ui.rx.items });
        ui.rx = null; ui.rxText = ''; ui.rxOcr = ''; persist();
        toast(`Saved ${added.length} medicine${added.length === 1 ? '' : 's'}. Now add the reminders to your phone calendar below.`); refresh(); break;
      }
      case 'med-times': {
        for (const ml of med.MEALS) if (/^\d{2}:\d{2}$/.test(f['t_' + ml] || '')) state.settings.mealTimes[ml] = f['t_' + ml];
        const lead = Math.round(Number(f.lead)); if (lead >= 0 && lead <= 60) state.settings.remindLead = lead;
        med.peopleWithMeds(state).forEach((p, pi) => { const o = {}; for (const ml of med.MEALS) if (/^\d{2}:\d{2}$/.test(f[`by${pi}_${ml}`] || '')) o[ml] = f[`by${pi}_${ml}`]; state.settings.mealTimesBy[p] = o; });
        persist(); toast('Times saved. Download the calendar file again so your phone uses them.'); refresh(); break;
      }
      case 'med-ics': {
        const { text, events } = med.buildIcs(state, today(), { person: f.person || null });
        if (!events) return toast('Nothing to remind: no running medicines for that choice.');
        download(`Medicines-${(f.person || 'Family').replace(/[^\w-]+/g, '_')}-${today()}.ics`, text, 'text/calendar');
        toast(`Calendar file ready (${events} repeating reminder${events === 1 ? '' : 's'}). Open it and choose Calendar.`); break;
      }
      case 'meal': {
        food.addMeal(state, { date: f.date, meal: f.meal, place: f.place, dish: f.dish, addedBy: me() }); persist();
        toast('Added'); refresh(); break;
      }
      case 'food-settings': {
        const num = (v, lo, hi, d) => { const n = Math.round(Number(v)); return n >= lo && n <= hi ? n : d; };
        const cur = { ...food.DEFAULT_FOOD_SETTINGS, ...(state.settings.food || {}) };
        state.settings.food = { ...cur, diet: ['any', 'egg', 'veg'].includes(f.diet) ? f.diet : 'any', outsideMax: num(f.outsideMax, 0, 20, cur.outsideMax),
          unhealthyStreak: num(f.unhealthyStreak, 2, 10, cur.unhealthyStreak), repeatMax: num(f.repeatMax, 1, 10, cur.repeatMax) };
        const words = (t) => String(t || '').split(',').map((w) => w.trim().toLowerCase()).filter(Boolean);
        state.foodWords = { healthy: words(f.healthy), less: words(f.less) };
        persist(); toast('Saved'); refresh(); break;
      }
      case 'member': store.addMember(state, f); persist(); refresh(); break;
      case 'category': store.updateCategory(state, form.dataset.name, { name: f.name, keywords: f.keywords }); persist(); toast('Saved'); refresh(); break;
      case 'add-category': store.addCategory(state, f.name, f.keywords); persist(); toast('Added'); refresh(); break;
    }
  } catch (e) { fail(e); }
});

document.addEventListener('click', async (ev) => {
  const el = ev.target.closest('[data-act]');
  if (!el || el.tagName === 'INPUT') return;
  const act = el.dataset.act, id = Number(el.dataset.id);
  try {
    switch (act) {
      case 'edit-entry': location.hash = `#entries/edit/${id}`; break;
      case 'more-entries': ui.limit += 60; $('#entryList').innerHTML = entryListHtml(); break;
      case 'delete-entry': if (confirm('Delete this entry?')) { store.deleteEntry(state, id, me()); persist(); toast('Deleted'); location.hash = '#entries'; } break;
      case 'paid': {
        const item = rec.markPaid(state, id, me(), today());
        if (item) { persist(); ui.reply = { ok: true, text: `Recorded ${item.name} ${inr(item.amount)}. Next due ${niceDate(item.nextDue)}.`, share: rec.paidShareText(item) }; refresh(); }
        break;
      }
      case 'stop-recurring': if (confirm('Stop this recurring expense? Past payments stay.')) { rec.removeRecurring(state, id); persist(); refresh(); } break;
      case 'share': shareText(el.dataset.text); break;
      case 'toggle-member': { const m = state.members.find((x) => x.id === id); if (m) { m.active = !m.active; persist(); refresh(); } break; }
      case 'delete-member': if (confirm('Remove this person? Their past entries stay.')) { state.members = state.members.filter((m) => m.id !== id); persist(); refresh(); } break;
      case 'delete-category': {
        const n = state.entries.filter((e) => e.category === el.dataset.name).length;
        if (confirm(`Delete "${el.dataset.name}"?${n ? ` Its ${n} entries become Uncategorized.` : ''}`)) { store.deleteCategory(state, el.dataset.name); persist(); refresh(); }
        break;
      }
      case 'reset-categories': ev.preventDefault(); if (confirm('Restore the original categories and keywords?')) { store.resetCategories(state); persist(); refresh(); } break;
      case 'export-report-xlsx': case 'export-report-csv': {
        const r = buildReport(state, { today: today(), ...ui.report });
        if (act.endsWith('xlsx')) download('household-report.xlsx', entriesWorkbook(r.entries, r), 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        else download('household-report.csv', toCsv([ENTRY_HEADER, ...r.entries.map(entryRow)]), 'text/csv');
        break;
      }
      case 'export-all-xlsx': download('household-all.xlsx', entriesWorkbook(newestFirst(state.entries)), 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'); break;
      case 'export-all-csv': download('household-all.csv', toCsv([ENTRY_HEADER, ...newestFirst(state.entries).map(entryRow)]), 'text/csv'); break;
      case 'backup': download(`household-backup-${today()}.json`, JSON.stringify(state), 'application/json'); toast('Backup downloaded. Keep it somewhere safe.'); break;
      case 'bill-add-line': syncBill(document.querySelector('form[data-form=save-bill]')); ui.bill.lines.push({ name: '', qty: null, unit: '', price: null }); refresh(); break;
      case 'bill-del-line': syncBill(document.querySelector('form[data-form=save-bill]')); ui.bill.lines.splice(Number(el.dataset.i), 1); refresh(); break;
      case 'bill-cancel': ui.bill = null; refresh(); break;
      case 'rx-add-line': syncRx(document.querySelector('form[data-form=save-rx]')); ui.rx.items.push({ name: '', slots: [], relation: 'after', days: null, asNeeded: false, flags: [] }); refresh(); break;
      case 'rx-del-line': syncRx(document.querySelector('form[data-form=save-rx]')); ui.rx.items.splice(Number(el.dataset.i), 1); if (!ui.rx.items.length) ui.rx.items = null; refresh(); break;
      case 'rx-cancel': ui.rx = null; ui.rxText = ''; refresh(); break;
      case 'med-stop': if (confirm('Stop reminders for this medicine?')) { med.stopMed(state, id); persist(); refresh(); } break;
      case 'med-delete': if (confirm('Delete this medicine?')) { med.deleteMed(state, id); persist(); refresh(); } break;
      case 'notify-on': { const p = await Notification.requestPermission(); toast(p === 'granted' ? 'Notifications on while the app is open.' : 'Notifications were not allowed.'); refresh(); break; }
      case 'refresh-app': {   // clears the saved copy of the app (never the data) and reloads
        for (const r of await navigator.serviceWorker?.getRegistrations?.() || []) await r.unregister();
        for (const k of await caches.keys()) if (k !== 'household-shared') await caches.delete(k);
        location.replace(location.pathname + '?v=' + Date.now()); break;
      }
      case 'finish-item': grocery.markFinished(state, el.dataset.key, today()); persist(); toast('Noted. Next time I will count the days exactly.'); refresh(); break;
      case 'delete-bill': if (confirm('Delete this bill and its items?')) { grocery.deleteBill(state, id); persist(); refresh(); } break;
      case 'delete-meal': food.deleteMeal(state, id); persist(); refresh(); break;
      case 'share-list': shareText(grocery.listShareText(grocery.monthlyList(state, today(), { people: state.settings.people || 4 }), today())); break;
      case 'wipe': if (confirm('Delete ALL data on this phone? This cannot be undone.') && confirm('Really delete everything? Download a backup first if unsure.')) { state = store.newState(); persist(); toast('Everything deleted'); location.hash = '#home'; } break;
      case 'install': ui.install.prompt(); ui.install = null; refresh(); break;
    }
  } catch (e) { fail(e); }
});

document.addEventListener('input', (ev) => {
  if (ev.target.id === 'search') { ui.search = ev.target.value; ui.limit = 60; $('#entryList').innerHTML = entryListHtml(); }
});

async function stageFromBuffer(buffer, name = '') {
  try {
    ui.staged = stageImport(state, await readExport(buffer));
    ui.stagedName = name;
    if (location.hash !== '#import') location.hash = '#import'; else refresh();
  } catch (e) { fail(e); }
}
document.addEventListener('change', async (ev) => {
  const t = ev.target;
  if (t.dataset?.act === 'people') { const n = Math.round(Number(t.value)); if (n >= 1 && n <= 20) { state.settings.people = n; persist(); refresh(); } }
  if ((t.id === 'billphoto' || t.id === 'billfile') && t.files[0]) {
    const status = (text) => { ui.ocr = text; const el = $('#ocrStatus'); if (el) el.textContent = text; };
    try {
      const f = t.files[0], isPdf = f.type === 'application/pdf' || /\.pdf$/i.test(f.name);
      const text = isPdf ? await readPdf(f, status) : await scanBill(f, status);
      if (!text.trim()) { status('No text found in that file. Try a clearer, well-lit picture, or type the bill.'); }
      else {
        const box = $('#billtext'); if (box) box.value = text; ui.billText = text;
        const parsed = grocery.parseBill(text, { today: today() });
        status(parsed.lines.length ? 'Done. Please check every line below.' : "I read the file but couldn't find items. Edit the text above and tap Read bill.");
        if (parsed.lines.length) { ui.bill = { date: parsed.date, store: '', lines: parsed.lines.map((l) => ({ name: l.name, qty: l.qty, unit: l.unit, price: l.price })), skipped: parsed.skipped.length }; refresh(); }
      }
    } catch (e) { status(e.message || String(e)); }
    t.value = '';
  }
  if (t.dataset?.act === 'dose') { med.markTaken(state, t.dataset.key, t.checked); persist(); refresh(); }
  if ((t.id === 'rxphoto' || t.id === 'rxfile') && t.files[0]) {
    const status = (text) => { ui.rxOcr = text; const el = $('#rxStatus'); if (el) el.textContent = text; };
    try {
      const f = t.files[0], isPdf = f.type === 'application/pdf' || /\.pdf$/i.test(f.name);
      const text = isPdf ? await readPdf(f, status) : await scanBill(f, status);
      if (!text.trim()) status('No text found in that file. Try a clearer picture, or type the prescription.');
      else {
        const box = $('#rxtext'); if (box) box.value = text;
        const n = startRx(text, '');
        status(n ? 'Done. Please check every medicine below.' : "I read the file but couldn't find medicines. Edit the text above and tap Read prescription.");
        if (n) refresh();
      }
    } catch (e) { status(e.message || String(e)); }
    t.value = '';
  }
  if (t.dataset?.act === 'toggle-share') { state.settings.shareAfterSave = t.checked; persist(); }
  if (t.id === 'chatfile' && t.files[0]) await stageFromBuffer(await t.files[0].arrayBuffer(), t.files[0].name);
  if (t.id === 'restorefile' && t.files[0]) {
    try {
      const data = JSON.parse(await t.files[0].text());
      if (!Array.isArray(data.entries) || !Array.isArray(data.categories)) throw new Error("That doesn't look like a Household App backup.");
      if (!confirm(`Replace everything on this phone with this backup (${data.entries.length} entries)?`)) return;
      state = { ...store.newState(), ...data, settings: { ...store.newState().settings, ...data.settings } };
      persist(); toast('Backup restored'); location.hash = '#home';
    } catch (e) { fail(e); }
    t.value = '';
  }
});

window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); ui.install = e; if (location.hash === '#more') refresh(); });

// ------------------------------------------------------------------ start

(async function start() {
  if (loaded.problem) toast(loaded.problem);
  if (navigator.storage?.persist) navigator.storage.persist().catch(() => {});
  if ('serviceWorker' in navigator && location.protocol !== 'file:') navigator.serviceWorker.register('./sw.js').catch(() => {});
  route();
  if (new URLSearchParams(location.search).has('shared') && 'caches' in window) {   // a chat was shared TO the app
    try {
      const cache = await caches.open('household-shared');
      const res = await cache.match('shared-chat');
      if (res) { const buf = await res.arrayBuffer(); await cache.delete('shared-chat'); history.replaceState(null, '', location.pathname);
        let name = ''; try { name = decodeURIComponent(res.headers.get('x-filename') || ''); } catch { /* ignore */ }
        await stageFromBuffer(buf, name); }
    } catch (e) { fail(e); }
  }
})();

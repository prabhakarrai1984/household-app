// All data lives in one object, saved as JSON on THIS phone (localStorage). Nothing is sent anywhere.
import { DEFAULT_CATEGORIES, UNCATEGORIZED, INCOME } from './parser.js';

export const KEY = 'household.v1';

export function newState() {
  return {
    version: 1, nextId: 1,
    categories: structuredClone(DEFAULT_CATEGORIES),
    members: [], entries: [], ignoredKeys: [], recurring: [], changes: [],
    settings: { me: '', shareAfterSave: true },
  };
}

/** Returns {state, problem}. A damaged save is copied aside first, never silently overwritten. */
export function load(storage) {
  let raw = null;
  try { raw = storage.getItem(KEY); } catch { /* storage blocked */ }
  if (!raw) return { state: newState(), problem: null };
  try {
    const data = JSON.parse(raw);
    return { state: { ...newState(), ...data, settings: { ...newState().settings, ...data.settings } }, problem: null };
  } catch {
    try { storage.setItem(KEY + '.damaged', raw); } catch { /* ignore */ }
    return { state: newState(), problem: 'Your saved data could not be read. A copy was kept aside; restore from a backup file if you have one.' };
  }
}

export function save(storage, state) {
  try { storage.setItem(KEY, JSON.stringify(state)); return true; } catch { return false; }
}

const now = () => new Date().toISOString();
const clean = (e) => structuredClone(e);

// ---------------------------------------------------------------- entries

export function pushEntry(state, e) {
  const entry = {
    id: state.nextId++, date: e.date, amount: Math.round(e.amount * 100) / 100, category: e.category,
    description: e.description || '', addedBy: e.addedBy || '', type: e.type || 'Expense',
    sourceKey: e.sourceKey || null, createdAt: now(),
  };
  state.entries.push(entry);
  return entry;
}

/** Returns the new entry, or null if this chat message was already saved or deleted before. */
export function addEntry(state, e) {
  if (e.sourceKey && (state.ignoredKeys.includes(e.sourceKey) || state.entries.some((x) => x.sourceKey === e.sourceKey))) return null;
  return pushEntry(state, e);
}

export const getEntry = (state, id) => state.entries.find((e) => e.id === id) || null;

/** The person's own latest typed entry (imported ones are never touched by undo/edit). */
export function lastEntryBy(state, person) {
  for (let i = state.entries.length - 1; i >= 0; i--) {
    const e = state.entries[i];
    if (e.addedBy === person && !e.sourceKey) return e;
  }
  return null;
}

export function updateEntry(state, id, by, fields) {
  const entry = getEntry(state, id);
  if (!entry) return null;
  const before = clean(entry);
  for (const k of ['date', 'amount', 'category', 'description']) if (k in fields) entry[k] = fields[k];
  state.changes.push({ at: now(), by, action: 'edit', entryId: id, before, after: clean(entry) });
  return entry;
}

export function deleteEntry(state, id, by) {
  const i = state.entries.findIndex((e) => e.id === id);
  if (i < 0) return null;
  const [entry] = state.entries.splice(i, 1);
  if (entry.sourceKey && !state.ignoredKeys.includes(entry.sourceKey)) state.ignoredKeys.push(entry.sourceKey);
  state.changes.push({ at: now(), by, action: 'delete', entryId: id, before: clean(entry), after: null });
  return entry;
}

export function describeChange(c) {
  const b = c.before;
  const what = `${b.description || b.category} (₹${b.amount})`;
  if (c.action === 'delete') return `${c.by} deleted ${what}`;
  const diffs = ['date', 'amount', 'category', 'description'].filter((k) => b[k] !== c.after[k])
    .map((k) => `${k} ${b[k]} → ${c.after[k]}`);
  return `${c.by} changed ${what}: ${diffs.join(', ') || 'no change'}`;
}

// ---------------------------------------------------------------- family

const digits = (s) => (s || '').replace(/\D/g, '');

export function addMember(state, { name, chatName = '', phone = '' }) {
  name = (name || '').trim();
  if (!name) throw new Error('A name is needed.');
  if (state.members.some((m) => m.name.toLowerCase() === name.toLowerCase())) throw new Error(`${name} is already on the list.`);
  const m = { id: state.nextId++, name, chatName: chatName.trim(), phone: phone.trim(), active: true };
  state.members.push(m);
  return m;
}

/** Matches by app name, WhatsApp name, or phone (last 10 digits). */
export function matchMember(sender, members) {
  const wanted = (sender || '').trim().toLowerCase();
  const sd = digits(sender);
  for (const m of members) {
    const names = new Set([m.name.toLowerCase(), (m.chatName || '').toLowerCase()]);
    names.delete('');
    if (names.has(wanted)) return m;
    const md = digits(m.phone);
    if (sd.length >= 10 && md.length >= 10 && sd.slice(-10) === md.slice(-10)) return m;
  }
  return null;
}

// ---------------------------------------------------------------- categories

export function allCategoryNames(state) {
  return [...state.categories.map((c) => c.name), UNCATEGORIZED];
}

const splitWords = (text) => (Array.isArray(text) ? text : String(text || '').split(','))
  .map((w) => w.trim().toLowerCase()).filter(Boolean);

export function addCategory(state, name, keywords = '') {
  name = (name || '').trim().replace(/\s+/g, ' ');
  if (!name) throw new Error('Give the category a name.');
  if (name.length > 30) throw new Error('Keep the name under 30 characters.');
  if ([...allCategoryNames(state), INCOME].some((n) => n.toLowerCase() === name.toLowerCase())) throw new Error(`"${name}" already exists.`);
  const c = { name, names: [name.toLowerCase()], keywords: splitWords(keywords) };
  state.categories.push(c);
  return c;
}

export function updateCategory(state, oldName, { name, keywords }) {
  const c = state.categories.find((x) => x.name === oldName);
  if (!c) throw new Error('No such category.');
  if (keywords !== undefined) c.keywords = splitWords(keywords);
  name = (name ?? oldName).trim().replace(/\s+/g, ' ');
  if (name && name !== oldName) {
    if ([...allCategoryNames(state), INCOME].some((n) => n.toLowerCase() === name.toLowerCase())) throw new Error(`"${name}" already exists.`);
    c.name = name;
    c.names = [name.toLowerCase()];
    for (const e of state.entries) if (e.category === oldName) e.category = name;
    for (const r of state.recurring) if (r.category === oldName) r.category = name;
  }
  return c;
}

/** Entries in a deleted category become Uncategorized; nothing is lost. */
export function deleteCategory(state, name) {
  const i = state.categories.findIndex((c) => c.name === name);
  if (i < 0) return 0;
  state.categories.splice(i, 1);
  let moved = 0;
  for (const e of state.entries) if (e.category === name) { e.category = UNCATEGORIZED; moved++; }
  for (const r of state.recurring) if (r.category === name) r.category = UNCATEGORIZED;
  return moved;
}

export function resetCategories(state) {
  const keepCustom = state.categories.filter((c) => !DEFAULT_CATEGORIES.some((d) => d.name === c.name));
  state.categories = [...structuredClone(DEFAULT_CATEGORIES), ...keepCustom];
}

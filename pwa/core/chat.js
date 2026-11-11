// Reads an exported WhatsApp chat. The group chat is the shared ledger: every phone that imports the
// same chat replays it in order (including undo / edit) and gets the same result.
import { isValidDate, ymd, pad } from './dates.js';
import { INCOME, ParseError, UNCATEGORIZED, parseEdit, parseMessage } from './parser.js';
import { matchMember } from './store.js';

const MAX_EXPORT_BYTES = 20 * 1024 * 1024;
const HEADER = /^\[?(?<a>\d{1,2})[/.\-](?<b>\d{1,2})[/.\-](?<year>\d{2,4}),?\s+(?<hour>\d{1,2})[:.](?<minute>\d{2})(?::(?<second>\d{2}))?\s*(?<ampm>[ap]\.?m\.?)?\]?\s*(?:-\s*)?(?<rest>.*)$/i;
// Messages copied from the chat on Android look different: "[10:12 am, 11/11/2026] Name: text" (time first).
const HEADER_TIME_FIRST = /^\[?(?<hour>\d{1,2})[:.](?<minute>\d{2})(?::(?<second>\d{2}))?\s*(?<ampm>[ap]\.?m\.?)?,\s*(?<a>\d{1,2})[/.\-](?<b>\d{1,2})[/.\-](?<year>\d{2,4})\]?\s*(?:-\s*)?(?<rest>.*)$/i;
const headerMatch = (line) => HEADER.exec(line) || HEADER_TIME_FIRST.exec(line);
const SKIPPED = /^(?:<?media omitted>?|<?(?:image|video|audio|sticker|gif|document) omitted>?|this message was deleted\.?|you deleted this message\.?|null)$/i;
const CURRENCY = /₹|\brs\.?\s*\d|\binr\b/i;
const SPENDING_VERB = /\b(?:spent|paid|bought)\b/i;

// ---------------------------------------------------------------- reading files (.txt or .zip)

async function inflateRaw(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Minimal zip reader: finds the first .txt (preferring _chat.txt). */
export async function readExport(buffer) {
  let bytes = new Uint8Array(buffer);
  if (bytes[0] === 0x50 && bytes[1] === 0x4b) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let eocd = -1;
    for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) if (view.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    if (eocd < 0) throw new Error("That file looks like a zip, but it couldn't be opened.");
    const count = view.getUint16(eocd + 10, true);
    let p = view.getUint32(eocd + 16, true);
    const files = [];
    for (let n = 0; n < count; n++) {
      if (view.getUint32(p, true) !== 0x02014b50) break;
      const method = view.getUint16(p + 10, true), size = view.getUint32(p + 20, true);
      const nameLen = view.getUint16(p + 28, true), extraLen = view.getUint16(p + 30, true), commentLen = view.getUint16(p + 32, true);
      const offset = view.getUint32(p + 42, true);
      const name = new TextDecoder().decode(bytes.subarray(p + 46, p + 46 + nameLen));
      files.push({ name, method, size, offset });
      p += 46 + nameLen + extraLen + commentLen;
    }
    const texts = files.filter((f) => !f.name.endsWith('/') && f.name.toLowerCase().endsWith('.txt'))
      .sort((a, b) => (Number(!a.name.endsWith('_chat.txt')) - Number(!b.name.endsWith('_chat.txt'))) || a.name.localeCompare(b.name));
    if (!texts.length) throw new Error("That zip file doesn't contain a chat text file.");
    const f = texts[0];
    const nameLen = view.getUint16(f.offset + 26, true), extraLen = view.getUint16(f.offset + 28, true);
    const data = bytes.subarray(f.offset + 30 + nameLen + extraLen, f.offset + 30 + nameLen + extraLen + f.size);
    if (f.method === 0) bytes = data;
    else if (f.method === 8) bytes = await inflateRaw(data);
    else throw new Error('That zip uses a compression the app cannot read.');
  }
  if (bytes.length > MAX_EXPORT_BYTES) throw new Error("That chat file is too large (limit 20 MB). Export 'Without media'.");
  return new TextDecoder('utf-8').decode(bytes).replace(/^﻿/, '');
}

// ---------------------------------------------------------------- parsing

const normalize = (line) => line.replace(/[  ]/g, ' ').replace(/[‎‏﻿]/g, '').replace(/[\r\n]+$/, '');

function detectDayFirst(lines) {
  for (const line of lines) {
    const m = headerMatch(line);
    if (m) {
      if (Number(m.groups.a) > 12) return true;
      if (Number(m.groups.b) > 12) return false;
    }
  }
  return true; // all ambiguous: assume day first (India)
}

function buildWhen(g, dayFirst) {
  const first = Number(g.a), second = Number(g.b);
  const [day, month] = dayFirst ? [first, second] : [second, first];
  let year = Number(g.year); if (year < 100) year += 2000;
  let hour = Number(g.hour); const minute = Number(g.minute);
  const ampm = (g.ampm || '').replace(/\./g, '').toLowerCase();
  if (ampm === 'pm' && hour < 12) hour += 12;
  if (ampm === 'am' && hour === 12) hour = 0;
  if (!isValidDate(year, month, day) || hour > 23 || minute > 59) return null;
  return { date: ymd(year, month, day), minuteKey: `${ymd(year, month, day)} ${pad(hour)}:${pad(minute)}` };
}

export function parseChat(text) {
  const lines = text.split('\n').map(normalize);
  const dayFirst = detectDayFirst(lines);
  const messages = [];
  let current = null;
  for (const line of lines) {
    const h = headerMatch(line);
    const when = h ? buildWhen(h.groups, dayFirst) : null;
    if (when) {
      if (current) messages.push(current);
      const rest = h.groups.rest, at = rest.indexOf(': ');
      // no "Name: " means a system notice ("Messages are end-to-end encrypted...")
      current = at >= 0 ? { ...when, sender: rest.slice(0, at).trim(), text: rest.slice(at + 2) } : null;
    } else if (current) current.text += '\n' + line;
  }
  if (current) messages.push(current);
  return messages;
}

// ---------------------------------------------------------------- fingerprint (sync, no libraries)

function cyrb53(str, seed = 0) {
  let h1 = 0xdeadbeef ^ seed, h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761); h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16).padStart(14, '0');
}
// Minute resolution, because Android exports have no seconds and iPhone exports do:
// the same message in two overlapping exports gets the same key.
const fingerprint = (member, minuteKey, body, n) => {
  const raw = `${member}|${minuteKey}|${body}|${n}`;
  return cyrb53(raw) + cyrb53(raw, 7);
};

const cleanBody = (t) => t.trim().replace(/\s*<This message was edited>\s*$/, '').trim();

function looksLikeExpense(body, parsed) {
  if (body.includes('?') || body.split(/\s+/).length > 12) return false;
  return CURRENCY.test(body) || SPENDING_VERB.test(body) || parsed.category !== UNCATEGORIZED;
}

/**
 * Replays the chat in order and returns what it would add. Nothing is saved yet.
 * With no family list yet, everyone in the chat counts.
 */
export function stageImport(state, text) {
  const members = state.members.filter((m) => m.active);
  const saved = new Set([...state.ignoredKeys, ...state.entries.map((e) => e.sourceKey).filter(Boolean)]);
  const messages = parseChat(text);
  const summary = { messagesRead: messages.length, candidates: 0, likely: 0, alreadyImported: 0, undone: 0, edited: 0, ignoredSenders: {} };
  const rows = [];
  const history = {}; // per person: their entries so far (null = saved earlier, so left alone)
  const occurrences = new Map();
  const categories = state.categories;

  for (const msg of messages) {
    const body = cleanBody(msg.text);
    if (!body || SKIPPED.test(body)) continue;
    const who = members.length ? matchMember(msg.sender, members) : { name: msg.sender };
    const command = body.toLowerCase();
    if (command === 'undo' || command.startsWith('edit')) {
      if (!who) continue;
      const stack = history[who.name] || [];
      if (command === 'undo') {
        if (stack.length) {
          const target = stack.pop();
          if (target) { rows.splice(rows.indexOf(target), 1); summary.undone++; }
        }
      } else {
        let changes;
        try { changes = parseEdit(body, { today: msg.date, categories }); } catch (e) { if (e instanceof ParseError) continue; throw e; }
        const target = stack[stack.length - 1];
        if (target) {
          if (changes.amount !== undefined) target.amount = changes.amount;
          if (changes.category && target.type !== 'Income') target.category = changes.category;
          if (changes.date) target.date = changes.date;
          target.likely = true; summary.edited++;
        }
      }
      continue;
    }
    let parsed;
    try { parsed = parseMessage(body, { today: msg.date, categories }); } catch (e) { if (e instanceof ParseError) continue; throw e; }
    if (!who) { summary.ignoredSenders[msg.sender] = (summary.ignoredSenders[msg.sender] || 0) + 1; continue; }

    const seen = `${who.name}|${msg.minuteKey}|${body}`;
    const n = occurrences.get(seen) || 0; occurrences.set(seen, n + 1);
    const key = fingerprint(who.name, msg.minuteKey, body, n);
    (history[who.name] ||= []);
    if (saved.has(key)) { summary.alreadyImported++; history[who.name].push(null); continue; }
    const row = { sourceKey: key, date: parsed.date, amount: parsed.amount, category: parsed.category, type: parsed.type,
      description: parsed.description, originalText: body.replace(/\s+/g, ' '), addedBy: who.name, likely: looksLikeExpense(body, parsed),
      // You typed it in the app yourself AND posted it to the group: don't count it twice.
      maybeDuplicate: state.entries.some((e) => !e.sourceKey && e.addedBy === who.name && e.amount === parsed.amount && e.date === parsed.date && e.type === parsed.type) };
    rows.push(row); history[who.name].push(row);
  }
  summary.candidates = rows.length;
  summary.likely = rows.filter((r) => r.likely).length;
  rows.sort((a, b) => a.date.localeCompare(b.date));
  return { rows, summary };
}

/** Saves the chosen rows. Returns {saved, duplicates}. */
export function confirmImport(state, rows, selected, overrides = {}, pushEntry) {
  const allowed = new Set([...state.categories.map((c) => c.name), UNCATEGORIZED]);
  const have = new Set([...state.ignoredKeys, ...state.entries.map((e) => e.sourceKey).filter(Boolean)]);
  let saved = 0, duplicates = 0;
  rows.forEach((row, i) => {
    if (!selected.has(i)) return;
    if (have.has(row.sourceKey)) { duplicates++; return; }
    let category = overrides[i] ?? row.category;
    if (!allowed.has(category) || row.type === 'Income') category = row.category;
    pushEntry(state, { ...row, category });
    have.add(row.sourceKey); saved++;
  });
  return { saved, duplicates };
}
export { INCOME };

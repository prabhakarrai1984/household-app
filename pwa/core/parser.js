// Turns "Spent 450 on vegetables yesterday" into a structured entry.
// Same rules as the Python prototype, plus categories you can add and edit.
import { addDays } from './dates.js';

export const UNCATEGORIZED = 'Uncategorized';
export const INCOME = 'Income';
export class ParseError extends Error {}

// `names` = words that name the category directly (these WIN); `keywords` = everyday hints.
export const DEFAULT_CATEGORIES = [
  { name: 'Investment', names: ['investment', 'investments'],
    keywords: ['sip', 'mutual fund', 'mutual funds', 'stock', 'stocks', 'shares', 'fd', 'fixed deposit', 'ppf', 'nps', 'gold', 'invest'] },
  { name: 'Grocery', names: ['grocery', 'groceries'],
    keywords: ['vegetable', 'vegetables', 'fruit', 'fruits', 'milk', 'rice', 'atta', 'dal', 'oil', 'bread', 'eggs',
      'supermarket', 'bigbasket', 'blinkit', 'zepto', 'kirana', 'tomato', 'tomatoes', 'onion', 'onions', 'potato',
      'potatoes', 'paneer', 'curd', 'sugar', 'salt', 'dhaniya', 'mirchi', 'cauliflower', 'gobi', 'bottle gourd',
      'lauki', 'palak', 'bhindi', 'sabzi', 'sabji', 'dmart', 'd mart', 'd-mart', 'ghee', 'honey', 'soap'] },
  { name: 'Medicine', names: ['medicine', 'medicines'],
    keywords: ['medical', 'pharmacy', 'doctor', 'tablet', 'tablets', 'hospital', 'clinic', 'chemist', 'apollo'] },
  { name: 'School Fees', names: ['school fees', 'school fee'], keywords: ['school'] },
  { name: 'Study', names: ['study'],
    keywords: ['tuition', 'course', 'books', 'book', 'stationery', 'exam', 'coaching', 'class'] },
  { name: 'Entertainment', names: ['entertainment'],
    keywords: ['movie', 'movies', 'netflix', 'prime', 'hotstar', 'spotify', 'game', 'games', 'concert', 'party',
      'restaurant', 'dining', 'outing'] },
  { name: 'Clothes', names: ['clothes'],
    keywords: ['clothing', 'shirt', 'shirts', 'jeans', 'saree', 'dress', 'shoes', 'footwear', 'tshirt', 'kurta'] },
  { name: 'Travel', names: ['travel'],
    keywords: ['train', 'flight', 'bus', 'ticket', 'tickets', 'hotel', 'trip', 'cab', 'uber', 'ola', 'taxi', 'metro', 'auto'] },
  { name: 'Vehicle', names: ['vehicle'],
    keywords: ['petrol', 'diesel', 'fuel', 'car', 'bike', 'servicing', 'car service', 'bike service', 'tyre',
      'parking', 'fastag', 'puncture', 'engine oil'] },
  { name: 'Gift', names: ['gift', 'gifts'],
    keywords: ['present', 'birthday', 'wedding', 'anniversary', 'dooj', 'rakhi', 'diwali gift'] },
];

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function earliest(low, categories, field) {
  let best = null;
  for (const category of categories) {
    for (const word of category[field] || []) {
      const w = word.trim().toLowerCase();
      if (!w) continue;
      // Unicode-aware word edges, so Hindi (or any language) keywords work too.
      const found = new RegExp(`(?<![\\p{L}\\p{N}_])${escapeRe(w)}(?![\\p{L}\\p{N}_])`, 'u').exec(low);
      if (found && (best === null || found.index < best.at)) best = { at: found.index, name: category.name };
    }
  }
  return best ? best.name : null;
}

export function categorize(text, categories = DEFAULT_CATEGORIES) {
  const low = text.toLowerCase();
  return earliest(low, categories, 'names') || earliest(low, categories, 'keywords') || UNCATEGORIZED;
}

const UNITS = '(?:kg|kgs|g|gm|gms|l|ltr|ltrs|litre|litres|pcs|pc|dozen|x)';
const AMOUNT_SRC = String.raw`(?<![\w.:/])(?<cur>₹|rs\.?|inr)?\s*(?<num>\d[\d,]*(?:\.\d+)?)\s*(?<k>k(?![a-z]))?(?<unit>\s*${UNITS}\b)?`;
const TIME_OR_DATE_TAIL = /(?:\s*(?:am|pm|a\.m\.|p\.m\.|o'clock)\b|[:/\-]\d)/iy;

export function findAmount(text) {
  for (const m of text.matchAll(new RegExp(AMOUNT_SRC, 'gid'))) {
    if (m.groups.unit && !m.groups.cur) continue; // "2 kg" is a quantity
    TIME_OR_DATE_TAIL.lastIndex = m.indices.groups.num[1];
    if (TIME_OR_DATE_TAIL.test(text)) continue; // "7 pm", "8:30", "15/11"
    let amount = parseFloat(m.groups.num.replace(/,/g, ''));
    if (m.groups.k) amount *= 1000;
    return { amount, start: m.index, end: m.index + m[0].length };
  }
  return null;
}

function cleanDescription(text, found, category) {
  let left = text.slice(0, found.start) + ' ' + text.slice(found.end);
  left = left.replace(/\b(yesterday|today)\b/gi, ' ')
    .replace(/\b(spent|paid|bought|expense|rs|inr)\b/gi, ' ')
    .replace(/^(?:\s*(?:on|for|at|of|in|to|the|a)\b)+/i, '');
  left = left.replace(/\s+/g, ' ').trim().replace(/^[ ,.\-:;]+|[ ,.\-:;]+$/g, '');
  if (!left) return category !== UNCATEGORIZED && category !== INCOME ? category : 'Expense';
  return left[0].toUpperCase() + left.slice(1);
}

const INCOME_START = /^\s*(income|salary)\b(?!\s+tax)/i;

/** -> {amount, category, description, date, type}. Throws ParseError with a friendly message. */
export function parseMessage(text, { today, categories = DEFAULT_CATEGORIES } = {}) {
  text = (text || '').trim();
  if (!text) throw new ParseError('The message was empty.');
  const start = INCOME_START.exec(text);
  const type = start ? 'Income' : 'Expense';
  if (start && start[1].toLowerCase() === 'income') text = text.slice(start[0].length).replace(/^[ :-]+|[ :-]+$/g, '');

  const found = findAmount(text);
  if (!found || found.amount <= 0) throw new ParseError("I couldn't find an amount in that message.");

  let date = today;
  if (/\byesterday\b/i.test(text)) date = addDays(today, -1);
  const category = type === 'Income' ? INCOME : categorize(text, categories);
  return {
    amount: Math.round(found.amount * 100) / 100, category,
    description: cleanDescription(text, found, category), date, type,
  };
}

/** 'edit 500', 'edit gift', 'edit 500 gift', 'edit yesterday' -> fields to change */
export function parseEdit(text, { today, categories = DEFAULT_CATEGORIES } = {}) {
  const body = (text || '').trim().replace(/^\s*edit\b/i, '').trim();
  const changes = {};
  const found = findAmount(body);
  if (found) {
    if (found.amount <= 0) throw new ParseError('The amount must be more than zero.');
    changes.amount = Math.round(found.amount * 100) / 100;
  }
  const category = categorize(body, categories);
  if (category !== UNCATEGORIZED) changes.category = category;
  if (/\byesterday\b/i.test(body)) changes.date = addDays(today, -1);
  else if (/\btoday\b/i.test(body)) changes.date = today;
  if (!Object.keys(changes).length) {
    throw new ParseError('Tell me what to change, for example: edit 500, edit grocery, edit 500 grocery or edit yesterday.');
  }
  return changes;
}

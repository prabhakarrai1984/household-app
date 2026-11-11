// What the family ate: a simple meal log, gentle alerts, and ideas for something different.
// These are plain word-based rules for everyday awareness. They are NOT medical or dietary advice.
import { addDays, diffDays } from './dates.js';
import { ParseError, findAmount } from './parser.js';

export const MEALS = ['Breakfast', 'Lunch', 'Snacks', 'Dinner'];
export const PLACES = ['Home', 'Outside', 'Ordered'];
export const DEFAULT_FOOD_SETTINGS = { windowDays: 7, outsideMax: 3, unhealthyStreak: 3, repeatMax: 2, diet: 'any' };

// ------------------------------------------------------------------ words

// Everyday dishes sorted into lighter and heavier. Edit the lists in the app (Kitchen -> Meals -> Food words).
export const DEFAULT_WORDS = {
  healthy: ['dal', 'daal', 'sabzi', 'sabji', 'vegetable', 'vegetables', 'veg', 'salad', 'fruit', 'fruits', 'apple', 'banana', 'papaya',
    'orange', 'guava', 'curd', 'dahi', 'raita', 'roti', 'chapati', 'chapatti', 'phulka', 'khichdi', 'khichri', 'daliya', 'dalia', 'oats',
    'poha', 'upma', 'idli', 'sambar', 'dosa', 'uttapam', 'sprouts', 'moong', 'chana', 'chole', 'rajma', 'lobia', 'paneer', 'egg', 'eggs',
    'omelette', 'soup', 'buttermilk', 'chaas', 'lauki', 'palak', 'methi', 'bhindi', 'gobi', 'chilla', 'thepla', 'makhana', 'dhokla', 'ragi'],
  less: ['pizza', 'burger', 'fries', 'french fries', 'samosa', 'kachori', 'pakora', 'pakoda', 'pakode', 'bhajiya', 'bhajji', 'vada pav',
    'chips', 'kurkure', 'namkeen', 'bhujia', 'maggi', 'noodles', 'chowmein', 'chow mein', 'cold drink', 'coke', 'pepsi', 'sprite', 'soda',
    'soft drink', 'ice cream', 'icecream', 'cake', 'pastry', 'brownie', 'gulab jamun', 'jalebi', 'rasgulla', 'laddu', 'mithai', 'sweets',
    'chocolate', 'puri', 'poori', 'bhature', 'bhatura', 'pani puri', 'golgappa', 'pav bhaji', 'shawarma', 'nuggets', 'fried rice',
    'manchurian', 'kathi roll', 'junk', 'fast food', 'fried', 'deep fried', 'street food'],
  // eaten every day, so never reported as "repeating"
  staples: ['roti', 'chapati', 'chapatti', 'phulka', 'rice', 'dal', 'daal', 'sabzi', 'sabji', 'curd', 'dahi', 'salad', 'tea', 'chai',
    'coffee', 'milk', 'water', 'vegetable', 'vegetables'],
};
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const hit = (text, words) => words.some((w) => new RegExp(`(?<![\\p{L}\\p{N}])${esc(w.toLowerCase())}(?![\\p{L}\\p{N}])`, 'u').test(text));
export const wordsFor = (state) => ({
  healthy: [...DEFAULT_WORDS.healthy, ...(state.foodWords?.healthy || [])],
  less: [...DEFAULT_WORDS.less, ...(state.foodWords?.less || [])],
  staples: DEFAULT_WORDS.staples,
});

/** 'healthy' | 'less' | 'mixed' | 'unknown' for one dish text, e.g. "dal rice" or "pizza". */
export function classify(text, words = DEFAULT_WORDS) {
  const low = String(text).toLowerCase();
  const good = hit(low, words.healthy), bad = hit(low, words.less);
  return good && bad ? 'mixed' : bad ? 'less' : good ? 'healthy' : 'unknown';
}

// ------------------------------------------------------------------ reading a message

const MEAL_WORD = /^\s*(breakfast|brunch|lunch|snacks?|dinner|supper)\b\s*[:\-–]?\s*(.*)$/is;
const MEAL_NAME = { breakfast: 'Breakfast', brunch: 'Breakfast', lunch: 'Lunch', snack: 'Snacks', snacks: 'Snacks', dinner: 'Dinner', supper: 'Dinner' };
const ORDERED = /\b(ordered|order|zomato|swiggy|delivery|delivered|takeaway|take-away|parcel|dominos|domino's)\b/i;
const OUTSIDE = /\b(outside|restaurant|hotel|dhaba|cafe|café|canteen|mess|party|dining out|dine out|ate out|eating out)\b/i;
const HOME = /\b(home|ghar|homemade|home-made|made at home)\b/i;

/**
 * "dinner outside pizza", "lunch: dal rice at home", "breakfast yesterday poha" -> {meal, place, dish, date}
 * Returns null when the message isn't about a meal. A message with a real amount ("lunch 250", "dinner 1200 hotel")
 * is an expense, not a meal. Small numbers ("lunch 2 roti dal") are food.
 */
export function parseMeal(text, { today }) {
  const m = MEAL_WORD.exec((text || '').trim());
  if (!m) return null;
  const rest = m[2];
  const amount = findAmount(rest);
  if (amount && (/₹|\brs\.?\s*\d|\binr\b/i.test(rest) || amount.amount >= 20)) return null;
  let date = today;
  if (/\byesterday\b/i.test(rest)) date = addDays(today, -1);
  const place = ORDERED.test(rest) ? 'Ordered' : OUTSIDE.test(rest) ? 'Outside' : 'Home';
  const all = (re) => new RegExp(re.source, 'gi');
  let dish = rest.replace(/\b(yesterday|today)\b/gi, ' ').replace(all(ORDERED), ' ').replace(all(OUTSIDE), ' ').replace(all(HOME), ' ')
    .replace(/\b(at|from|in|had|ate|eating|was|we|i)\b/gi, ' ').replace(/\s+/g, ' ').replace(/^[\s,.\-:;]+|[\s,.\-:;]+$/g, '');
  if (!dish) throw new ParseError('Tell me what you had, for example: lunch dal rice at home, or dinner outside pizza.');
  dish = dish[0].toUpperCase() + dish.slice(1);
  return { meal: MEAL_NAME[m[1].toLowerCase()], place, dish, date };
}

/** "dal, rice and sabzi" -> ['dal', 'rice', 'sabzi'] */
export const splitDish = (dish) => String(dish).split(/\s*(?:,|\+|&|\band\b|\bwith\b)\s*/i).map((s) => s.trim()).filter(Boolean);

// ------------------------------------------------------------------ the log

export function addMeal(state, { date, meal, place = 'Home', dish, addedBy = '' }) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '')) throw new Error('Pick the date.');
  if (!MEALS.includes(meal)) throw new Error('Pick breakfast, lunch, snacks or dinner.');
  if (!PLACES.includes(place)) throw new Error('Pick home, outside or ordered.');
  dish = String(dish || '').trim();
  if (!dish) throw new Error('Write what you had.');
  const entry = { id: state.nextId++, date, meal, place, dish: dish[0].toUpperCase() + dish.slice(1), addedBy };
  state.meals.push(entry);
  return entry;
}
export const deleteMeal = (state, id) => { state.meals = state.meals.filter((m) => m.id !== id); };
const order = (m) => MEALS.indexOf(m.meal);
export const sortedMeals = (meals) => [...meals].sort((a, b) => a.date.localeCompare(b.date) || order(a) - order(b) || a.id - b.id);
export const newestFirstMeals = (meals) => sortedMeals(meals).reverse();

// ------------------------------------------------------------------ alerts

const norm = (s) => s.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();

/**
 * Looks at the last `windowDays` days and returns gentle alerts:
 *  - outside: too many meals eaten outside or ordered in
 *  - unhealthy: several lighter-than-ideal meals in a row
 *  - repeat: the same dish again and again (daily staples like roti or dal are ignored)
 * Each alert carries ideas for something different when there are any.
 */
export function foodAlerts(state, today, { stockKeys = [], settings = {} } = {}) {
  const cfg = { ...DEFAULT_FOOD_SETTINGS, ...(state.settings?.food || {}), ...settings };
  const words = wordsFor(state);
  const from = addDays(today, -(cfg.windowDays - 1));
  const recent = sortedMeals(state.meals.filter((m) => m.date >= from && m.date <= today));
  const alerts = [];
  const ideas = (meal, avoid, quick = false) => suggest(state, { meal, today, stockKeys, avoid, diet: cfg.diet, quick, count: 3 }).map((d) => d.name);

  const outside = recent.filter((m) => m.place !== 'Home');
  if (outside.length > cfg.outsideMax) {
    const days = cfg.windowDays;
    alerts.push({ type: 'outside', level: 'warn', count: outside.length, total: recent.length,
      text: `${outside.length} of your last ${recent.length} meals (in ${days} days) were eaten outside or ordered in.`,
      ideas: ideas('Dinner', [], true), ideasLabel: 'Quick meals to make at home' });
  }

  let streak = 0;
  for (let i = recent.length - 1; i >= 0 && classify(recent[i].dish, words) === 'less'; i--) streak++;
  if (streak >= cfg.unhealthyStreak) {
    const next = MEALS[(MEALS.indexOf(recent[recent.length - 1].meal) + 1) % MEALS.length];
    alerts.push({ type: 'unhealthy', level: 'warn', count: streak,
      text: `${streak} meals in a row were on the heavier or fried side (${recent.slice(-streak).map((m) => m.dish.toLowerCase()).join(', ')}).`,
      ideas: ideas(next, []), ideasLabel: `Lighter ideas for ${next.toLowerCase()}` });
  }

  const counts = new Map();
  for (const m of recent) {
    const seen = new Set();
    for (const part of splitDish(m.dish)) {
      const k = norm(part);
      if (!k || seen.has(k) || hit(k, words.staples) && k.split(' ').length === 1) continue;
      if (k.split(' ').every((w) => words.staples.includes(w))) continue;
      seen.add(k);
      const c = counts.get(k) || { n: 0, meals: {} }; c.n++; c.meals[m.meal] = (c.meals[m.meal] || 0) + 1; counts.set(k, c);
    }
  }
  for (const [k, c] of [...counts].sort((a, b) => b[1].n - a[1].n)) {
    if (c.n <= cfg.repeatMax) continue;
    const meal = Object.entries(c.meals).sort((a, b) => b[1] - a[1])[0][0];
    alerts.push({ type: 'repeat', level: 'info', item: k, count: c.n,
      text: `${k[0].toUpperCase() + k.slice(1)} came up ${c.n} times in the last ${cfg.windowDays} days.`,
      ideas: ideas(meal, [k]), ideasLabel: `Something different for ${meal.toLowerCase()}` });
  }
  return alerts;
}

export function alertText(a) {
  return a.text + (a.ideas?.length ? ` ${a.ideasLabel}: ${a.ideas.join(', ')}.` : '');
}

// ------------------------------------------------------------------ ideas

// name, meals, diet (veg / egg / nonveg), what it uses from the grocery list, a word to spot it in the log, quick?
const D = (name, meals, diet, uses, key, quick = false) => ({ name, meals, diet, uses, key, quick });
export const DISHES = [
  D('Vegetable poha', ['Breakfast', 'Snacks'], 'veg', ['onion', 'potato'], 'poha', true),
  D('Vegetable upma', ['Breakfast'], 'veg', ['onion'], 'upma', true),
  D('Moong dal chilla', ['Breakfast'], 'veg', ['dal', 'onion'], 'chilla'),
  D('Besan chilla with curd', ['Breakfast'], 'veg', ['curd', 'onion'], 'chilla'),
  D('Idli with sambar', ['Breakfast', 'Dinner'], 'veg', ['dal', 'rice'], 'idli'),
  D('Dosa with chutney', ['Breakfast', 'Dinner'], 'veg', ['rice', 'dal'], 'dosa'),
  D('Oats porridge with fruit', ['Breakfast'], 'veg', ['milk'], 'oats', true),
  D('Daliya (broken wheat) porridge', ['Breakfast'], 'veg', ['milk'], 'daliya', true),
  D('Paneer paratha with curd', ['Breakfast', 'Lunch'], 'veg', ['atta', 'paneer', 'curd'], 'paratha'),
  D('Methi thepla with curd', ['Breakfast', 'Dinner'], 'veg', ['atta', 'curd'], 'thepla'),
  D('Vegetable sandwich', ['Breakfast', 'Snacks'], 'veg', ['bread', 'tomato', 'onion'], 'sandwich', true),
  D('Egg bhurji with roti', ['Breakfast', 'Dinner'], 'egg', ['eggs', 'onion', 'tomato', 'atta'], 'bhurji', true),
  D('Boiled eggs and toast', ['Breakfast'], 'egg', ['eggs', 'bread'], 'egg', true),
  D('Masala omelette', ['Breakfast', 'Dinner'], 'egg', ['eggs', 'onion'], 'omelette', true),
  D('Dal tadka with roti and sabzi', ['Lunch', 'Dinner'], 'veg', ['dal', 'atta'], 'tadka'),
  D('Rajma chawal', ['Lunch', 'Dinner'], 'veg', ['rice', 'onion', 'tomato'], 'rajma'),
  D('Chole with roti', ['Lunch', 'Dinner'], 'veg', ['atta', 'onion', 'tomato'], 'chole'),
  D('Palak paneer with roti', ['Lunch', 'Dinner'], 'veg', ['paneer', 'atta'], 'palak'),
  D('Matar paneer with roti', ['Lunch', 'Dinner'], 'veg', ['paneer', 'atta'], 'matar'),
  D('Paneer bhurji with roti', ['Lunch', 'Dinner'], 'veg', ['paneer', 'atta', 'onion'], 'bhurji', true),
  D('Vegetable pulao with raita', ['Lunch', 'Dinner'], 'veg', ['rice', 'curd'], 'pulao', true),
  D('Moong dal khichdi with curd', ['Lunch', 'Dinner'], 'veg', ['rice', 'dal', 'curd'], 'khichdi', true),
  D('Lauki sabzi with dal and roti', ['Lunch', 'Dinner'], 'veg', ['dal', 'atta'], 'lauki'),
  D('Bhindi sabzi with roti', ['Lunch', 'Dinner'], 'veg', ['atta', 'onion'], 'bhindi'),
  D('Aloo gobi with roti', ['Lunch', 'Dinner'], 'veg', ['potato', 'atta'], 'gobi'),
  D('Baingan bharta with roti', ['Lunch', 'Dinner'], 'veg', ['atta', 'onion', 'tomato'], 'baingan'),
  D('Kadhi chawal', ['Lunch', 'Dinner'], 'veg', ['curd', 'rice'], 'kadhi'),
  D('Curd rice', ['Lunch', 'Dinner'], 'veg', ['curd', 'rice'], 'curd rice', true),
  D('Sambar rice', ['Lunch', 'Dinner'], 'veg', ['dal', 'rice'], 'sambar'),
  D('Soya chunk pulao', ['Lunch', 'Dinner'], 'veg', ['rice', 'onion'], 'soya'),
  D('Lobia curry with rice', ['Lunch', 'Dinner'], 'veg', ['rice', 'onion'], 'lobia'),
  D('Tomato soup with toast', ['Dinner', 'Snacks'], 'veg', ['tomato', 'bread'], 'soup', true),
  D('Egg curry with roti', ['Lunch', 'Dinner'], 'egg', ['eggs', 'atta', 'onion', 'tomato'], 'egg curry'),
  D('Chicken curry with roti', ['Lunch', 'Dinner'], 'nonveg', ['atta', 'onion', 'tomato'], 'chicken'),
  D('Fish curry with rice', ['Lunch', 'Dinner'], 'nonveg', ['rice', 'onion', 'tomato'], 'fish'),
  D('Roasted chana', ['Snacks'], 'veg', [], 'chana', true),
  D('Fruit chaat', ['Snacks'], 'veg', [], 'fruit', true),
  D('Sprouts chaat', ['Snacks'], 'veg', ['onion', 'tomato'], 'sprouts', true),
  D('Roasted makhana', ['Snacks'], 'veg', [], 'makhana', true),
  D('Dhokla', ['Snacks'], 'veg', [], 'dhokla'),
  D('Buttermilk (chaas)', ['Snacks'], 'veg', ['curd'], 'chaas', true),
  D('Corn chaat', ['Snacks'], 'veg', ['onion', 'tomato'], 'corn', true),
  D('Peanut chaat', ['Snacks'], 'veg', ['onion', 'tomato'], 'peanut', true),
  D('Banana with a handful of nuts', ['Snacks'], 'veg', [], 'banana', true),
];
const dietOk = (d, pref) => pref === 'any' || d.diet === 'veg' || (pref === 'egg' && d.diet === 'egg');
const hash = (s) => { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return Math.abs(h); };

/**
 * Up to `count` dishes for a meal: nothing you had in the last week, matching your diet,
 * liking dishes that use groceries you probably still have. The order rotates day by day.
 */
export function suggest(state, { meal, today, stockKeys = [], avoid = [], diet = 'any', quick = false, count = 3 }) {
  const from = addDays(today, -6);
  const eaten = norm(state.meals.filter((m) => m.date >= from).map((m) => m.dish).join(' , '));
  const avoided = avoid.map(norm);
  const stock = new Set(stockKeys);
  const pool = DISHES.filter((d) => d.meals.includes(meal) && dietOk(d, diet) && (!quick || d.quick)
    && !hit(eaten, [d.key]) && !avoided.some((a) => a && (a.includes(d.key) || d.name.toLowerCase().includes(a))));
  return pool.map((d) => ({ d, score: d.uses.filter((u) => stock.has(u)).length * 2 - d.uses.filter((u) => !stock.has(u) && stock.size).length * 0.5,
    tie: hash(d.name + today) })).sort((a, b) => b.score - a.score || a.tie - b.tie).slice(0, count).map((x) => x.d);
}

/** Which meal is next, by the hour of the day */
export const mealForHour = (h) => (h < 11 ? 'Breakfast' : h < 15 ? 'Lunch' : h < 18 ? 'Snacks' : 'Dinner');
export { diffDays };

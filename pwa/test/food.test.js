import test from 'node:test';
import assert from 'node:assert/strict';
import { parseMeal, classify, addMeal, foodAlerts, alertText, suggest, splitDish, mealForHour, deleteMeal, DISHES, MEALS } from '../core/food.js';
import { newState } from '../core/store.js';
import { handleMessage } from '../core/service.js';
import { ParseError } from '../core/parser.js';

const TODAY = '2026-11-10';
const fresh = () => newState();
const log = (s, date, meal, place, dish) => addMeal(s, { date, meal, place, dish, addedBy: 'Asha' });

test('meal messages: meal, place, dish, date', () => {
  const P = (t) => parseMeal(t, { today: TODAY });
  assert.deepEqual(P('dinner outside pizza'), { meal: 'Dinner', place: 'Outside', dish: 'Pizza', date: TODAY });
  assert.deepEqual(P('Lunch: dal rice at home'), { meal: 'Lunch', place: 'Home', dish: 'Dal rice', date: TODAY });
  assert.equal(P('breakfast yesterday poha').date, '2026-11-09');
  assert.equal(P('snacks ordered samosa from zomato').dish, 'Samosa'); assert.equal(P('snacks ordered samosa from zomato').place, 'Ordered');
  assert.equal(P('Dinner ordered biryani').place, 'Ordered'); assert.equal(P('lunch at the office canteen dal roti').place, 'Outside');
  assert.throws(() => P('dinner'), ParseError);
});

test('a message with a real amount is an expense, not a meal', () => {
  const P = (t) => parseMeal(t, { today: TODAY });
  assert.equal(P('lunch 250'), null); assert.equal(P('dinner 1200 hotel'), null); assert.equal(P('lunch ₹90 samosa'), null);
  assert.equal(P('Spent 450 on vegetables'), null); assert.equal(P('petrol 2000'), null);
  assert.equal(P('lunch 2 roti dal').dish, '2 roti dal');                 // small numbers are food
});

test('chat box: meals are logged, expenses still work', () => {
  const s = fresh();
  assert.match(handleMessage(s, 'dinner outside pizza', 'Asha', TODAY).text, /Logged dinner \(outside\): Pizza/);
  assert.equal(s.meals.length, 1); assert.equal(s.entries.length, 0);
  assert.match(handleMessage(s, 'lunch 250', 'Asha', TODAY).text, /Recorded ₹250/);
  assert.equal(s.meals.length, 1); assert.equal(s.entries.length, 1);
  assert.equal(handleMessage(s, 'dinner', 'Asha', TODAY).ok, false);
});

test('classify: lighter and heavier dishes, mixed, unknown', () => {
  assert.equal(classify('Dal rice'), 'healthy'); assert.equal(classify('Pizza'), 'less'); assert.equal(classify('Poha'), 'healthy');
  assert.equal(classify('Pav bhaji'), 'less'); assert.equal(classify('Burger and salad'), 'mixed'); assert.equal(classify('Kuch bhi'), 'unknown');
  assert.equal(classify('Samosa'), 'less'); assert.equal(classify('Pizzeria'), 'unknown');           // whole words only
  assert.deepEqual(splitDish('dal, rice and sabzi'), ['dal', 'rice', 'sabzi']);
});

test('alert: too many meals outside or ordered in', () => {
  const s = fresh();
  log(s, '2026-11-08', 'Dinner', 'Outside', 'Biryani'); log(s, '2026-11-09', 'Lunch', 'Ordered', 'Burger'); log(s, '2026-11-09', 'Dinner', 'Home', 'Dal roti');
  assert.equal(foodAlerts(s, TODAY).filter((a) => a.type === 'outside').length, 0);               // 2 of 3 is fine
  log(s, '2026-11-10', 'Lunch', 'Outside', 'Thali'); log(s, '2026-11-10', 'Dinner', 'Ordered', 'Noodles');
  const a = foodAlerts(s, TODAY).find((x) => x.type === 'outside');
  assert.ok(a); assert.equal(a.count, 4); assert.equal(a.total, 5);
  assert.ok(a.ideas.length > 0); assert.match(alertText(a), /Quick meals to make at home/);
});

test('alert: outside meals older than a week are not counted', () => {
  const s = fresh();
  for (let i = 0; i < 6; i++) log(s, '2026-10-20', MEALS[i % 4], 'Outside', 'Thali');
  assert.equal(foodAlerts(s, TODAY).length, 0);
});

test('alert: several heavier meals in a row, and a healthy meal breaks the streak', () => {
  const s = fresh();
  log(s, '2026-11-09', 'Dinner', 'Home', 'Dal roti');
  log(s, '2026-11-10', 'Breakfast', 'Home', 'Maggi'); log(s, '2026-11-10', 'Lunch', 'Outside', 'Pizza');
  assert.equal(foodAlerts(s, TODAY).filter((a) => a.type === 'unhealthy').length, 0);              // only 2 in a row
  log(s, '2026-11-10', 'Snacks', 'Home', 'Samosa and chips');
  const a = foodAlerts(s, TODAY).find((x) => x.type === 'unhealthy');
  assert.ok(a); assert.equal(a.count, 3); assert.match(a.ideasLabel, /Lighter ideas for dinner/);
  log(s, '2026-11-10', 'Dinner', 'Home', 'Khichdi');
  assert.equal(foodAlerts(s, TODAY).filter((x) => x.type === 'unhealthy').length, 0);
});

test('alert: the same dish again and again, but daily staples are ignored', () => {
  const s = fresh();
  for (const d of ['2026-11-07', '2026-11-08', '2026-11-09']) { log(s, d, 'Breakfast', 'Home', 'Aloo paratha'); log(s, d, 'Lunch', 'Home', 'Dal, rice, roti'); }
  const alerts = foodAlerts(s, TODAY);
  const rep = alerts.filter((a) => a.type === 'repeat');
  assert.equal(rep.length, 1); assert.equal(rep[0].item, 'aloo paratha'); assert.equal(rep[0].count, 3);
  assert.match(rep[0].ideasLabel, /breakfast/);
  assert.equal(rep[0].ideas.some((n) => /paratha/i.test(n)), false);                              // not the same thing again
});

test('suggestions: right meal, diet, not eaten this week, prefer what is in stock', () => {
  const s = fresh();
  const base = { meal: 'Dinner', today: TODAY };
  assert.equal(suggest(s, { ...base, count: 50 }).every((d) => d.meals.includes('Dinner')), true);
  const veg = suggest(s, { ...base, diet: 'veg', count: 50 }); assert.equal(veg.every((d) => d.diet === 'veg'), true);
  const egg = suggest(s, { ...base, diet: 'egg', count: 50 }); assert.equal(egg.some((d) => d.diet === 'egg'), true); assert.equal(egg.some((d) => d.diet === 'nonveg'), false);
  log(s, '2026-11-09', 'Dinner', 'Home', 'Rajma chawal');
  assert.equal(suggest(s, { ...base, count: 50 }).some((d) => d.name === 'Rajma chawal'), false);   // had it yesterday
  const stock = suggest(s, { ...base, stockKeys: ['paneer', 'atta', 'onion'], count: 3 });
  assert.ok(stock.some((d) => /paneer/i.test(d.name)));
  assert.equal(suggest(s, { ...base, quick: true, count: 50 }).every((d) => d.quick), true);
  assert.deepEqual(suggest(s, base).map((d) => d.name), suggest(s, base).map((d) => d.name));       // steady for the same day
});

test('dish list is sane', () => {
  assert.ok(DISHES.length >= 40); assert.equal(new Set(DISHES.map((d) => d.name)).size, DISHES.length);
  for (const m of MEALS) assert.ok(DISHES.filter((d) => d.meals.includes(m)).length >= 5, m);
  assert.equal(mealForHour(8), 'Breakfast'); assert.equal(mealForHour(13), 'Lunch'); assert.equal(mealForHour(16), 'Snacks'); assert.equal(mealForHour(21), 'Dinner');
});

test('own food words change the tags; meals can be deleted', () => {
  const s = fresh();
  assert.equal(classify('Kuch bhi'), 'unknown');
  s.foodWords = { healthy: [], less: ['kuch bhi'] };
  log(s, '2026-11-10', 'Lunch', 'Home', 'Kuch bhi'); log(s, '2026-11-10', 'Snacks', 'Home', 'Kuch bhi'); log(s, '2026-11-10', 'Dinner', 'Home', 'Kuch bhi');
  assert.ok(foodAlerts(s, TODAY).some((a) => a.type === 'unhealthy'));
  deleteMeal(s, s.meals[0].id); assert.equal(s.meals.length, 2);
  assert.throws(() => addMeal(s, { date: TODAY, meal: 'Brunch', dish: 'x' }), /breakfast, lunch/);
  assert.throws(() => addMeal(s, { date: TODAY, meal: 'Lunch', dish: ' ' }), /what you had/);
});

// Phone-sized browser test: runs the real app in Chromium against a local static server.
// Usage: node test/ui.test.cjs [screenshotDir]
const { chromium } = require('playwright');
const http = require('node:http'), fs = require('node:fs'), path = require('node:path');
const assert = require('node:assert/strict');

const ROOT = path.resolve(__dirname, '..');
const SHOTS = process.argv[2];
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.png': 'image/png' };
const overrides = {};   // lets a test pretend the server was updated
const server = http.createServer((req, res) => {
  const op = new URL(req.url, 'http://x').pathname;
  if (overrides[op]) { res.writeHead(200, { 'content-type': 'text/javascript' }).end(overrides[op]); return; }
  let p = path.join(ROOT, decodeURIComponent(new URL(req.url, 'http://x').pathname));
  if (fs.existsSync(p) && fs.statSync(p).isDirectory()) p = path.join(p, 'index.html');
  if (!p.startsWith(ROOT) || !fs.existsSync(p)) { res.writeHead(404).end(); return; }
  res.writeHead(200, { 'content-type': TYPES[path.extname(p)] || 'application/octet-stream' }).end(fs.readFileSync(p));
});

(async () => {
  await new Promise((r) => server.listen(0, r));
  const base = `http://localhost:${server.address().port}/`;
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 390, height: 780 }, deviceScaleFactor: 1, acceptDownloads: true, serviceWorkers: 'allow' });
  await context.addInitScript(() => {   // stand-in for the downloaded text reader: tests the wiring, not the OCR itself
    window.Tesseract = { createWorker: async () => ({ recognize: async () => ({ data: { text: 'BIG MART\nDate 01/03/2026\nSugar 1kg 48\nBanana 1 dozen 60\nTotal 108' } }), terminate: async () => {} }) };
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
  page.on('dialog', (d) => d.accept());
  const shot = async (n) => { if (SHOTS) await page.screenshot({ path: path.join(SHOTS, n + '.png') }); };
  const text = () => page.locator('#view').innerText();
  const send = async (t) => { await page.fill('form[data-form=message] input[name=text]', t); await page.click('form[data-form=message] button'); };
  const tab = async (name) => { await page.click(`nav a[data-tab=${name}]`); await page.waitForFunction((n) => location.hash === '#' + n, name); await page.waitForTimeout(50); };
  const step = (n) => console.log('ok -', n);

  await page.goto(base + 'index.html');
  assert.match(await text(), /Welcome/);
  await page.fill('form[data-form=set-me] input[name=me]', 'Prabhakar Rai'); await page.click('form[data-form=set-me] button');
  assert.doesNotMatch(await text(), /Welcome/); step('first run asks for your name');

  await send('Spent 450 on vegetables');
  assert.match(await text(), /Recorded ₹450.00 under Grocery/);
  assert.match(await text(), /Share to group chat/);
  await send('Income 85000 salary'); await send('petrol 2000 yesterday');
  await send('undo'); assert.match(await text(), /Removed ₹2,000.00 under Vehicle/);
  await send('edit 500'); assert.match(await text(), /Updated your last entry/);
  await send('total'); assert.match(await text(), /Total expenses so far: ₹450.00/) ;
  step('chat box: add, income, undo, edit, total');
  await shot('home');

  // custom category
  await tab('more'); await page.click('a[href="#categories"]');
  await page.fill('form[data-form=add-category] input[name=name]', 'Pets');
  await page.fill('form[data-form=add-category] textarea', 'dog food, vet');
  await page.click('form[data-form=add-category] button');
  assert.equal(await page.locator('form[data-form=category] input[value="Pets"]').count(), 1);
  await shot('categories');
  await tab('home'); await send('vet 1200');
  assert.match(await text(), /under Pets/); step('custom category added and used');

  // family + import
  await tab('more'); await page.click('a[href="#family"]');
  await page.fill('form[data-form=member] input[name=name]', 'Asha'); await page.click('form[data-form=member] button');
  await page.fill('form[data-form=member] input[name=name]', 'Rahul'); await page.click('form[data-form=member] button');
  await page.goto(base + 'index.html#import');
  await page.setInputFiles('#chatfile', path.join(ROOT, '..', 'samples', 'family_chat_hinglish.txt'));
  await page.waitForSelector('form[data-form=confirm-import]');
  const review = await text();
  assert.match(review, /From: family_chat_hinglish\.txt/); assert.match(await page.locator('input#chatfile').getAttribute('accept'), /\.txt,\.zip/);
  assert.match(review, /Dhaniya and mirchi/); assert.match(review, /1 undone|undone/); assert.match(review, /edited/);
  await shot('import-review');
  await page.click('form[data-form=confirm-import] button');
  await page.waitForSelector('.total');
  assert.match(await text(), /Movie|₹9,000/); step('import hinglish chat with undo/edit replay');
  // importing the same file again offers nothing
  await page.goto(base + 'index.html#import');
  await page.setInputFiles('#chatfile', path.join(ROOT, '..', 'samples', 'family_chat_hinglish.txt'));
  await page.waitForSelector('text=Nothing new to import'); step('re-import adds nothing');

  // paste messages copied from WhatsApp (Android copies time first)
  await page.goto(base + 'index.html#import');
  await page.fill('form[data-form=paste-import] textarea', 'hello there');
  await page.click('form[data-form=paste-import] button');
  assert.match(await page.locator('#toast').innerText(), /couldn't find WhatsApp messages/);
  await page.fill('form[data-form=paste-import] textarea', '[10:12 am, 11/11/2026] Asha: Spent 333 on bread\n[10:13 am, 11/11/2026] Rahul: tea 20');
  await page.click('form[data-form=paste-import] button');
  await page.waitForSelector('form[data-form=confirm-import]');
  assert.match(await text(), /From: pasted messages/); assert.match(await text(), /₹333\.00/);
  step('paste messages copied from WhatsApp');

  // recurring
  await page.goto(base + 'index.html#recurring');
  const day = String(new Date().getDate() + 1 > 28 ? 28 : new Date().getDate() + 1);
  await page.fill('form[data-form=recurring] input[name=name]', 'Rent');
  await page.fill('form[data-form=recurring] input[name=amount]', '25000');
  await page.fill('form[data-form=recurring] input[name=dueDay]', day);
  await page.click('form[data-form=recurring] button');
  assert.match(await text(), /Rent/); await shot('recurring');
  await tab('home'); assert.match(await text(), /Due soon/);
  await page.click('button[data-act=paid]');
  assert.match(await text(), /Recorded Rent/); assert.doesNotMatch(await page.locator('#view .card h2').allInnerTexts().then((a) => a.join('|')), /Due soon/);
  step('recurring: due soon card, mark paid moves it on');

  // entries: search, edit, delete
  await tab('entries'); await page.fill('#search', 'rent'); assert.match(await page.locator('#entryList').innerText(), /Rent/);
  await page.click('#entryList .item'); await page.waitForSelector('form[data-form=edit-entry]');
  await page.fill('form[data-form=edit-entry] input[name=amount]', '26000'); await page.click('form[data-form=edit-entry] > .row > button:first-child');
  await page.waitForSelector('#search');
  assert.match(await text(), /Rent .*25000.*26000|₹25,000.00/);
  await page.fill('#search', 'rent'); await page.click('#entryList .item'); await page.waitForSelector('form[data-form=edit-entry]');
  await page.click('button[data-act=delete-entry]'); await page.waitForSelector('#search');
  await page.fill('#search', 'rent'); assert.match(await page.locator('#entryList').innerText(), /Nothing found/);
  step('entries: search, edit, delete'); await shot('entries');

  // reports + downloads
  await tab('reports'); assert.match(await text(), /By category/); await shot('reports');
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('button[data-act=export-report-xlsx]')]);
  const file = path.join(require('os').tmpdir(), 'hh-' + Date.now() + '.xlsx'); await dl.saveAs(file);
  assert.equal(fs.readFileSync(file).slice(0, 2).toString(), 'PK'); step('reports + Excel download');

  // persistence across reload + offline
  await page.goto(base + 'index.html#home'); await page.reload(); assert.match(await text(), /Total expenses/); const totalBefore = await page.locator('.total').innerText();
  await page.waitForFunction(() => navigator.serviceWorker.controller || true);
  await page.evaluate(() => navigator.serviceWorker.ready); await page.reload();
  await context.setOffline(true); await page.reload();
  assert.equal(await page.locator('.total').innerText(), totalBefore); await context.setOffline(false);
  step('data survives reload; app opens offline');

  // an update on the server shows up on the very next open (not after several), and offline still works afterwards
  overrides['/app.js'] = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8') + '\nwindow.__updated = true;';
  await page.reload(); await page.waitForSelector('.total');
  assert.equal(await page.evaluate(() => window.__updated === true), true);
  delete overrides['/app.js']; await context.setOffline(true); await page.reload(); await page.waitForSelector('.total');
  assert.equal(await page.evaluate(() => window.__updated === true), true);   // still the newest saved copy
  await context.setOffline(false);
  step('an update shows on the next open; offline falls back to the newest saved copy');

  // backup + restore
  await page.goto(base + 'index.html#backup');
  const [bk] = await Promise.all([page.waitForEvent('download'), page.click('button[data-act=backup]')]);
  const bkFile = path.join(require('os').tmpdir(), 'hh-backup-' + Date.now() + '.json'); await bk.saveAs(bkFile);
  await page.click('button[data-act=wipe]'); await page.waitForSelector('.total');
  assert.match(await page.locator('.total').innerText(), /₹0.00/);
  await page.goto(base + 'index.html#backup'); await page.setInputFiles('#restorefile', bkFile);
  await page.waitForSelector('.total');
  assert.equal(await page.locator('.total').innerText(), totalBefore); step('backup, wipe, restore');

  // share target: simulate what the service worker does with a shared chat
  const sharedOk = await page.evaluate(async () => {
    const c = await caches.open('household-shared');
    await c.put('shared-chat', new Response('10/11/26, 9:00 am - Asha: Spent 77 on milk', { headers: { 'x-filename': 'chat.txt' } })); return true; });
  await page.goto(base + 'index.html?shared=1'); await page.waitForSelector('form[data-form=confirm-import]');
  assert.match(await text(), /77|Milk/); step('chat shared to the app opens the import review');

  // ---------------------------------------------------------------- kitchen: grocery
  const dayOffset = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
  await page.goto(base + 'index.html#kitchen');
  assert.match(await text(), /Add a grocery bill/);
  const saveBill = async (billText, date) => {
    await page.fill('#billtext', billText); await page.click('form[data-form=read-bill] button:not([type=button])');
    await page.waitForSelector('form[data-form=save-bill]');
    await page.fill('form[data-form=save-bill] input[name=date]', date);
    await page.click('form[data-form=save-bill] > .row:last-of-type button:first-child');
    await page.waitForSelector('form[data-form=read-bill]'); await page.waitForTimeout(80);
  };
  await page.fill('#billtext', 'BIG MART\nInvoice 55   Date 05/11/2026\n1. Aashirvaad Atta 5kg 250.00\n2. Amul Milk 500ml 2 28.00 56.00\nSub Total 306\nGST 0');
  await page.click('form[data-form=read-bill] button:not([type=button])'); await page.waitForSelector('form[data-form=save-bill]');
  assert.equal(await page.inputValue('form[data-form=save-bill] input[name=name0]'), 'Aashirvaad Atta');
  assert.equal(await page.inputValue('form[data-form=save-bill] select[name=unit0]'), 'kg');
  assert.equal(await page.inputValue('form[data-form=save-bill] input[name=date]'), '2026-11-05');
  await page.click('button[data-act=bill-add-line]');                                      // edits survive adding a line
  assert.equal(await page.inputValue('form[data-form=save-bill] input[name=name0]'), 'Aashirvaad Atta');
  await page.click('button[data-act=bill-del-line][data-i="2"]');
  await page.fill('form[data-form=save-bill] input[name=date]', dayOffset(-60));
  await page.click('form[data-form=save-bill] > .row:last-of-type button:first-child');
  await page.waitForSelector('form[data-form=read-bill]'); await page.waitForTimeout(80);
  assert.match(await text(), /Your items/); assert.match(await text(), /Atta/);
  await saveBill('Atta 5kg 250\nMilk 500ml 28', dayOffset(-35));
  await saveBill('Atta 5kg 250\nMilk 500ml 28', dayOffset(-10));
  const kitchen = await text();
  assert.match(kitchen, /Next 30 days: what to buy/); assert.match(kitchen, /Atta/);
  await page.click('details:has-text("Atta") summary'); assert.match(await text(), /Lasted 25 days/);
  await page.fill('input[data-act=people]', '2'); await page.dispatchEvent('input[data-act=people]', 'change');
  assert.match(await page.locator('input[data-act=people]').inputValue(), /2/);
  step('grocery: paste bill, check lines, save, learn from repeat purchases, monthly list');

  // photo scan wiring (the reader is a stand-in here; real scanning needs the library and a real bill photo)
  const png = Buffer.from(await page.evaluate(() => { const c = document.createElement('canvas'); c.width = 300; c.height = 200; const x = c.getContext('2d');
    x.fillStyle = '#fff'; x.fillRect(0, 0, 300, 200); x.fillStyle = '#000'; x.font = '20px sans-serif'; x.fillText('Sugar 1kg 48', 20, 100); return c.toDataURL('image/png').split(',')[1]; }), 'base64');
  await page.setInputFiles('#billphoto', { name: 'bill.png', mimeType: 'image/png', buffer: png });
  await page.waitForSelector('form[data-form=save-bill]');
  assert.equal(await page.inputValue('form[data-form=save-bill] input[name=name0]'), 'Sugar');
  assert.equal(await page.inputValue('form[data-form=save-bill] input[name=date]'), '2026-03-01');
  assert.equal(await page.inputValue('form[data-form=save-bill] input[name=name1]'), 'Banana');
  await page.click('button[data-act=bill-cancel]');
  const prep = await page.evaluate(async (b64) => {
    const { prepareImage } = await import('./ocr.js');
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const out = await prepareImage(new File([bytes], 'bill.png', { type: 'image/png' }), 150);   // shrink to 150px
    const bmp = await createImageBitmap(out); return { type: out.type, w: bmp.width, h: bmp.height };
  }, png.toString('base64'));
  assert.deepEqual(prep, { type: 'image/png', w: 150, h: 100 });       // photo is scaled down, same shape
  step('photo scan: text lands in the box and the review screen opens');

  // ---------------------------------------------------------------- kitchen: meals
  await tab('home'); await send('dinner outside pizza');
  assert.match(await text(), /Logged dinner \(outside\): Pizza/);
  await page.goto(base + 'index.html#kitchen/meals');
  const meal = async (m, place, dish, date) => { await page.selectOption('form[data-form=meal] select[name=meal]', m); await page.selectOption('form[data-form=meal] select[name=place]', place);
    await page.fill('form[data-form=meal] input[name=dish]', dish); await page.fill('form[data-form=meal] input[name=date]', date); await page.click('form[data-form=meal] button'); await page.waitForTimeout(80); };
  await meal('Lunch', 'Ordered', 'Burger', dayOffset(0)); await meal('Snacks', 'Outside', 'Samosa and chips', dayOffset(0)); await meal('Lunch', 'Outside', 'Pizza', dayOffset(-1));
  const meals = await text();
  assert.match(meals, /outside or ordered in/);                          // 4 of the last meals not at home
  assert.match(meals, /heavier or fried side/);                          // 3+ heavy meals in a row
  assert.match(meals, /Pizza/); assert.match(meals, /Ideas for/);
  await shot('meals');
  await page.fill('form[data-form=food-settings] input[name=outsideMax]', '10'); await page.selectOption('form[data-form=food-settings] select[name=diet]', 'veg');
  await page.click('form[data-form=food-settings] button'); await page.waitForTimeout(80);
  assert.doesNotMatch(await text(), /outside or ordered in/);
  await tab('home'); assert.match(await text(), /Kitchen/);
  step('meals: log, alerts for outside food and a heavy streak, settings, Home card');

  assert.deepEqual(errors, [], 'browser errors: ' + errors.join('\n'));
  await browser.close(); server.close(); console.log('UI TESTS PASSED');
})().catch(async (e) => { console.error('UI TEST FAILED:', e.message); process.exit(1); });

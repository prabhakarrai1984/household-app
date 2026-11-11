# Household App - phone version

Works in the phone's browser, can be installed to the home screen like a normal app, and works offline.
**Your data is stored only on your phone.** There is no server and no account. The WhatsApp group chat is the
shared record: everyone posts expenses in the group; whoever wants the full picture imports the exported chat.

## Put it on your phone (free, about 10 minutes)

The app is just files, so GitHub can host it for free with **GitHub Pages**. Only the app's code goes online.
Your expenses never do (they live on each phone, and `data/` is not in Git).

1. Commit and push these files, then merge into `main` as usual.
2. On GitHub open your repository → **Settings** → **Pages**.
3. Under *Build and deployment* choose **Deploy from a branch**, branch **main**, folder **/ (root)**, then **Save**.
   (Free GitHub Pages needs a *public* repository.)
4. After a minute the page shows your address, which looks like
   `https://YOUR-NAME.github.io/YOUR-REPO/`. Your app is at that address **plus `pwa/`**:
   `https://YOUR-NAME.github.io/YOUR-REPO/pwa/`
5. Open that address in **Chrome on your Android phone** → menu (⋮) → **Install app** (or *Add to Home screen*).
   On an iPhone use Safari → Share → **Add to Home Screen**.

Send the same address to family members who want the app too.

## First use

1. **Home** asks for your name. Type it exactly as it shows in your WhatsApp group (for example `Prabhakar Rai`).
2. **More → Family**: add the people whose messages count. (Skip it and everyone in an imported chat counts.)
3. **More → Import WhatsApp chat**. Three ways, easiest first:
   - **Share straight from WhatsApp** (no file hunting): group → ⋮ → More → Export chat → *Without media* → pick **Household**.
     Needs the app installed from Chrome.
   - **Saved to Drive:** open Drive, ⋮ on the file → *Send a copy* → **Household**.
   - **Saved to the phone:** use the file button. The file is called *WhatsApp Chat with …*; look under *Recent* or *Downloads*
     (Samsung: My Files → Downloads), or pick *Drive* in the picker's menu. The picker only lists `.txt` and `.zip` files.
   - **Paste messages:** in the chat press and hold a message, select more, tap copy, paste into the box on the Import screen.
   The review screen shows which file or text it came from. Untick anything that isn't an expense, then save.
4. Post new expenses in the group as usual. When you add one in the app, tap **Share to group chat** so the
   group stays the shared record. If you import later, entries that match one you typed yourself are
   flagged *may be a duplicate* and left unticked.

## What it does

Everything from the prototype: add by message, auto-categories, income and monthly balance, reports by period /
category / person, undo and edit, recurring expenses with a Due soon list, chat import that replays `undo` and
`edit` messages, Excel download.

New: **add your own categories** and edit the keywords of any category (More → Categories). Keywords can be in
any language, for example Hindi words.

## Kitchen: grocery and meals

**Grocery** (Kitchen → Grocery)
- **Add a bill:** paste the bill text (BigBasket, Blinkit, DMart emails or messages), type one item per line
  (`Atta 5kg 250`), or tap **Scan photo**. You always get a check screen to fix names, quantities and prices
  before anything is saved. Totals, tax and headings are skipped.
- **How fast things are used:** when you buy an item again, the app works out how many days the last pack lasted
  and compares it with your earlier gaps. It says "used faster than usual" or "lasted longer", and for staples like
  oil, sugar, milk, atta, rice, dal and salt it also compares with a rough per-person range (set *People at home*).
  Tap **It ran out today** on an item to make the count exact.
- **Next 30 days:** a suggested list with quantities in your usual pack sizes and an estimated cost. Share it to WhatsApp.
- Needs an item bought at least twice. Stock-ups and top-ups before something runs out can look like "faster than usual";
  the app says so in the message.

**Meals** (Kitchen → Meals, or type in the Home box: `lunch dal rice at home`, `dinner outside pizza`)
- Log breakfast, lunch, snacks and dinner as at home, outside or ordered in.
- Gentle alerts: too many meals outside or ordered in during the last 7 days, several heavier or fried meals in a row,
  and the same dish again and again (roti, rice, dal and similar daily staples are ignored).
- Each alert comes with ideas for something different from a built-in list of everyday Indian dishes. Ideas skip
  anything you had this week and favour dishes that use groceries you probably still have. Choose vegetarian,
  vegetarian + eggs, or anything. Thresholds and your own lighter/heavier food words are editable.
- These are simple word-based rules for everyday awareness, **not medical or dietary advice**.

**Photo scanning, honestly:** the bill-photo reader (Tesseract.js) is downloaded once from a public library host the first
time you scan, then kept for offline use. The photo itself never leaves your phone. Reading crumpled receipts is
imperfect, so always check the lines. I could not test the real reader on a bill photo here (no internet in my workspace),
so please try it and tell me how it does. Typing or pasting always works.

## Things to know

- **Back up.** Data lives only in this browser on this phone. Clearing browser data, uninstalling or changing
  phones loses it. Use **More → Backup** now and then and keep the file somewhere safe (email it to yourself).
- **Reminders** appear on Home and Recurring when you open the app. A web app can't wake the phone when closed;
  real alarm notifications need the native Android app (planned next).
- **Updates** arrive the next time you open the app (it refreshes quietly in the background).
- **Excel** is made when you tap Download. It is a real `.xlsx` file, not a live file on the phone.

## For developers

No build step and no dependencies: plain JavaScript modules.

```bash
cd pwa
node --test test/core.test.js test/grocery.test.js test/food.test.js   # the rules (needs Node 20+)
python -m http.server 8000        # then open http://localhost:8000/pwa/ from the repo root
```

`core/` has the rules (no screens), `app.js` the screens, `sw.js` the offline support.
`test/ui.test.cjs` drives the real app in a phone-sized Chromium (needs Playwright).

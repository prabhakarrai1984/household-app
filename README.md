# Household App

A family expense tracker. Family members send short messages like
`Spent 450 on vegetables`, and the app records the amount, picks a category,
keeps a running total, and stores everything in a database plus an Excel file.

**Status:** expenses, income, reports, undo/edit, chat import and recurring expenses.
This Flask version is the working prototype and rulebook. The phone version (data stays on the phone) is in `pwa/` - see `pwa/README.md`.
Messages can be typed into the web page, or imported from an exported WhatsApp chat.

## Run it

```bash
python -m venv venv
source venv/Scripts/activate     # Git Bash / MSYS2 on Windows (or: source venv/bin/activate)
# venv\Scripts\activate          # Windows Command Prompt / PowerShell
pip install -r requirements.txt
python app.py
```

Open http://127.0.0.1:5000.

## Run the tests

```bash
python -m unittest -v
```

## The pages

| Page | What it does |
|---|---|
| **Home** | Total expenses (all time), this month's income, expenses and balance, a box to type a message, recent entries. |
| **Entries** | Search every entry, fix a wrong amount, category, date or description, or delete a mistake. Shows a log of recent changes. |
| **Reports** | Filter by period, category, person and type. Shows totals, category shares, who spent what, income sources, and downloads the result as Excel. |
| **Import chat** | Upload an exported WhatsApp chat, review what was found, tick what to keep. |
| **Recurring** | Rent, EMIs, insurance. Add once; they show under **Due soon** on Home from a few days before the due date. **Mark paid** records the expense and moves the date on. |
| **Family** | Who counts. Add each family member once. Anyone not on the list is ignored. |

### Income and the monthly view

Start a message with `Income` (or `Salary`) to record money coming in:
`Income 85000 salary`, `Income 5000 rent received`, `salary 85000`.
Income is never mixed into expense totals. The text after the amount becomes the *source*, which the
Reports page uses for the income breakdown. (`Income tax 5000` and `Maid salary 8000` are still expenses.)

Home shows **income, expenses and balance for the current month**; the balance turns red when you spend
more than you earned.

### Reports

- **Period:** this month, last month, this week (Monday to Sunday), today, this year, all time, or custom dates.
- **Filters:** category, person, and whether to show expenses, income or both.
- **Shows:** income, expenses, balance, each category's total and share of spending, spending per person,
  income sources, and the matching entries.
- **Download this report as Excel:** a *Summary* sheet and an *Entries* sheet, for exactly what you filtered.
  (`data/expenses.xlsx` is separate and always holds everything.)

You can also ask from the chat box: `month`, `report`, `report grocery`, `report grocery october`,
`report last month`, `report travel this year`, `report all`.

### Family list

Add each person with:
- **Name**: how the app shows them.
- **Name in WhatsApp chat**: only if the chat shows a different name (for example "Mom").
- **Phone**: only for people the chat shows as a number (for example `+91 98765 43210`).

Until you add the first person, the web page accepts anyone. After that, only active
family members can post, and anyone else gets a polite refusal. You can pause or remove a member
at any time. Their past expenses stay.

### Importing a WhatsApp chat

1. In WhatsApp: **Export chat → Without media** (Android: menu → More → Export chat;
   iPhone: tap the group name → Export Chat). iPhone gives a `.zip`, Android a `.txt`. Both work.
2. Open **Import chat** and choose the file.
3. The app lists messages that look like expenses. It never saves anything on its own.
   Untick what isn't an expense, fix any category, then **Save ticked expenses**.

What it does for you:
- Reads only messages from people on the Family list and reports who was ignored.
- Skips times and dates (`dinner at 8`, `7 pm`, `PTM on 15/11`), photos, deleted messages and chatter.
- Handles multi-line messages, Android and iPhone formats, and day-first or month-first dates.
- **Never saves the same message twice**, even from overlapping exports (last week's file plus
  this month's). Each message gets a fingerprint from sender, minute and text.

Try it with the files in `samples/` (add Asha, Rahul, Neha, and Meera with phone `98765 43210`
on the Family page first).

> Note: if the same expense was both typed into the web page *and* appears in an imported chat,
> it is counted twice, because the app cannot tell they are the same. Pick one way per expense.

### Undo and edit inside an imported chat

The importer replays the chat in order. If Asha posted `Spent 700 on medicine`, then `edit 750`,
you get one entry of 750. If she posted something and then `undo`, it is simply not offered.
(An `undo` aimed at something imported earlier is ignored rather than guessed at.)

## Recurring expenses

| Message | What happens |
|---|---|
| `recurring rent 25000 monthly on 1` | Adds it. Also `quarterly`, `yearly` (`recurring LIC 24000 yearly on 5 march`). |
| `recurring electricity 1800 monthly on the 15th remind 3` | Reminder starts 3 days before (default 2). |
| `due` | Lists what is due soon or overdue. |
| `paid rent` | Records the expense, moves the due date on, and gives you a line to post to the group. |
| `recurring` / `recurring remove rent` | List or stop them. |

A day that does not exist in a month moves to the month's last day (the 31st becomes 28 Feb, then 31 Mar again).
The Recurring page also shows a ready-made reminder line to paste into the family group.

## Fixing mistakes

**In the chat box**, `undo` and `edit` act on *your own most recent entry*:

| Message | What happens |
|---|---|
| `undo` | Removes your last entry and tells you exactly what it removed. Repeat to go back further. |
| `edit 500` | Changes the amount of your last entry. |
| `edit grocery` | Changes its category. |
| `edit 500 grocery` | Changes both. |
| `edit yesterday` | Changes its date (`edit today` works too). |

Entries that came from an imported WhatsApp chat are never touched by `undo` or `edit`.

**On the Entries page** you can find any entry (search by description, category or person), change its
date, amount, category and description, or delete it. Every edit and deletion is written to a
**Recent changes** log on that page. Changes made on the web are logged as "Web page", because there are
no logins yet. If you delete an entry that came from an imported chat, the import remembers and won't
offer it again.

## What you can type

| Message | Result |
|---|---|
| `Spent 450 on vegetables` | ₹450, Grocery |
| `Medicine 320 yesterday` | ₹320, Medicine, yesterday's date |
| `Gift 1500 birthday` | ₹1,500, Gift (a category name always wins) |
| `petrol 2,000` / `₹2k fuel` | ₹2,000, Vehicle |
| `total` | Shows total expenses so far |
| `undo` / `edit 500` | Remove or correct your last entry (see above) |
| `help` | Shows examples |

Categories: Investment, Grocery, Medicine, School Fees, Study, Entertainment,
Clothes, Travel, Vehicle, Gift. Anything else is saved as *Uncategorized*.

## Where things live

| File | Job |
|---|---|
| `message_parser.py` | Reads a message: amount, date, category. Edit the `KEYWORDS` list to teach it your family's words. |
| `recurring.py` | Recurring expenses: due-date rules, Due soon, paid, share text. |
| `chat_import.py` | Reads WhatsApp exports and prepares entries for review. |
| `db.py` | SQLite storage: expenses, family members, pending imports. Upgrades older databases automatically. |
| `export.py` | Rebuilds `data/expenses.xlsx` from the database, and builds the downloadable filtered report. |
| `reports.py` | Date ranges, filters, summaries and the `report ...` chat command. |
| `service.py` | `handle_message()`: ties it together. WhatsApp or Telegram will call this too. |
| `app.py` + `templates/` | The Flask web pages and the `/api/message` endpoint. |
| `samples/` | Example exports (Android and iPhone style) for trying the import. |
| `tests/` | Automated tests, including one per user story. |

Your data is in the `data/` folder (not committed to Git, since it is private).

## User stories covered

US-1 record by message, US-2 "yesterday", US-3 error reply, US-5 who posted,
US-6 auto-category, US-7 explicit category, US-16 total at all times, US-23 Excel storage,
US-26 only listed family members can post (family list), plus WhatsApp chat import.

Phase 2: US-14 record income, US-15 monthly income, US-17 income vs expenses for the month,
US-18 filter by category, US-19 filter by duration, US-20 filter by person, US-21 category summary
with percentages, US-22 reports by chat command, US-24 export filtered data to Excel.

Also: US-4 undo and edit your last entry, plus editing and deleting any entry on the web.

## Roadmap

1. **Now:** phone web app in `pwa/` (install from the browser, data on the phone, your own categories)
2. **Next:** native Android app (real alarm reminders, Google Play)

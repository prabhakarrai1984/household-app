# Household App

A family expense tracker. Family members send short messages like
`Spent 450 on vegetables`, and the app records the amount, picks a category,
keeps a running total, and stores everything in a database plus an Excel file.

**Status:** MVP plus family list and WhatsApp chat import.
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

## The three pages

| Page | What it does |
|---|---|
| **Home** | Total expenses, totals by category, recent entries, Excel download, and a box to type a message. |
| **Family** | Who counts. Add each family member once. Anyone not on the list is ignored. |
| **Import chat** | Upload an exported WhatsApp chat, review what was found, tick what to keep. |

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

## What you can type

| Message | Result |
|---|---|
| `Spent 450 on vegetables` | ₹450, Grocery |
| `Medicine 320 yesterday` | ₹320, Medicine, yesterday's date |
| `Gift 1500 birthday` | ₹1,500, Gift (a category name always wins) |
| `petrol 2,000` / `₹2k fuel` | ₹2,000, Vehicle |
| `total` | Shows total expenses so far |
| `help` | Shows examples |

Categories: Investment, Grocery, Medicine, School Fees, Study, Entertainment,
Clothes, Travel, Vehicle, Gift. Anything else is saved as *Uncategorized*.

## Where things live

| File | Job |
|---|---|
| `message_parser.py` | Reads a message: amount, date, category. Edit the `KEYWORDS` list to teach it your family's words. |
| `chat_import.py` | Reads WhatsApp exports and prepares entries for review. |
| `db.py` | SQLite storage: expenses, family members, pending imports. Upgrades older databases automatically. |
| `export.py` | Rebuilds `data/expenses.xlsx` from the database. |
| `service.py` | `handle_message()`: ties it together. WhatsApp or Telegram will call this too. |
| `app.py` + `templates/` | The Flask web pages and the `/api/message` endpoint. |
| `samples/` | Example exports (Android and iPhone style) for trying the import. |
| `tests/` | Automated tests, including one per user story. |

Your data is in the `data/` folder (not committed to Git, since it is private).

## User stories covered

US-1 record by message, US-2 "yesterday", US-3 error reply, US-5 who posted,
US-6 auto-category, US-7 explicit category, US-16 total at all times, US-23 Excel storage,
US-26 only listed family members can post (family list), plus WhatsApp chat import.

## Roadmap

1. **Phase 2:** income, monthly view, filters and reports, Excel export of filtered data
2. **Phase 3:** recurring expenses and reminders
3. **Phase 4:** live Telegram or WhatsApp connection, backups, login

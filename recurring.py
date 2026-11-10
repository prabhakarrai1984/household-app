"""Recurring expenses: rent, EMI, insurance, school fees...

Rules (pure functions, easy to test and to port):
  * monthly / quarterly / yearly, always on the same day of the month.
  * A day that doesn't exist in a month (31st in April, 30th in February) falls on the
    month's last day, but the original day is kept: 31st -> 28 Feb -> 31 Mar.
  * A reminder shows from `remind_days` before the due date, and stays until it is paid.
  * Paying records a normal expense and moves the due date on by one period.
"""
import calendar
import re
from datetime import date, timedelta

import db
import export
from message_parser import ParseError, UNCATEGORIZED, parse_message, today_local

FREQUENCY_MONTHS = {"monthly": 1, "quarterly": 3, "yearly": 12}
_FREQUENCY_WORDS = {
    "monthly": "monthly", "every month": "monthly", "quarterly": "quarterly",
    "every quarter": "quarterly", "yearly": "yearly", "annual": "yearly",
    "annually": "yearly", "every year": "yearly",
}
_MONTHS = {name.lower(): i for i, name in enumerate(calendar.month_name) if name}
_MONTHS.update({name.lower(): i for i, name in enumerate(calendar.month_abbr) if name})


def _clamp(year, month, day):
    return date(year, month, min(day, calendar.monthrange(year, month)[1]))


def _add_months(year, month, count):
    index = year * 12 + (month - 1) + count
    return index // 12, index % 12 + 1


def next_due_after(due, frequency, due_day):
    """The due date one period after `due`."""
    year, month = _add_months(due.year, due.month, FREQUENCY_MONTHS[frequency])
    return _clamp(year, month, due_day)


def first_due(frequency, due_day, today, month=None):
    """The first due date on or after `today`. For yearly items `month` says which month."""
    if frequency == "yearly":
        month = month or today.month
        candidate = _clamp(today.year, month, due_day)
        return candidate if candidate >= today else _clamp(today.year + 1, month, due_day)
    candidate = _clamp(today.year, today.month, due_day)
    return candidate if candidate >= today else next_due_after(candidate, "monthly", due_day)


def status(row, today):
    """('overdue' | 'today' | 'soon' | 'later', days_until_due)"""
    days = (date.fromisoformat(row["next_due"]) - today).days
    if days < 0:
        return "overdue", days
    if days == 0:
        return "today", 0
    return ("soon" if days <= row["remind_days"] else "later"), days


def due_soon(folder=None, today=None):
    """Items whose reminder window has started (including overdue ones), most urgent first."""
    today = today or today_local()
    out = []
    for row in db.list_recurring(folder):
        state, days = status(row, today)
        if state != "later":
            out.append({"row": row, "state": state, "days": days, "text": due_text(row, today)})
    return out


def due_text(row, today):
    state, days = status(row, today)
    when = date.fromisoformat(row["next_due"])
    if state == "overdue":
        return f"{row['name']} was due {when:%d %b} ({-days} day{'s' if days != -1 else ''} ago)"
    if state == "today":
        return f"{row['name']} is due today"
    return f"{row['name']} is due {when:%d %b} (in {days} day{'s' if days != 1 else ''})"


def mark_paid(recurring_id, paid_by, paid_on, folder=None):
    """Record the expense and move the due date on. Returns the recorded amount, or None."""
    row = db.get_recurring(recurring_id, folder)
    if row is None:
        return None
    db.add_expense(row["amount"], row["category"], row["name"], paid_on, paid_by, folder)
    db.set_recurring_next_due(
        recurring_id, next_due_after(date.fromisoformat(row["next_due"]),
                                     row["frequency"], row["due_day"]), folder)
    export.refresh_excel(folder)
    return row


def reminder_share_text(row, today):
    """Text to post to the family group as a reminder."""
    from service import inr
    return f"Reminder: {due_text(row, today)}. Amount {inr(row['amount'])}."


def paid_share_text(row):
    """A line the group's importer reads back as this expense (name, amount, explicit category)."""
    category = "" if row["category"] == UNCATEGORIZED else f" {row['category']}"
    return f"{row['name']} {row['amount']:g}{category}"


# ---- chat command: "recurring rent 25000 monthly on 1", "recurring electricity 1800 monthly on the 15th remind 3"

def parse_recurring(text, today):
    """Returns dict(name, amount, category, frequency, due_day, month, remind_days) or raises ParseError."""
    rest = re.sub(r"^\s*recurring\s*(add)?\s*", "", text, flags=re.I)
    frequency = None
    for word in sorted(_FREQUENCY_WORDS, key=len, reverse=True):
        if re.search(rf"\b{word}\b", rest, re.I):
            frequency = _FREQUENCY_WORDS[word]
            rest = re.sub(rf"\b{word}\b", " ", rest, flags=re.I)
            break
    if frequency is None:
        raise ParseError("Say how often: monthly, quarterly or yearly. "
                         "Example: recurring rent 25000 monthly on 1")
    remind = 2
    m = re.search(r"\bremind(?:\s+me)?(?:\s+(\d{1,2}))\b(?:\s+days?(?:\s+before)?)?", rest, re.I)
    if m:
        remind = int(m.group(1))
        rest = rest.replace(m.group(0), " ")
    day = month = None
    names = "|".join(sorted(_MONTHS, key=len, reverse=True))
    m = re.search(rf"\bon\s+(?:the\s+)?(\d{{1,2}})(?:st|nd|rd|th)?(?:\s+(?:of\s+)?({names}))?\b", rest, re.I)
    if m:
        day = int(m.group(1))
        month = _MONTHS[m.group(2).lower()] if m.group(2) else None
        rest = rest.replace(m.group(0), " ")
    if day is None:
        day = today.day
    if not 1 <= day <= 31:
        raise ParseError("The day of the month must be between 1 and 31.")
    parsed = parse_message(rest, today=today)
    name = parsed.description if parsed.description and parsed.description != parsed.category else parsed.category
    return {"name": name[:60], "amount": parsed.amount, "category": parsed.category,
            "frequency": frequency, "due_day": day, "month": month, "remind_days": remind}


def create_from_text(text, today, folder=None):
    item = parse_recurring(text, today)
    due = first_due(item["frequency"], item["due_day"], today, item["month"])
    rid = db.add_recurring(item["name"], item["amount"], item["category"], item["frequency"],
                           item["due_day"], due, item["remind_days"], folder)
    return db.get_recurring(rid, folder)


def find_by_name(query, folder=None):
    """The recurring item whose name best matches `query` (None if none or ambiguous)."""
    query = query.strip().lower()
    rows = db.list_recurring(folder)
    exact = [r for r in rows if r["name"].lower() == query]
    if exact:
        return exact[0]
    partial = [r for r in rows if query and query in r["name"].lower()]
    return partial[0] if len(partial) == 1 else None

"""Date ranges, filters and summaries for the Reports page, the Excel download and chat commands.

Everything here is plain Python on top of db.py, so it is easy to test.
"""
import calendar
import re
from dataclasses import dataclass
from datetime import date, timedelta
from typing import Optional

import db
from message_parser import CATEGORIES, INCOME, UNCATEGORIZED, categorize, today_local

PERIODS = [
    ("month", "This month"), ("last_month", "Last month"), ("week", "This week"),
    ("today", "Today"), ("year", "This year"), ("all", "All time"), ("custom", "Custom dates"),
]
TYPES = [("", "Everything"), ("Expense", "Expenses only"), ("Income", "Income only")]


@dataclass
class Report:
    label: str
    period: str
    category: str
    person: str
    entry_type: str
    start: Optional[date]
    end: Optional[date]
    entries: list            # every matching row, newest first
    income: float
    expenses: float
    balance: float
    expense_count: int
    by_category: list        # dicts: category, entries, total, percent
    by_person: list          # dicts: person, entries, total, percent
    income_sources: list     # dicts: source, entries, total
    show_balance: bool       # income and balance mean nothing when filtered to one expense category


@dataclass
class MonthOverview:
    label: str
    income: float
    expenses: float
    balance: float


# ------------------------------------------------------------------ dates

def month_range(year, month):
    return date(year, month, 1), date(year, month, calendar.monthrange(year, month)[1])


def _parse_date(text, what):
    text = (text or "").strip()
    if not text:
        return None
    try:
        return date.fromisoformat(text)
    except ValueError:
        raise ValueError(f"The {what} date should look like 2026-11-30.") from None


def resolve_period(period="month", start="", end="", today=None):
    """Return (first_day, last_day, label). A first/last of None means 'no limit'."""
    today = today or today_local()
    if period == "all":
        return None, None, "All time"
    if period == "today":
        return today, today, f"Today, {today:%d %b %Y}"
    if period == "week":
        monday = today - timedelta(days=today.weekday())
        return monday, monday + timedelta(days=6), "This week"
    if period == "month":
        first, last = month_range(today.year, today.month)
        return first, last, f"{today:%B %Y}"
    if period == "last_month":
        previous = today.replace(day=1) - timedelta(days=1)
        first, last = month_range(previous.year, previous.month)
        return first, last, f"{previous:%B %Y}"
    if period == "year":
        return date(today.year, 1, 1), date(today.year, 12, 31), str(today.year)
    if period == "custom":
        first, last = _parse_date(start, "start"), _parse_date(end, "end")
        if not first and not last:
            raise ValueError("Pick a start date, an end date, or both.")
        if first and last and first > last:
            raise ValueError("The start date is after the end date.")
        if first and last and last == month_range(first.year, first.month)[1] and first.day == 1:
            label = f"{first:%B %Y}"  # a whole calendar month
        elif first and last:
            label = f"{first:%d %b %Y} to {last:%d %b %Y}"
        elif first:
            label = f"From {first:%d %b %Y}"
        else:
            label = f"Up to {last:%d %b %Y}"
        return first, last, label
    raise ValueError("Unknown period.")


# ---------------------------------------------------------------- summaries

def _with_percent(rows, name_key, expenses):
    return [{name_key: row[name_key], "entries": row["entries"], "total": round(row["total"], 2),
             "percent": round(row["total"] / expenses * 100, 1) if expenses else 0.0}
            for row in rows]


def build_report(folder=None, period="month", start="", end="", category="", person="",
                 entry_type="", today=None):
    first, last, label = resolve_period(period, start, end, today)
    if category and category not in set(CATEGORIES) | {UNCATEGORIZED, INCOME}:
        raise ValueError(f"Unknown category: {category}.")
    if entry_type not in ("Expense", "Income"):
        entry_type = ""

    base = {"person": person or None,
            "date_from": first.isoformat() if first else None,
            "date_to": last.isoformat() if last else None}
    narrowed = {**base, "category": category or None}

    entries = db.list_entries(folder, entry_type=entry_type or None, **narrowed)
    income = db.sum_amount(folder, entry_type="Income", **narrowed)
    expenses = db.sum_amount(folder, entry_type="Expense", **narrowed)
    by_category = _with_percent(db.totals_by_category(folder, **narrowed), "category", expenses)
    by_person = _with_percent(db.totals_by_person(folder, **narrowed), "person", expenses)
    sources = [{"source": r["source"], "entries": r["entries"], "total": round(r["total"], 2)}
               for r in db.income_by_source(folder, **base)]
    return Report(
        label=label, period=period, category=category, person=person, entry_type=entry_type,
        start=first, end=last, entries=entries, income=income, expenses=expenses,
        balance=round(income - expenses, 2),
        expense_count=sum(row["entries"] for row in by_category),
        by_category=by_category, by_person=by_person, income_sources=sources,
        show_balance=not category,
    )


def month_overview(folder=None, on=None):
    """Income, expenses and balance for the calendar month containing `on` (default: today)."""
    on = on or today_local()
    first, last = month_range(on.year, on.month)
    window = {"date_from": first.isoformat(), "date_to": last.isoformat()}
    income = db.sum_amount(folder, entry_type="Income", **window)
    expenses = db.sum_amount(folder, entry_type="Expense", **window)
    return MonthOverview(f"{on:%B %Y}", income, expenses, round(income - expenses, 2))


# ------------------------------------------------------------ chat command

_MONTH_NAMES = {}
for _number in range(1, 13):
    _MONTH_NAMES[calendar.month_name[_number].lower()] = _number
    _MONTH_NAMES[calendar.month_abbr[_number].lower()] = _number
_MONTH_NAMES["sept"] = 9
_MONTH_PATTERN = re.compile(
    r"\b(" + "|".join(sorted(_MONTH_NAMES, key=len, reverse=True)) + r")\b(?:\s+((?:19|20)\d{2}))?")


def parse_report_command(text, today=None):
    """'report grocery october' -> keyword arguments for build_report()."""
    today = today or today_local()
    rest = re.sub(r"^\s*report\b", "", text.lower()).strip()
    category = categorize(rest)
    request = {"period": "month", "start": "", "end": "",
               "category": "" if category == UNCATEGORIZED else category}

    month = _MONTH_PATTERN.search(rest)
    if month:
        number = _MONTH_NAMES[month.group(1)]
        # "december" typed in November means last December, not a month in the future
        year = int(month.group(2)) if month.group(2) else (
            today.year if number <= today.month else today.year - 1)
        first, last = month_range(year, number)
        request.update(period="custom", start=first.isoformat(), end=last.isoformat())
    elif re.search(r"\blast month\b", rest):
        request["period"] = "last_month"
    elif re.search(r"\btoday\b", rest):
        request["period"] = "today"
    elif re.search(r"\b(?:this )?week\b", rest):
        request["period"] = "week"
    elif re.search(r"\b(?:this )?year\b", rest):
        request["period"] = "year"
    elif re.search(r"\b(?:all|overall|everything)\b", rest):
        request["period"] = "all"
    return request

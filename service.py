"""The brain of the app: takes a chat message and a sender, saves it, returns a reply.

The web page uses handle_message() today. A WhatsApp or Telegram connection will call
the same function later, so none of the logic has to be rewritten.
"""
import json
import re
from dataclasses import dataclass
from datetime import date

import db
import export
import recurring
import reports
from message_parser import (CATEGORIES, UNCATEGORIZED, ParseError, parse_edit, parse_message,
                            today_local)

HELP_TEXT = (
    "Send a message with an amount, for example:\n"
    "• Spent 450 on vegetables\n"
    "• Medicine 320 yesterday\n"
    "• Gift 1500 birthday\n"
    "• Income 85000 salary\n"
    "Commands: total, month, report grocery october, undo, edit 500, help\n"
    "Recurring: recurring rent 25000 monthly on 1 · due · paid rent · recurring remove rent\n"
    "Categories: " + ", ".join(CATEGORIES)
)


@dataclass
class Reply:
    text: str
    ok: bool = True


def inr(amount):
    """Format a number the Indian way: 1234567.5 -> ₹12,34,567.50"""
    whole, fraction = f"{abs(amount):.2f}".split(".")
    if len(whole) > 3:
        head, tail = whole[:-3], whole[-3:]
        groups = []
        while len(head) > 2:
            groups.insert(0, head[-2:])
            head = head[:-2]
        if head:
            groups.insert(0, head)
        whole = ",".join(groups + [tail])
    return f"{'-' if amount < 0 else ''}₹{whole}.{fraction}"


def _pretty_date(iso):
    return date.fromisoformat(iso).strftime("%d %b %Y")


def _month_line(overview):
    return (f"{overview.label}: income {inr(overview.income)}, expenses {inr(overview.expenses)}, "
            f"balance {inr(overview.balance)}.")


def _entry_text(row):
    """'₹450.00 under Grocery (Vegetables, 10 Nov 2026)' - works for a database row or a dict."""
    when = _pretty_date(row["expense_date"])
    if row["entry_type"] == "Income":
        return f"income of {inr(row['amount'])} ({row['description']}, {when})"
    return f"{inr(row['amount'])} under {row['category']} ({row['description']}, {when})"


def _totals_line(entry, folder):
    if entry["entry_type"] == "Income":
        return _month_line(reports.month_overview(folder, on=date.fromisoformat(entry["expense_date"])))
    return f"Total so far: {inr(db.total_expenses(folder))}."


def _format_value(key, value):
    if key == "amount":
        return inr(value)
    if key == "expense_date":
        return _pretty_date(value)
    return str(value)


_FIELD_LABELS = (("amount", "amount"), ("category", "category"),
                 ("expense_date", "date"), ("description", "description"))


def _differences(before, after):
    return [f"{label} {_format_value(key, before[key])} → {_format_value(key, after[key])}"
            for key, label in _FIELD_LABELS if before[key] != after[key]]


def describe_change(change_row):
    """One readable line for the activity log, e.g. 'Deleted ₹450.00 under Grocery (...)'."""
    before = json.loads(change_row["before_json"])
    if change_row["action"] == "delete":
        return f"Deleted {_entry_text(before)}"
    after = json.loads(change_row["after_json"])
    return f"Edited {before['description']}: " + ", ".join(_differences(before, after))


def _report_reply(report):
    scope = " · ".join(part for part in (report.category, report.person, report.label) if part)
    if report.category:
        entries = f"{report.expense_count} entr{'y' if report.expense_count == 1 else 'ies'}"
        return f"{scope}: {inr(report.expenses)} across {entries}."
    lines = [f"{scope}: income {inr(report.income)}, expenses {inr(report.expenses)}, "
             f"balance {inr(report.balance)}."]
    for row in report.by_category[:5]:
        lines.append(f"• {row['category']}: {inr(row['total'])} ({row['percent']:.0f}%)")
    return "\n".join(lines)


def _is_report_command(command):
    """'report grocery october' is a command; 'report card fees 200' has an amount, so it is an expense."""
    return (command == "report" or command.startswith("report ")) \
        and not re.search(r"\d", re.sub(r"\b(?:19|20)\d{2}\b", "", command))


def _undo_last(sender, folder):
    entry = db.last_entry_by(sender, folder)
    if entry is None:
        return Reply("You have no entries to undo.", ok=False)
    db.delete_entry(entry["id"], sender, folder)
    export.refresh_excel(folder)
    return Reply(f"Removed {_entry_text(entry)}. {_totals_line(entry, folder)}")


def _edit_last(text, sender, folder, current):
    try:
        changes = parse_edit(text, current)
    except ParseError as problem:
        return Reply(str(problem), ok=False)
    entry = db.last_entry_by(sender, folder)
    if entry is None:
        return Reply("You have no entries to edit.", ok=False)
    if entry["entry_type"] == "Income" and "category" in changes:
        return Reply("Income entries don't have a category. You can change the amount, "
                     "for example: edit 90000.", ok=False)
    updated = db.update_entry(entry["id"], sender, folder, **changes)
    differences = _differences(entry, updated)
    if not differences:
        return Reply("Nothing to change: your last entry already looks like that.")
    export.refresh_excel(folder)
    return Reply(f"Updated your last entry ({entry['description']}): {', '.join(differences)}. "
                 f"{_totals_line(updated, folder)}")


def _due_lines(folder, current):
    items = recurring.due_soon(folder, current)
    if not items:
        return "Nothing is due soon."
    return "Due soon:\n" + "\n".join(
        f"• {i['text']} - {inr(i['row']['amount'])}" for i in items)


def _recurring_command(text, command, sender, folder, current):
    """Handles: due, recurring (list/add/remove), paid <name>. Returns None if not one of these."""
    if command in ("due", "reminders"):
        return Reply(_due_lines(folder, current))
    if command == "recurring":
        rows = db.list_recurring(folder)
        if not rows:
            return Reply("No recurring expenses yet. Add one: recurring rent 25000 monthly on 1")
        return Reply("Recurring expenses:\n" + "\n".join(
            f"• {r['name']} - {inr(r['amount'])} {r['frequency']}, next {r['next_due']}" for r in rows))
    if command.startswith("recurring remove ") or command.startswith("recurring stop "):
        name = text.split(None, 2)[2]
        row = recurring.find_by_name(name, folder)
        if row is None:
            return Reply(f"I couldn't find exactly one recurring expense matching '{name}'. "
                         "Send 'recurring' to see the list.", ok=False)
        db.delete_recurring(row["id"], folder)
        return Reply(f"Stopped recurring {row['name']}. Past payments stay.")
    if command.startswith("recurring "):
        try:
            row = recurring.create_from_text(text, current, folder)
        except ParseError as problem:
            return Reply(str(problem), ok=False)
        return Reply(f"Added recurring {row['name']}: {inr(row['amount'])} {row['frequency']}. "
                     f"Next due {row['next_due']}, reminder {row['remind_days']} days before.")
    match = re.match(r"^paid\s+([^\d]+)$", command)
    if match:
        row = recurring.find_by_name(match.group(1), folder)
        if row is not None:
            recurring.mark_paid(row["id"], sender, current, folder)
            nxt = db.get_recurring(row["id"], folder)["next_due"]
            return Reply(f"Recorded {row['name']} {inr(row['amount'])}. Next due {nxt}. "
                         f"To tell the group, post: {recurring.paid_share_text(row)}")
    return None


def handle_message(text, sender, folder=None, today=None):
    text = (text or "").strip()
    sender = (sender or "").strip() or "Unknown"
    command = text.lower().rstrip("?!. ")

    if command == "help":
        return Reply(HELP_TEXT)

    # Once at least one family member is listed, only active members can post.
    members = db.list_members(folder)
    if members:
        member = db.match_member(sender, [m for m in members if m["active"]])
        if member is None:
            return Reply(f"Sorry, {sender} isn't on the family list, so nothing was recorded. "
                         "Ask whoever manages the app to add you under Family.", ok=False)
        sender = member["name"]

    current = today or today_local()
    if command in ("total", "totals"):
        return Reply(f"Total expenses so far: {inr(db.total_expenses(folder))}")
    if command in ("month", "summary"):
        return Reply(_month_line(reports.month_overview(folder, on=current)))
    if command == "undo":
        return _undo_last(sender, folder)
    if command == "edit" or command.startswith("edit "):
        return _edit_last(text, sender, folder, current)
    reply = _recurring_command(text, command, sender, folder, current)
    if reply is not None:
        return reply
    if _is_report_command(command):
        try:
            report = reports.build_report(folder, today=current,
                                          **reports.parse_report_command(command, current))
        except ValueError as problem:
            return Reply(str(problem), ok=False)
        return Reply(_report_reply(report))

    try:
        parsed = parse_message(text, today=today)
    except ParseError as problem:
        return Reply(f"{problem}\n\n{HELP_TEXT}", ok=False)

    db.add_expense(parsed.amount, parsed.category, parsed.description,
                   parsed.expense_date, sender, folder, entry_type=parsed.entry_type)
    excel_ok = export.refresh_excel(folder) is not None

    if parsed.entry_type == "Income":
        reply = (f"Recorded income of {inr(parsed.amount)} ({parsed.description}). "
                 + _month_line(reports.month_overview(folder, on=parsed.expense_date)))
    else:
        reply = f"Recorded {inr(parsed.amount)} under {parsed.category}"
        if parsed.expense_date != current:
            reply += f" for {parsed.expense_date:%d %b %Y}"
        reply += f". Total so far: {inr(db.total_expenses(folder))}."
        if parsed.category == UNCATEGORIZED:
            reply += " I couldn't tell the category. Next time include one, like Grocery or Travel."
    if not excel_ok:
        reply += " (The Excel file couldn't be updated. Close it if it's open; your entry is safe.)"
    return Reply(reply)

"""The brain of the app: takes a chat message and a sender, saves it, returns a reply.

The web page uses handle_message() today. The WhatsApp webhook will call the
same function later, so none of the logic has to be rewritten.
"""
from dataclasses import dataclass

import db
import export
from message_parser import CATEGORIES, UNCATEGORIZED, ParseError, parse_message, today_local

HELP_TEXT = (
    "Send a message with an amount, for example:\n"
    "• Spent 450 on vegetables\n"
    "• Medicine 320 yesterday\n"
    "• Gift 1500 birthday\n"
    "Commands: total, help\n"
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

    if command in ("total", "totals"):
        return Reply(f"Total expenses so far: {inr(db.total_expenses(folder))}")

    try:
        parsed = parse_message(text, today=today)
    except ParseError as problem:
        return Reply(f"{problem}\n\n{HELP_TEXT}", ok=False)

    db.add_expense(parsed.amount, parsed.category, parsed.description,
                   parsed.expense_date, sender, folder)
    excel_ok = export.refresh_excel(folder) is not None

    reply = f"Recorded {inr(parsed.amount)} under {parsed.category}"
    if parsed.expense_date != (today or today_local()):
        reply += f" for {parsed.expense_date:%d %b %Y}"
    reply += f". Total so far: {inr(db.total_expenses(folder))}."
    if parsed.category == UNCATEGORIZED:
        reply += " I couldn't tell the category. Next time include one, like Grocery or Travel."
    if not excel_ok:
        reply += " (The Excel file couldn't be updated. Close it if it's open; your entry is safe.)"
    return Reply(reply)

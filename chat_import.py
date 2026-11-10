"""Read a WhatsApp "Export chat" file and turn expense-like messages into entries.

Nothing is saved straight away. Messages are parked for review, because a family
chat is full of numbers that are not expenses ("dinner at 8"). The user ticks
what to keep, and only then is it saved.

Handles both export styles:
  Android: 05/11/26, 8:45 am - Asha: Spent 450 on vegetables
  iPhone:  [05/11/26, 8:45:12 AM] Asha: Spent 450 on vegetables   (exported as a .zip)
"""
import hashlib
import io
import re
import uuid
import zipfile
from collections import Counter
from dataclasses import dataclass, field
from datetime import date, datetime

import db
import export
from message_parser import CATEGORIES, UNCATEGORIZED, ParseError, parse_message

MAX_EXPORT_BYTES = 20 * 1024 * 1024

_HEADER = re.compile(
    r"^\[?(?P<a>\d{1,2})[/.\-](?P<b>\d{1,2})[/.\-](?P<year>\d{2,4}),?\s+"
    r"(?P<hour>\d{1,2})[:.](?P<minute>\d{2})(?::(?P<second>\d{2}))?\s*"
    r"(?P<ampm>[ap]\.?m\.?)?\]?\s*(?:-\s*)?(?P<rest>.*)$",
    re.IGNORECASE,
)
_SKIPPED = re.compile(
    r"^(?:<?media omitted>?|<?(?:image|video|audio|sticker|gif|document) omitted>?"
    r"|this message was deleted\.?|you deleted this message\.?|null)$",
    re.IGNORECASE,
)
_CURRENCY = re.compile(r"₹|\brs\.?\s*\d|\binr\b", re.IGNORECASE)
_SPENDING_VERB = re.compile(r"\b(?:spent|paid|bought)\b", re.IGNORECASE)


@dataclass
class ChatMessage:
    when: datetime
    sender: str
    text: str


@dataclass
class ImportSummary:
    batch_id: str
    messages_read: int = 0
    candidates: int = 0
    likely: int = 0
    already_imported: int = 0
    ignored_senders: dict = field(default_factory=dict)  # name -> expense-like messages ignored


# ------------------------------------------------------------ reading files

def read_export(data, filename=""):
    """Return the chat text from an uploaded .txt or .zip. Raises ValueError with a friendly message."""
    if data[:2] == b"PK":  # iPhone exports are zip files containing _chat.txt
        try:
            with zipfile.ZipFile(io.BytesIO(data)) as archive:
                entries = [i for i in archive.infolist()
                           if not i.is_dir() and i.filename.lower().endswith(".txt")]
                if not entries:
                    raise ValueError("That zip file doesn't contain a chat text file.")
                entries.sort(key=lambda i: (not i.filename.endswith("_chat.txt"), i.filename))
                with archive.open(entries[0]) as handle:
                    data = handle.read(MAX_EXPORT_BYTES + 1)
        except zipfile.BadZipFile:
            raise ValueError("That file looks like a zip, but it couldn't be opened.") from None
    if len(data) > MAX_EXPORT_BYTES:
        raise ValueError("That chat file is too large (limit 20 MB). Export 'Without media'.")
    return data.decode("utf-8-sig", errors="replace")


def _normalize(line):
    for odd, plain in ((" ", " "), (" ", " "), ("‎", ""), ("‏", ""), ("﻿", "")):
        line = line.replace(odd, plain)
    return line.rstrip("\r\n")


def _detect_dayfirst(lines):
    """Exports are 05/11/26 (day first, as in India) or 11/05/26 (month first, as in the US).
    A number above 12 settles it; if every date is ambiguous we assume day first."""
    for line in lines:
        match = _HEADER.match(line)
        if match:
            if int(match["a"]) > 12:
                return True
            if int(match["b"]) > 12:
                return False
    return True


def _build_datetime(match, dayfirst):
    first, second = int(match["a"]), int(match["b"])
    day, month = (first, second) if dayfirst else (second, first)
    year = int(match["year"])
    year += 2000 if year < 100 else 0
    hour, minute = int(match["hour"]), int(match["minute"])
    ampm = (match["ampm"] or "").replace(".", "").lower()
    if ampm == "pm" and hour < 12:
        hour += 12
    if ampm == "am" and hour == 12:
        hour = 0
    return datetime(year, month, day, hour, minute, int(match["second"] or 0))  # may raise ValueError


def parse_chat(text):
    """Split exported text into messages. Handles multi-line messages and skips system notices."""
    lines = [_normalize(line) for line in text.splitlines()]
    dayfirst = _detect_dayfirst(lines)
    messages, current = [], None
    for line in lines:
        header = _HEADER.match(line)
        when = None
        if header:
            try:
                when = _build_datetime(header, dayfirst)
            except ValueError:
                when = None
        if when:
            if current:
                messages.append(current)
            sender, separator, body = header["rest"].partition(": ")
            # No "Name: " means a system notice ("Messages are end-to-end encrypted...")
            current = ChatMessage(when, sender.strip(), body) if separator else None
        elif current is not None:
            current.text += "\n" + line  # a continuation line of a multi-line message
    if current:
        messages.append(current)
    return messages


# ----------------------------------------------------------------- staging

def _clean_body(text):
    return re.sub(r"\s*<This message was edited>\s*$", "", text.strip()).strip()


def _looks_like_expense(body, parsed):
    """Pre-tick only messages that read like a logged expense."""
    if "?" in body or len(body.split()) > 12:
        return False
    return bool(_CURRENCY.search(body) or _SPENDING_VERB.search(body)
                or parsed.category != UNCATEGORIZED)


def _fingerprint(member_name, when, body, occurrence):
    # Minute resolution, because Android exports have no seconds and iPhone exports do.
    # That way the same message in two overlapping exports gets the same key.
    raw = f"{member_name}|{when:%Y-%m-%d %H:%M}|{body}|{occurrence}"
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()[:32]


def stage_import(text, folder=None):
    members = db.list_members(folder, only_active=True)
    saved_keys = db.saved_source_keys(folder)
    messages = parse_chat(text)
    summary = ImportSummary(batch_id=uuid.uuid4().hex, messages_read=len(messages))
    occurrences, ignored, rows = Counter(), Counter(), []

    for message in messages:
        body = _clean_body(message.text)
        if not body or _SKIPPED.match(body):
            continue
        try:
            parsed = parse_message(body, today=message.when.date())
        except ParseError:
            continue  # ordinary chatter, no amount
        member = db.match_member(message.sender, members)
        if member is None:
            ignored[message.sender] += 1
            continue

        seen = (member["name"], f"{message.when:%Y-%m-%d %H:%M}", body)
        key = _fingerprint(member["name"], message.when, body, occurrences[seen])
        occurrences[seen] += 1
        if key in saved_keys:
            summary.already_imported += 1
            continue
        rows.append({
            "source_key": key,
            "expense_date": parsed.expense_date.isoformat(),
            "amount": parsed.amount,
            "category": parsed.category,
            "description": parsed.description,
            "original_text": " ".join(body.split()),
            "added_by": member["name"],
            "likely": _looks_like_expense(body, parsed),
        })

    db.stage_candidates(summary.batch_id, rows, folder)
    summary.candidates = len(rows)
    summary.likely = sum(1 for row in rows if row["likely"])
    summary.ignored_senders = dict(ignored)
    return summary


def confirm_import(batch_id, selected_ids, category_overrides=None, folder=None):
    """Save the ticked rows. Returns (saved, duplicates_skipped)."""
    category_overrides = category_overrides or {}
    allowed = set(CATEGORIES) | {UNCATEGORIZED}
    saved = duplicates = 0
    for row in db.staged_rows(batch_id, folder):
        if row["id"] not in selected_ids:
            continue
        category = category_overrides.get(row["id"], row["category"])
        if category not in allowed:
            category = row["category"]
        result = db.add_expense(row["amount"], category, row["description"],
                                date.fromisoformat(row["expense_date"]), row["added_by"],
                                folder, source_key=row["source_key"])
        if result is None:
            duplicates += 1
        else:
            saved += 1
    db.delete_batch(batch_id, folder)
    export.refresh_excel(folder)
    return saved, duplicates

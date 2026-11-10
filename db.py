"""Storage. SQLite is the source of truth; the Excel file is generated from it.

SQLite is a single file with no server to install, and it handles two family
members posting at the same moment safely (an Excel file cannot).
"""
import os
import re
import sqlite3
from contextlib import closing
from datetime import datetime, timedelta
from pathlib import Path

SCHEMA = [
    """
    CREATE TABLE IF NOT EXISTS expenses (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        expense_date TEXT NOT NULL,                  -- YYYY-MM-DD
        amount       REAL NOT NULL,
        category     TEXT NOT NULL,
        description  TEXT NOT NULL,
        added_by     TEXT NOT NULL,
        entry_type   TEXT NOT NULL DEFAULT 'Expense', -- 'Income' arrives in phase 2
        created_at   TEXT NOT NULL,
        source_key   TEXT                             -- fingerprint of an imported chat message
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS members (
        id        INTEGER PRIMARY KEY AUTOINCREMENT,
        name      TEXT NOT NULL UNIQUE COLLATE NOCASE,  -- how the app shows the person
        chat_name TEXT NOT NULL DEFAULT '',             -- name as shown in the WhatsApp chat, if different
        phone     TEXT NOT NULL DEFAULT '',             -- for people WhatsApp shows only as a number
        active    INTEGER NOT NULL DEFAULT 1
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS import_candidates (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        batch_id      TEXT NOT NULL,
        source_key    TEXT NOT NULL,
        expense_date  TEXT NOT NULL,
        amount        REAL NOT NULL,
        category      TEXT NOT NULL,
        description   TEXT NOT NULL,
        original_text TEXT NOT NULL,
        added_by      TEXT NOT NULL,
        likely        INTEGER NOT NULL,                 -- 1 = pre-ticked on the review page
        created_at    TEXT NOT NULL
    )
    """,
]


def data_dir(override=None):
    folder = Path(override) if override else Path(
        os.environ.get("HOUSEHOLD_DATA_DIR", Path(__file__).parent / "data"))
    folder.mkdir(parents=True, exist_ok=True)
    return folder


def connect(folder=None):
    conn = sqlite3.connect(data_dir(folder) / "household.db")
    conn.row_factory = sqlite3.Row
    for statement in SCHEMA:
        conn.execute(statement)
    # A database created by the first MVP has no source_key column yet: add it.
    columns = {row["name"] for row in conn.execute("PRAGMA table_info(expenses)")}
    if "source_key" not in columns:
        conn.execute("ALTER TABLE expenses ADD COLUMN source_key TEXT")
    # Unique index: the same imported chat message can never be saved twice.
    # (Rows typed in directly have no source_key, and any number of those are allowed.)
    conn.execute("CREATE UNIQUE INDEX IF NOT EXISTS ux_expenses_source_key ON expenses(source_key)")
    conn.commit()
    return conn


# ---------------------------------------------------------------- expenses

def add_expense(amount, category, description, expense_date, added_by,
                folder=None, source_key=None):
    """Save one expense. Returns its id, or None if source_key was already saved."""
    try:
        with closing(connect(folder)) as conn, conn:  # inner "conn" commits the change
            cursor = conn.execute(
                "INSERT INTO expenses (expense_date, amount, category, description, added_by,"
                " created_at, source_key) VALUES (?, ?, ?, ?, ?, ?, ?)",
                (expense_date.isoformat(), round(amount, 2), category, description, added_by,
                 datetime.now().isoformat(timespec="seconds"), source_key),
            )
            return cursor.lastrowid
    except sqlite3.IntegrityError:
        return None


def total_expenses(folder=None):
    with closing(connect(folder)) as conn:
        row = conn.execute(
            "SELECT COALESCE(SUM(amount), 0) AS total FROM expenses WHERE entry_type = 'Expense'"
        ).fetchone()
        return round(row["total"], 2)


def totals_by_category(folder=None):
    with closing(connect(folder)) as conn:
        return conn.execute(
            "SELECT category, SUM(amount) AS total, COUNT(*) AS entries FROM expenses"
            " WHERE entry_type = 'Expense' GROUP BY category ORDER BY total DESC"
        ).fetchall()


def recent(limit=20, folder=None):
    with closing(connect(folder)) as conn:
        return conn.execute(
            "SELECT * FROM expenses ORDER BY expense_date DESC, id DESC LIMIT ?", (limit,)
        ).fetchall()


def all_expenses(folder=None):
    with closing(connect(folder)) as conn:
        return conn.execute("SELECT * FROM expenses ORDER BY expense_date, id").fetchall()


def saved_source_keys(folder=None):
    with closing(connect(folder)) as conn:
        rows = conn.execute("SELECT source_key FROM expenses WHERE source_key IS NOT NULL")
        return {row["source_key"] for row in rows}


# ----------------------------------------------------------------- members

def digits(text):
    return re.sub(r"\D", "", text or "")


def add_member(name, chat_name="", phone="", folder=None):
    name, chat_name, phone = (name or "").strip(), (chat_name or "").strip(), (phone or "").strip()
    if not name:
        raise ValueError("Please enter a name.")
    if phone and len(digits(phone)) < 10:
        raise ValueError("A phone number needs at least 10 digits.")
    try:
        with closing(connect(folder)) as conn, conn:
            return conn.execute(
                "INSERT INTO members (name, chat_name, phone) VALUES (?, ?, ?)",
                (name, chat_name, phone),
            ).lastrowid
    except sqlite3.IntegrityError:
        raise ValueError(f"{name} is already on the list.") from None


def list_members(folder=None, only_active=False):
    query = "SELECT * FROM members" + (" WHERE active = 1" if only_active else "") + " ORDER BY name"
    with closing(connect(folder)) as conn:
        return conn.execute(query).fetchall()


def set_member_active(member_id, active, folder=None):
    with closing(connect(folder)) as conn, conn:
        conn.execute("UPDATE members SET active = ? WHERE id = ?", (1 if active else 0, member_id))


def delete_member(member_id, folder=None):
    with closing(connect(folder)) as conn, conn:
        conn.execute("DELETE FROM members WHERE id = ?", (member_id,))


def match_member(sender, members):
    """Which member is this sender? Matches the app name, the WhatsApp chat name, or the
    phone number (last 10 digits, so +91 and spaces don't matter). Returns None if no match."""
    wanted = (sender or "").strip().casefold()
    sender_digits = digits(sender)
    for member in members:
        names = {member["name"].casefold(), (member["chat_name"] or "").casefold()} - {""}
        if wanted in names:
            return member
        member_digits = digits(member["phone"])
        if len(sender_digits) >= 10 and len(member_digits) >= 10 \
                and sender_digits[-10:] == member_digits[-10:]:
            return member
    return None


# ------------------------------------------------- staged imports (review)

def stage_candidates(batch_id, rows, folder=None):
    """Park parsed chat messages here until the user confirms which to keep."""
    now = datetime.now()
    cutoff = (now - timedelta(days=2)).isoformat(timespec="seconds")
    with closing(connect(folder)) as conn, conn:
        conn.execute("DELETE FROM import_candidates WHERE created_at < ?", (cutoff,))
        conn.executemany(
            "INSERT INTO import_candidates (batch_id, source_key, expense_date, amount, category,"
            " description, original_text, added_by, likely, created_at)"
            " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            [(batch_id, r["source_key"], r["expense_date"], r["amount"], r["category"],
              r["description"], r["original_text"], r["added_by"], 1 if r["likely"] else 0,
              now.isoformat(timespec="seconds")) for r in rows],
        )


def staged_rows(batch_id, folder=None):
    with closing(connect(folder)) as conn:
        return conn.execute(
            "SELECT * FROM import_candidates WHERE batch_id = ? ORDER BY expense_date, id",
            (batch_id,),
        ).fetchall()


def delete_batch(batch_id, folder=None):
    with closing(connect(folder)) as conn, conn:
        conn.execute("DELETE FROM import_candidates WHERE batch_id = ?", (batch_id,))

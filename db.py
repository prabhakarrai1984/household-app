"""Storage. SQLite is the source of truth; the Excel file is generated from it.

SQLite is a single file with no server to install, and it handles two family
members posting at the same moment safely (an Excel file cannot).
"""
import json
import os
import re
import sqlite3
from contextlib import closing
from datetime import date, datetime, timedelta
from pathlib import Path

SCHEMA = [
    """
    CREATE TABLE IF NOT EXISTS expenses (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        expense_date TEXT NOT NULL,                  -- YYYY-MM-DD
        amount       REAL NOT NULL,
        category     TEXT NOT NULL,                  -- income rows use the category "Income"
        description  TEXT NOT NULL,                  -- for income this is the source, e.g. Salary
        added_by     TEXT NOT NULL,
        entry_type   TEXT NOT NULL DEFAULT 'Expense', -- 'Expense' or 'Income'
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
        created_at    TEXT NOT NULL,
        entry_type    TEXT NOT NULL DEFAULT 'Expense'
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS changes (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        changed_at  TEXT NOT NULL,
        changed_by  TEXT NOT NULL,
        action      TEXT NOT NULL,                      -- 'edit' or 'delete'
        entry_id    INTEGER NOT NULL,
        before_json TEXT NOT NULL,                      -- the entry as it was
        after_json  TEXT                                -- the entry after an edit (empty for deletes)
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS ignored_source_keys (
        source_key TEXT PRIMARY KEY                     -- imported messages the user deleted
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS recurring (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        name        TEXT NOT NULL,
        amount      REAL NOT NULL,
        category    TEXT NOT NULL,
        frequency   TEXT NOT NULL,                      -- monthly, quarterly or yearly
        due_day     INTEGER NOT NULL,                   -- day of month it falls on (1-31)
        next_due    TEXT NOT NULL,                      -- YYYY-MM-DD
        remind_days INTEGER NOT NULL DEFAULT 2,
        active      INTEGER NOT NULL DEFAULT 1
    )
    """,
]


def data_dir(override=None):
    folder = Path(override) if override else Path(
        os.environ.get("HOUSEHOLD_DATA_DIR", Path(__file__).parent / "data"))
    folder.mkdir(parents=True, exist_ok=True)
    return folder


def _add_column_if_missing(conn, table, column, definition):
    columns = {row["name"] for row in conn.execute(f"PRAGMA table_info({table})")}
    if column not in columns:
        conn.execute(f"ALTER TABLE {table} ADD COLUMN {column} {definition}")


def connect(folder=None):
    conn = sqlite3.connect(data_dir(folder) / "household.db")
    conn.row_factory = sqlite3.Row
    for statement in SCHEMA:
        conn.execute(statement)
    # Databases made by earlier versions of the app are upgraded in place.
    _add_column_if_missing(conn, "expenses", "source_key", "TEXT")
    _add_column_if_missing(conn, "import_candidates", "entry_type", "TEXT NOT NULL DEFAULT 'Expense'")
    # Unique index: the same imported chat message can never be saved twice.
    # (Rows typed in directly have no source_key, and any number of those are allowed.)
    conn.execute("CREATE UNIQUE INDEX IF NOT EXISTS ux_expenses_source_key ON expenses(source_key)")
    conn.commit()
    return conn


# ---------------------------------------------------------------- entries

def add_expense(amount, category, description, expense_date, added_by,
                folder=None, source_key=None, entry_type="Expense"):
    """Save one expense (or income). Returns its id, or None if source_key was already saved."""
    try:
        with closing(connect(folder)) as conn, conn:  # inner "conn" commits the change
            cursor = conn.execute(
                "INSERT INTO expenses (expense_date, amount, category, description, added_by,"
                " entry_type, created_at, source_key) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                (expense_date.isoformat(), round(amount, 2), category, description, added_by,
                 entry_type, datetime.now().isoformat(timespec="seconds"), source_key),
            )
            return cursor.lastrowid
    except sqlite3.IntegrityError:
        return None


def _where(entry_type=None, category=None, person=None, date_from=None, date_to=None, text=None):
    """Build the WHERE part of a query from whichever filters were given (empty ones are skipped)."""
    clauses, params = [], []
    if entry_type:
        clauses.append("entry_type = ?")
        params.append(entry_type)
    if category:
        clauses.append("category = ?")
        params.append(category)
    if person:
        clauses.append("added_by = ? COLLATE NOCASE")
        params.append(person)
    if date_from:
        clauses.append("expense_date >= ?")
        params.append(date_from)
    if date_to:
        clauses.append("expense_date <= ?")
        params.append(date_to)
    if text:  # search box: matches the description, category or person; % and _ are taken literally
        like = "%" + text.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%"
        clauses.append("(description LIKE ? ESCAPE '\\' OR category LIKE ? ESCAPE '\\'"
                       " OR added_by LIKE ? ESCAPE '\\')")
        params.extend([like, like, like])
    return (" WHERE " + " AND ".join(clauses)) if clauses else "", params


def list_entries(folder=None, limit=None, **filters):
    where, params = _where(**filters)
    sql = "SELECT * FROM expenses" + where + " ORDER BY expense_date DESC, id DESC"
    if limit:
        sql += " LIMIT ?"
        params.append(limit)
    with closing(connect(folder)) as conn:
        return conn.execute(sql, params).fetchall()


def sum_amount(folder=None, **filters):
    where, params = _where(**filters)
    with closing(connect(folder)) as conn:
        row = conn.execute("SELECT COALESCE(SUM(amount), 0) AS total FROM expenses" + where, params).fetchone()
        return round(row["total"], 2)


def total_expenses(folder=None):
    return sum_amount(folder, entry_type="Expense")


def total_income(folder=None, **filters):
    return sum_amount(folder, entry_type="Income", **filters)


def totals_by_category(folder=None, **filters):
    """Expense totals per category (income is never included)."""
    where, params = _where(**{**filters, "entry_type": "Expense"})
    with closing(connect(folder)) as conn:
        return conn.execute(
            "SELECT category, SUM(amount) AS total, COUNT(*) AS entries FROM expenses"
            + where + " GROUP BY category ORDER BY total DESC", params).fetchall()


def totals_by_person(folder=None, **filters):
    where, params = _where(**{**filters, "entry_type": "Expense"})
    with closing(connect(folder)) as conn:
        return conn.execute(
            "SELECT MIN(added_by) AS person, SUM(amount) AS total, COUNT(*) AS entries FROM expenses"
            + where + " GROUP BY lower(added_by) ORDER BY total DESC", params).fetchall()


def income_by_source(folder=None, **filters):
    where, params = _where(**{**filters, "entry_type": "Income"})
    with closing(connect(folder)) as conn:
        return conn.execute(
            "SELECT MIN(description) AS source, SUM(amount) AS total, COUNT(*) AS entries FROM expenses"
            + where + " GROUP BY lower(description) ORDER BY total DESC", params).fetchall()


def people(folder=None):
    with closing(connect(folder)) as conn:
        rows = conn.execute("SELECT DISTINCT added_by FROM expenses ORDER BY added_by COLLATE NOCASE")
        return [row["added_by"] for row in rows]


def recent(limit=20, folder=None):
    return list_entries(folder, limit=limit)


EDITABLE_FIELDS = {"expense_date", "amount", "category", "description"}


def get_entry(entry_id, folder=None):
    with closing(connect(folder)) as conn:
        return conn.execute("SELECT * FROM expenses WHERE id = ?", (entry_id,)).fetchone()


def last_entry_by(person, folder=None):
    """The newest entry this person typed in. Entries brought in from an imported chat are
    never returned, so "undo" can't remove something from last month's import."""
    with closing(connect(folder)) as conn:
        return conn.execute(
            "SELECT * FROM expenses WHERE added_by = ? COLLATE NOCASE AND source_key IS NULL"
            " ORDER BY id DESC LIMIT 1", (person,)).fetchone()


def _log_change(conn, changed_by, action, entry_id, before, after=None):
    conn.execute(
        "INSERT INTO changes (changed_at, changed_by, action, entry_id, before_json, after_json)"
        " VALUES (?, ?, ?, ?, ?, ?)",
        (datetime.now().isoformat(timespec="seconds"), changed_by, action, entry_id,
         json.dumps(dict(before)), json.dumps(dict(after)) if after is not None else None))


def update_entry(entry_id, changed_by, folder=None, **fields):
    """Change date, amount, category or description. Returns the updated row (unchanged if the
    values were already the same), or None if the entry doesn't exist. Every change is logged."""
    unknown = set(fields) - EDITABLE_FIELDS
    if unknown:
        raise ValueError(f"Can't edit: {', '.join(sorted(unknown))}")
    values = {}
    for key, value in fields.items():
        if key == "expense_date" and isinstance(value, date):
            value = value.isoformat()
        elif key == "amount":
            value = round(float(value), 2)
        values[key] = value
    with closing(connect(folder)) as conn, conn:
        before = conn.execute("SELECT * FROM expenses WHERE id = ?", (entry_id,)).fetchone()
        if before is None:
            return None
        changed = {key: value for key, value in values.items() if before[key] != value}
        if not changed:
            return before
        assignments = ", ".join(f"{key} = ?" for key in changed)  # keys were checked above
        conn.execute(f"UPDATE expenses SET {assignments} WHERE id = ?", [*changed.values(), entry_id])
        after = conn.execute("SELECT * FROM expenses WHERE id = ?", (entry_id,)).fetchone()
        _log_change(conn, changed_by, "edit", entry_id, before, after)
        return after


def delete_entry(entry_id, changed_by, folder=None):
    """Delete an entry and log it. Returns the deleted row, or None if it didn't exist.
    A deleted imported message is remembered so that importing the chat again won't offer it back."""
    with closing(connect(folder)) as conn, conn:
        row = conn.execute("SELECT * FROM expenses WHERE id = ?", (entry_id,)).fetchone()
        if row is None:
            return None
        if row["source_key"]:
            conn.execute("INSERT OR IGNORE INTO ignored_source_keys (source_key) VALUES (?)",
                         (row["source_key"],))
        conn.execute("DELETE FROM expenses WHERE id = ?", (entry_id,))
        _log_change(conn, changed_by, "delete", entry_id, row)
        return row


def recent_changes(limit=10, folder=None):
    with closing(connect(folder)) as conn:
        return conn.execute("SELECT * FROM changes ORDER BY id DESC LIMIT ?", (limit,)).fetchall()


def all_expenses(folder=None):
    with closing(connect(folder)) as conn:
        return conn.execute("SELECT * FROM expenses ORDER BY expense_date, id").fetchall()


def saved_source_keys(folder=None):
    with closing(connect(folder)) as conn:
        rows = conn.execute("SELECT source_key FROM expenses WHERE source_key IS NOT NULL"
                            " UNION SELECT source_key FROM ignored_source_keys")
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
            " description, original_text, added_by, likely, created_at, entry_type)"
            " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            [(batch_id, r["source_key"], r["expense_date"], r["amount"], r["category"],
              r["description"], r["original_text"], r["added_by"], 1 if r["likely"] else 0,
              now.isoformat(timespec="seconds"), r["entry_type"]) for r in rows],
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


# ------------------------------------------------------------------ recurring expenses

def add_recurring(name, amount, category, frequency, due_day, next_due, remind_days=2, folder=None):
    with closing(connect(folder)) as conn, conn:
        return conn.execute(
            "INSERT INTO recurring (name, amount, category, frequency, due_day, next_due, remind_days)"
            " VALUES (?, ?, ?, ?, ?, ?, ?)",
            (name, round(amount, 2), category, frequency, due_day, next_due.isoformat(), remind_days),
        ).lastrowid


def list_recurring(folder=None):
    with closing(connect(folder)) as conn:
        return conn.execute(
            "SELECT * FROM recurring WHERE active = 1 ORDER BY next_due, name").fetchall()


def get_recurring(recurring_id, folder=None):
    with closing(connect(folder)) as conn:
        return conn.execute("SELECT * FROM recurring WHERE id = ?", (recurring_id,)).fetchone()


def set_recurring_next_due(recurring_id, next_due, folder=None):
    with closing(connect(folder)) as conn, conn:
        conn.execute("UPDATE recurring SET next_due = ? WHERE id = ?",
                     (next_due.isoformat(), recurring_id))


def delete_recurring(recurring_id, folder=None):
    with closing(connect(folder)) as conn, conn:
        conn.execute("DELETE FROM recurring WHERE id = ?", (recurring_id,))

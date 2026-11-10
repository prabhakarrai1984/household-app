import sqlite3
import tempfile
import unittest
from datetime import date
from pathlib import Path

import db


class MemberTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.folder = self._tmp.name

    def tearDown(self):
        self._tmp.cleanup()

    def test_matching_by_name_chat_name_and_phone(self):
        db.add_member("Asha", chat_name="Mom", folder=self.folder)
        db.add_member("Meera", phone="+91 98765 43210", folder=self.folder)
        members = db.list_members(self.folder)
        self.assertEqual(db.match_member("asha", members)["name"], "Asha")        # case-insensitive
        self.assertEqual(db.match_member("Mom", members)["name"], "Asha")         # name in WhatsApp
        self.assertEqual(db.match_member("+91 98765 43210", members)["name"], "Meera")
        self.assertEqual(db.match_member("9876543210", members)["name"], "Meera")  # formatting ignored
        self.assertIsNone(db.match_member("Karan", members))
        self.assertIsNone(db.match_member("", members))

    def test_validation(self):
        db.add_member("Asha", folder=self.folder)
        with self.assertRaises(ValueError):
            db.add_member("ASHA", folder=self.folder)          # duplicate, any capitalisation
        with self.assertRaises(ValueError):
            db.add_member("   ", folder=self.folder)           # empty name
        with self.assertRaises(ValueError):
            db.add_member("Neha", phone="12345", folder=self.folder)  # too short

    def test_pause_and_remove(self):
        member_id = db.add_member("Asha", folder=self.folder)
        db.set_member_active(member_id, False, self.folder)
        self.assertEqual(db.list_members(self.folder, only_active=True), [])
        db.delete_member(member_id, self.folder)
        self.assertEqual(db.list_members(self.folder), [])


class MigrationTests(unittest.TestCase):
    def test_database_from_the_first_mvp_is_upgraded_in_place(self):
        with tempfile.TemporaryDirectory() as folder:
            old = sqlite3.connect(Path(folder) / "household.db")
            old.execute("""CREATE TABLE expenses (
                id INTEGER PRIMARY KEY AUTOINCREMENT, expense_date TEXT NOT NULL, amount REAL NOT NULL,
                category TEXT NOT NULL, description TEXT NOT NULL, added_by TEXT NOT NULL,
                entry_type TEXT NOT NULL DEFAULT 'Expense', created_at TEXT NOT NULL)""")
            old.execute("INSERT INTO expenses (expense_date, amount, category, description, added_by,"
                        " created_at) VALUES ('2026-11-01', 450, 'Grocery', 'Vegetables', 'Asha', 'x')")
            old.commit()
            old.close()

            self.assertEqual(db.total_expenses(folder), 450)  # old data still there
            first = db.add_expense(100, "Gift", "Toy", date(2026, 11, 2), "Asha", folder, source_key="k1")
            again = db.add_expense(100, "Gift", "Toy", date(2026, 11, 2), "Asha", folder, source_key="k1")
            self.assertIsNotNone(first)
            self.assertIsNone(again)                           # duplicate key refused
            self.assertEqual(db.total_expenses(folder), 550)
            # entries typed in by hand have no key, and any number of them is fine
            db.add_expense(5, "Gift", "a", date(2026, 11, 2), "Asha", folder)
            db.add_expense(5, "Gift", "a", date(2026, 11, 2), "Asha", folder)
            self.assertEqual(db.total_expenses(folder), 560)

    def test_pending_imports_table_from_the_previous_version_is_upgraded(self):
        with tempfile.TemporaryDirectory() as folder:
            old = sqlite3.connect(Path(folder) / "household.db")
            old.execute("""CREATE TABLE import_candidates (
                id INTEGER PRIMARY KEY AUTOINCREMENT, batch_id TEXT NOT NULL, source_key TEXT NOT NULL,
                expense_date TEXT NOT NULL, amount REAL NOT NULL, category TEXT NOT NULL,
                description TEXT NOT NULL, original_text TEXT NOT NULL, added_by TEXT NOT NULL,
                likely INTEGER NOT NULL, created_at TEXT NOT NULL)""")
            old.commit()
            old.close()
            db.stage_candidates("b1", [{
                "source_key": "k", "expense_date": "2026-11-01", "amount": 5, "category": "Income",
                "description": "x", "original_text": "x", "added_by": "Asha", "likely": True,
                "entry_type": "Income"}], folder)
            self.assertEqual(db.staged_rows("b1", folder)[0]["entry_type"], "Income")


if __name__ == "__main__":
    unittest.main()

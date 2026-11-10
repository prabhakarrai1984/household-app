import os
import tempfile
import unittest
from datetime import date
from pathlib import Path

from openpyxl import load_workbook

import chat_import
import db
import message_parser
from message_parser import ParseError
from service import describe_change, handle_message

TODAY = date(2026, 11, 10)
ANDROID = (Path(__file__).resolve().parent.parent / "samples" / "family_chat_android.txt").read_text(
    encoding="utf-8")


class ParseEditTests(unittest.TestCase):
    def parse(self, text):
        return message_parser.parse_edit(text, TODAY)

    def test_what_can_be_changed(self):
        self.assertEqual(self.parse("edit 500"), {"amount": 500})
        self.assertEqual(self.parse("edit grocery"), {"category": "Grocery"})
        self.assertEqual(self.parse("edit ₹1,250.50 gift"), {"amount": 1250.5, "category": "Gift"})
        self.assertEqual(self.parse("Edit yesterday"), {"expense_date": date(2026, 11, 9)})
        self.assertEqual(self.parse("edit today 300"), {"amount": 300, "expense_date": TODAY})

    def test_nothing_to_change_is_an_error(self):
        for text in ("edit", "edit please", "edit 0"):
            with self.assertRaises(ParseError, msg=text):
                self.parse(text)


class EntryDbTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.folder = self._tmp.name

    def tearDown(self):
        self._tmp.cleanup()

    def add(self, amount, category="Grocery", description="Milk", who="Asha", when=TODAY, **extra):
        return db.add_expense(amount, category, description, when, who, self.folder, **extra)

    def test_update_changes_fields_and_logs_the_change(self):
        entry_id = self.add(450, description="Vegetables")
        updated = db.update_entry(entry_id, "Asha", self.folder, amount=500, category="Gift",
                                  expense_date=date(2026, 11, 8))
        self.assertEqual((updated["amount"], updated["category"], updated["expense_date"]),
                         (500, "Gift", "2026-11-08"))
        change = db.recent_changes(folder=self.folder)[0]
        self.assertEqual((change["action"], change["changed_by"], change["entry_id"]),
                         ("edit", "Asha", entry_id))
        self.assertEqual(describe_change(change),
                         "Edited Vegetables: amount ₹450.00 → ₹500.00, category Grocery → Gift, "
                         "date 10 Nov 2026 → 08 Nov 2026")

    def test_update_with_the_same_values_changes_and_logs_nothing(self):
        entry_id = self.add(450)
        db.update_entry(entry_id, "Asha", self.folder, amount=450.0)
        self.assertEqual(db.recent_changes(folder=self.folder), [])

    def test_update_rejects_unknown_fields_and_missing_entries(self):
        entry_id = self.add(450)
        with self.assertRaises(ValueError):
            db.update_entry(entry_id, "Asha", self.folder, added_by="Rahul")  # can't pass an entry to someone else
        self.assertIsNone(db.update_entry(999, "Asha", self.folder, amount=5))

    def test_delete_removes_the_entry_and_logs_it(self):
        entry_id = self.add(450, description="Vegetables")
        deleted = db.delete_entry(entry_id, "Web page", self.folder)
        self.assertEqual(deleted["amount"], 450)
        self.assertIsNone(db.get_entry(entry_id, self.folder))
        self.assertEqual(db.total_expenses(self.folder), 0)
        change = db.recent_changes(folder=self.folder)[0]
        self.assertEqual(describe_change(change), "Deleted ₹450.00 under Grocery (Vegetables, 10 Nov 2026)")
        self.assertIsNone(db.delete_entry(entry_id, "Web page", self.folder))  # already gone

    def test_last_entry_is_per_person_by_creation_order_and_skips_imports(self):
        self.add(10, who="Asha")
        self.add(20, who="Rahul")
        newest = self.add(30, who="Asha", when=date(2026, 10, 1))  # an old date, but typed in last
        self.add(40, who="Asha", source_key="imported-1")
        self.assertEqual(db.last_entry_by("asha", self.folder)["id"], newest)
        self.assertIsNone(db.last_entry_by("Karan", self.folder))

    def test_search_matches_text_and_treats_wildcards_literally(self):
        self.add(100, category="Clothes", description="100% cotton shirt")
        self.add(200, description="Milk")
        found = lambda query: [r["description"] for r in db.list_entries(self.folder, text=query)]
        self.assertEqual(found("%"), ["100% cotton shirt"])
        self.assertEqual(found("_"), [])
        self.assertEqual(found("MILK"), ["Milk"])
        self.assertEqual(found("clothes"), ["100% cotton shirt"])
        self.assertEqual(found("asha"), ["Milk", "100% cotton shirt"])


class UndoEditCommandTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.folder = self._tmp.name

    def tearDown(self):
        self._tmp.cleanup()

    def send(self, text, sender="Asha"):
        return handle_message(text, sender, folder=self.folder, today=TODAY)

    def test_us4_undo_removes_only_your_own_last_entry(self):
        self.send("milk 60", sender="Asha")
        self.send("petrol 500", sender="Rahul")
        reply = self.send("undo", sender="Asha")
        self.assertEqual(reply.text, "Removed ₹60.00 under Grocery (Milk, 10 Nov 2026). Total so far: ₹500.00.")
        self.assertEqual([r["added_by"] for r in db.all_expenses(self.folder)], ["Rahul"])
        again = self.send("undo", sender="Asha")
        self.assertFalse(again.ok)
        self.assertEqual(again.text, "You have no entries to undo.")

    def test_repeated_undo_walks_back_one_entry_at_a_time(self):
        self.send("milk 60")
        self.send("petrol 500")
        self.assertIn("Vehicle", self.send("undo").text)
        self.assertIn("Grocery", self.send("undo").text)
        self.assertEqual(db.total_expenses(self.folder), 0)

    def test_undo_never_touches_imported_entries(self):
        db.add_expense(100, "Grocery", "Imported", TODAY, "Asha", self.folder, source_key="k1")
        self.assertFalse(self.send("undo").ok)
        self.assertEqual(len(db.all_expenses(self.folder)), 1)

    def test_undo_updates_the_excel_file(self):
        self.send("milk 60")
        self.send("undo")
        rows = list(load_workbook(Path(self.folder) / "expenses.xlsx")["Expenses"].values)
        self.assertEqual(len(rows), 1)  # just the header row

    def test_undo_of_income_shows_the_month(self):
        self.send("Income 85000 salary")
        reply = self.send("undo")
        self.assertEqual(reply.text, "Removed income of ₹85,000.00 (Salary, 10 Nov 2026). "
                                     "November 2026: income ₹0.00, expenses ₹0.00, balance ₹0.00.")

    def test_edit_amount(self):
        self.send("Spent 450 on vegetables")
        reply = self.send("edit 500")
        self.assertEqual(reply.text,
                         "Updated your last entry (Vegetables): amount ₹450.00 → ₹500.00. Total so far: ₹500.00.")
        self.assertEqual(db.total_expenses(self.folder), 500)

    def test_edit_category_date_and_several_things_at_once(self):
        self.send("Spent 450 on vegetables")
        self.assertIn("category Grocery → Gift", self.send("edit gift").text)
        self.assertIn("date 10 Nov 2026 → 09 Nov 2026", self.send("edit yesterday").text)
        both = self.send("edit 700 travel").text
        self.assertIn("amount ₹450.00 → ₹700.00, category Gift → Travel", both)
        row = db.all_expenses(self.folder)[0]
        self.assertEqual((row["amount"], row["category"], row["expense_date"]), (700, "Travel", "2026-11-09"))

    def test_edit_that_changes_nothing_is_not_logged(self):
        self.send("milk 60")
        reply = self.send("edit 60")
        self.assertTrue(reply.ok)
        self.assertIn("Nothing to change", reply.text)
        self.assertEqual(db.recent_changes(folder=self.folder), [])

    def test_edit_problems_get_helpful_replies(self):
        self.assertEqual(self.send("edit 500").text, "You have no entries to edit.")  # nothing yet
        self.send("milk 60")
        for text, expected in (("edit", "Tell me what to change"), ("edit 0", "more than zero")):
            reply = self.send(text)
            self.assertFalse(reply.ok, msg=text)
            self.assertIn(expected, reply.text)

    def test_income_can_change_amount_but_has_no_category(self):
        self.send("Income 85000 salary")
        reply = self.send("edit 90000")
        self.assertIn("Updated your last entry (Salary): amount ₹85,000.00 → ₹90,000.00. "
                      "November 2026: income ₹90,000.00", reply.text)
        rejected = self.send("edit gift")
        self.assertFalse(rejected.ok)
        self.assertIn("Income entries don't have a category", rejected.text)

    def test_only_listed_family_members_can_undo_or_edit(self):
        db.add_member("Asha", folder=self.folder)
        self.send("milk 60", sender="Asha")
        for text in ("undo", "edit 500"):
            reply = self.send(text, sender="Stranger")
            self.assertFalse(reply.ok)
            self.assertIn("isn't on the family list", reply.text)
        self.assertEqual(db.total_expenses(self.folder), 60)

    def test_edits_and_undos_appear_in_the_change_log(self):
        self.send("milk 60")
        self.send("edit 80")
        self.send("undo")
        lines = [describe_change(c) for c in db.recent_changes(folder=self.folder)]
        self.assertEqual(lines, ["Deleted ₹80.00 under Grocery (Milk, 10 Nov 2026)",
                                 "Edited Milk: amount ₹60.00 → ₹80.00"])


class ImportInteractionTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.folder = self._tmp.name
        for name in ("Asha", "Rahul", "Neha"):
            db.add_member(name, folder=self.folder)
        db.add_member("Meera", phone="98765 43210", folder=self.folder)
        summary = chat_import.stage_import(ANDROID, self.folder)
        rows = db.staged_rows(summary.batch_id, self.folder)
        chat_import.confirm_import(summary.batch_id, {r["id"] for r in rows if r["likely"]}, folder=self.folder)
        self.vegetables = next(e for e in db.all_expenses(self.folder)
                               if e["expense_date"] == "2026-11-05" and e["added_by"] == "Asha")

    def tearDown(self):
        self._tmp.cleanup()

    def restage(self):
        summary = chat_import.stage_import(ANDROID, self.folder)
        return summary, db.staged_rows(summary.batch_id, self.folder)

    def test_a_deleted_imported_entry_is_not_offered_again(self):
        db.delete_entry(self.vegetables["id"], "Web page", self.folder)
        summary, rows = self.restage()
        self.assertEqual(summary.already_imported, 8)          # seven still saved, one deleted
        self.assertEqual([r["added_by"] for r in rows], ["Neha"])  # only the unticked "dinner at 8"

    def test_an_edited_imported_entry_is_still_recognised(self):
        db.update_entry(self.vegetables["id"], "Web page", self.folder, amount=999)
        summary, _ = self.restage()
        self.assertEqual(summary.already_imported, 8)


class EntriesWebTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        os.environ["HOUSEHOLD_DATA_DIR"] = self._tmp.name
        import app as app_module
        self.client = app_module.app.test_client()

    def tearDown(self):
        os.environ.pop("HOUSEHOLD_DATA_DIR", None)
        self._tmp.cleanup()

    def post(self, sender, text):
        self.client.post("/api/message", json={"sender": sender, "text": text})

    def entry(self, description):
        return next(r for r in db.all_expenses() if r["description"] == description)

    def edit(self, entry_id, **fields):
        data = {"expense_date": "2026-11-08", "amount": "450", "category": "Grocery",
                "description": "Vegetables", **fields}
        return self.client.post(f"/entries/{entry_id}/edit", data=data)

    def test_list_search_and_links(self):
        self.post("Asha", "vegetables 450")
        self.post("Rahul", "petrol 2000")
        listing = self.client.get("/entries").get_data(as_text=True)
        self.assertIn("Vegetables", listing)
        self.assertIn("Petrol", listing)
        narrowed = self.client.get("/entries?q=petrol").get_data(as_text=True)
        self.assertIn("Petrol", narrowed)
        self.assertNotIn("Vegetables", narrowed)
        self.assertIn(f"/entries/{self.entry('Vegetables')['id']}/edit", self.client.get("/").get_data(as_text=True))

    def test_edit_form_validation_keeps_the_data_safe(self):
        self.post("Asha", "vegetables 450")
        entry_id = self.entry("Vegetables")["id"]
        self.assertEqual(self.client.get(f"/entries/{entry_id}/edit").status_code, 200)
        for fields, message in (({"amount": "abc"}, "The amount should be a number."),
                                ({"amount": "-5"}, "The amount must be more than zero."),
                                ({"expense_date": "yesterday"}, "The date should look like 2026-11-30."),
                                ({"category": "Holidays"}, "Pick a category from the list."),
                                ({"description": "   "}, "Please enter a description.")):
            response = self.edit(entry_id, **fields)
            self.assertEqual(response.status_code, 400, msg=fields)
            self.assertIn(message, response.get_data(as_text=True))
        self.assertEqual(db.get_entry(entry_id)["amount"], 450)  # nothing was changed

    def test_edit_saves_updates_excel_and_logs(self):
        self.post("Asha", "vegetables 450")
        entry_id = self.entry("Vegetables")["id"]
        done = self.edit(entry_id, amount="1,250.50", category="Gift", description="  Flowers   and card ")
        self.assertEqual(done.status_code, 302)
        row = db.get_entry(entry_id)
        self.assertEqual((row["amount"], row["category"], row["description"], row["expense_date"]),
                         (1250.5, "Gift", "Flowers and card", "2026-11-08"))
        sheet = load_workbook(Path(self._tmp.name) / "expenses.xlsx")["Expenses"]
        self.assertEqual([r[1] for r in sheet.values][1:], [1250.5])
        page = self.client.get("/entries").get_data(as_text=True)
        self.assertIn("Edited Vegetables:", page)
        self.assertIn("₹1,250.50", page)

    def test_income_keeps_its_type_whatever_the_form_says(self):
        self.post("Asha", "Income 85000 salary")
        entry_id = self.entry("Salary")["id"]
        self.assertIn("no category", self.client.get(f"/entries/{entry_id}/edit").get_data(as_text=True))
        self.edit(entry_id, amount="90000", category="Gift", description="Salary")
        row = db.get_entry(entry_id)
        self.assertEqual((row["category"], row["entry_type"], row["amount"]), ("Income", "Income", 90000))

    def test_delete_and_missing_entries(self):
        self.post("Asha", "vegetables 450")
        self.post("Rahul", "petrol 2000")
        entry_id = self.entry("Vegetables")["id"]
        page = self.client.post(f"/entries/{entry_id}/delete", follow_redirects=True).get_data(as_text=True)
        self.assertIn("Entry deleted", page)
        self.assertIn("Deleted ₹450.00 under Grocery (Vegetables", page)
        self.assertEqual(db.total_expenses(), 2000)
        for request in (lambda: self.client.get(f"/entries/{entry_id}/edit", follow_redirects=True),
                        lambda: self.client.post(f"/entries/{entry_id}/delete", follow_redirects=True),
                        lambda: self.edit(entry_id)):
            response = request()
            if response.status_code == 302:
                response = self.client.get("/entries")
            self.assertIn("no longer exists", response.get_data(as_text=True))


if __name__ == "__main__":
    unittest.main()

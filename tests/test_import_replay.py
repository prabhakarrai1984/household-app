import tempfile
import unittest

import chat_import
import db

CHAT = """10/11/26, 9:00 am - Asha: Spent 500 on vegetables
10/11/26, 9:05 am - Asha: undo
10/11/26, 9:10 am - Asha: Spent 700 on medicine
10/11/26, 9:12 am - Asha: edit 750
10/11/26, 9:13 am - Rahul: Gift 1000 birthday
10/11/26, 9:14 am - Rahul: edit 1200 clothes
10/11/26, 9:15 am - Rahul: undo
10/11/26, 9:16 am - Rahul: undo
10/11/26, 9:20 am - Asha: Spent 40 on milk
"""


class ReplayTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        db.add_member("Asha", folder=self.tmp.name)
        db.add_member("Rahul", folder=self.tmp.name)

    def stage(self, text):
        summary = chat_import.stage_import(text, self.tmp.name)
        return summary, db.staged_rows(summary.batch_id, self.tmp.name)

    def test_undo_and_edit_are_replayed_in_order(self):
        summary, rows = self.stage(CHAT)
        got = sorted((r["added_by"], r["amount"], r["category"]) for r in rows)
        self.assertEqual(got, [("Asha", 40, "Grocery"), ("Asha", 750, "Medicine")])
        self.assertEqual((summary.undone, summary.edited), (2, 2))

    def test_undo_with_nothing_before_it_is_harmless(self):
        summary, rows = self.stage("10/11/26, 9:00 am - Asha: undo\n")
        self.assertEqual(rows, [])

    def test_undo_does_not_touch_entries_already_saved(self):
        first = "10/11/26, 9:00 am - Asha: Spent 500 on vegetables\n"
        summary, rows = self.stage(first)
        chat_import.confirm_import(summary.batch_id, {r["id"] for r in rows}, folder=self.tmp.name)
        summary, rows = self.stage(first + "10/11/26, 9:05 am - Asha: undo\n")
        self.assertEqual(rows, [])
        self.assertEqual(db.total_expenses(self.tmp.name), 500)


if __name__ == "__main__":
    unittest.main()

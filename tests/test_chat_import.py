import io
import tempfile
import unittest
import zipfile
from datetime import datetime
from pathlib import Path

import chat_import
import db

SAMPLES = Path(__file__).resolve().parent.parent / "samples"
ANDROID = (SAMPLES / "family_chat_android.txt").read_text(encoding="utf-8")
IPHONE = (SAMPLES / "family_chat_iphone.txt").read_text(encoding="utf-8")


class ParseChatTests(unittest.TestCase):
    def test_android_format_multiline_and_system_notice(self):
        messages = chat_import.parse_chat(ANDROID)
        self.assertEqual(len(messages), 16)  # the encryption notice is not a message
        first = messages[1]
        self.assertEqual((first.sender, first.text), ("Asha", "Spent 450 on vegetables"))
        self.assertEqual(first.when, datetime(2026, 11, 5, 8, 45))
        grocery = next(m for m in messages if m.text.startswith("Bought groceries"))
        self.assertEqual(grocery.text, "Bought groceries,\nmilk, bread, eggs - 340")

    def test_iphone_format_with_seconds_and_brackets(self):
        messages = chat_import.parse_chat(IPHONE)
        self.assertEqual(len(messages), 4)
        self.assertEqual(messages[0].when, datetime(2026, 11, 5, 8, 45, 12))
        self.assertEqual(messages[3].when, datetime(2026, 11, 9, 19, 15, 10))

    def test_month_first_dates_are_detected(self):
        messages = chat_import.parse_chat("11/25/26, 9:00 AM - Asha: petrol 100")
        self.assertEqual(messages[0].when, datetime(2026, 11, 25, 9, 0))
        messages = chat_import.parse_chat("25/11/26, 9:00 AM - Asha: petrol 100")
        self.assertEqual(messages[0].when, datetime(2026, 11, 25, 9, 0))

    def test_noon_and_midnight(self):
        text = "05/11/26, 12:05 am - Asha: milk 60\n05/11/26, 12:30 pm - Asha: milk 60"
        times = [m.when.hour for m in chat_import.parse_chat(text)]
        self.assertEqual(times, [0, 12])

    def test_invisible_characters_from_real_exports(self):
        line = "05/11/26, 8:45 am - Asha: ‎Spent 450 on vegetables"
        message = chat_import.parse_chat(line)[0]
        self.assertEqual((message.sender, message.text), ("Asha", "Spent 450 on vegetables"))
        self.assertEqual(message.when, datetime(2026, 11, 5, 8, 45))

    def test_zip_and_text_uploads(self):
        buffer = io.BytesIO()
        with zipfile.ZipFile(buffer, "w") as archive:
            archive.writestr("_chat.txt", IPHONE)
            archive.writestr("photo.jpg", b"not text")
        self.assertEqual(chat_import.read_export(buffer.getvalue(), "chat.zip"), IPHONE)
        self.assertEqual(chat_import.read_export(IPHONE.encode("utf-8"), "chat.txt"), IPHONE)
        with self.assertRaises(ValueError):
            chat_import.read_export(b"PK" + b"garbage", "broken.zip")


class ImportFlowTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.folder = self._tmp.name
        db.add_member("Asha", folder=self.folder)
        db.add_member("Rahul", folder=self.folder)
        db.add_member("Neha", folder=self.folder)
        db.add_member("Meera", phone="98765 43210", folder=self.folder)  # chat shows her as a number

    def tearDown(self):
        self._tmp.cleanup()

    def stage(self, text):
        summary = chat_import.stage_import(text, self.folder)
        return summary, db.staged_rows(summary.batch_id, self.folder)

    def test_candidates_from_the_android_sample(self):
        summary, rows = self.stage(ANDROID)
        got = [(r["expense_date"], r["added_by"], r["amount"], r["category"], bool(r["likely"]))
               for r in rows]
        self.assertEqual(got, [
            ("2026-11-05", "Asha", 450, "Grocery", True),
            ("2026-11-05", "Rahul", 2000, "Vehicle", True),
            ("2026-11-06", "Asha", 320, "Medicine", True),
            ("2026-11-06", "Neha", 8, "Uncategorized", False),   # "Dinner at 8": offered, not pre-ticked
            ("2026-11-06", "Meera", 1500, "Gift", True),         # matched by phone number
            ("2026-11-07", "Asha", 649, "Entertainment", True),
            ("2026-11-08", "Neha", 25000, "School Fees", True),
            ("2026-11-08", "Asha", 340, "Grocery", True),        # multi-line message
            ("2026-11-10", "Asha", 450, "Grocery", True),
        ])
        self.assertEqual(summary.messages_read, 16)
        self.assertEqual((summary.candidates, summary.likely), (9, 8))
        self.assertEqual(summary.ignored_senders, {"Karan": 1})  # not on the family list

    def test_times_dates_media_and_chatter_are_not_expenses(self):
        _, rows = self.stage(ANDROID)
        texts = " | ".join(r["original_text"] for r in rows)
        for noise in ("Movie at 7 pm", "PTM", "omitted", "deleted", "Good morning", "Great"):
            self.assertNotIn(noise, texts)

    def test_nothing_is_saved_until_confirmed(self):
        self.stage(ANDROID)
        self.assertEqual(db.total_expenses(self.folder), 0)

    def test_confirm_saves_only_ticked_rows_with_category_fix(self):
        summary, rows = self.stage(ANDROID)
        first, dinner = rows[0], rows[3]
        saved, duplicates = chat_import.confirm_import(
            summary.batch_id, {first["id"]}, {first["id"]: "Gift"}, self.folder)
        self.assertEqual((saved, duplicates), (1, 0))
        stored = db.all_expenses(self.folder)
        self.assertEqual(len(stored), 1)
        self.assertEqual((stored[0]["category"], stored[0]["added_by"]), ("Gift", "Asha"))
        self.assertEqual(db.staged_rows(summary.batch_id, self.folder), [])  # batch cleared

    def test_importing_the_same_file_twice_creates_no_duplicates(self):
        summary, rows = self.stage(ANDROID)
        ticked = {r["id"] for r in rows if r["likely"]}
        saved, _ = chat_import.confirm_import(summary.batch_id, ticked, folder=self.folder)
        self.assertEqual(saved, 8)
        self.assertEqual(db.total_expenses(self.folder), 30709)

        again, rows_again = self.stage(ANDROID)
        self.assertEqual(again.already_imported, 8)
        self.assertEqual([r["added_by"] for r in rows_again], ["Neha"])  # only the unticked "dinner" is left

    def test_overlapping_exports_from_android_and_iphone_do_not_double_count(self):
        summary, rows = self.stage(ANDROID)
        chat_import.confirm_import(summary.batch_id, {r["id"] for r in rows if r["likely"]},
                                   folder=self.folder)
        second, new_rows = self.stage(IPHONE)
        self.assertEqual(second.already_imported, 3)   # the same three messages, seen again
        self.assertEqual([(r["added_by"], r["amount"]) for r in new_rows], [("Rahul", 120)])

    def test_two_identical_messages_in_the_same_minute_are_both_kept(self):
        text = "05/11/26, 8:45 am - Asha: milk 60\n05/11/26, 8:45 am - Asha: milk 60"
        summary, rows = self.stage(text)
        self.assertEqual(len(rows), 2)
        saved, _ = chat_import.confirm_import(summary.batch_id, {r["id"] for r in rows},
                                              folder=self.folder)
        self.assertEqual(saved, 2)
        again, rows_again = self.stage(text)
        self.assertEqual((again.already_imported, len(rows_again)), (2, 0))

    def test_income_in_a_chat_is_imported_as_income(self):
        text = ("05/11/26, 9:00 am - Asha: Income 85000 salary\n"
                "05/11/26, 9:05 am - Asha: milk 60")
        summary, rows = self.stage(text)
        income = rows[0]
        self.assertEqual((income["entry_type"], income["category"], income["amount"], income["description"],
                          bool(income["likely"])), ("Income", "Income", 85000, "Salary", True))
        # even if someone picks a category for it on the review page, income stays income
        saved, _ = chat_import.confirm_import(summary.batch_id, {r["id"] for r in rows},
                                              {income["id"]: "Gift"}, self.folder)
        self.assertEqual(saved, 2)
        self.assertEqual((db.total_income(self.folder), db.total_expenses(self.folder)), (85000, 60))
        self.assertEqual({r["category"] for r in db.all_expenses(self.folder)}, {"Income", "Grocery"})

    def test_paused_member_is_ignored(self):
        asha = next(m for m in db.list_members(self.folder) if m["name"] == "Asha")
        db.set_member_active(asha["id"], False, self.folder)
        summary, rows = self.stage(ANDROID)
        self.assertNotIn("Asha", {r["added_by"] for r in rows})
        self.assertEqual(summary.ignored_senders["Asha"], 5)  # her five expense-like messages


if __name__ == "__main__":
    unittest.main()

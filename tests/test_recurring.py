import tempfile
import unittest
from datetime import date
from pathlib import Path

import chat_import
import db
import recurring
import service
from message_parser import ParseError

TODAY = date(2026, 11, 10)
HINGLISH = (Path(__file__).resolve().parent.parent / "samples" / "family_chat_hinglish.txt").read_text(encoding="utf-8")


class DateRuleTests(unittest.TestCase):
    def test_month_end_keeps_original_day(self):
        feb = recurring.next_due_after(date(2026, 1, 31), "monthly", 31)
        self.assertEqual(feb, date(2026, 2, 28))
        self.assertEqual(recurring.next_due_after(feb, "monthly", 31), date(2026, 3, 31))

    def test_leap_year_february(self):
        self.assertEqual(recurring.next_due_after(date(2028, 1, 30), "monthly", 30), date(2028, 2, 29))

    def test_quarterly_and_yearly_cross_year(self):
        self.assertEqual(recurring.next_due_after(date(2026, 11, 15), "quarterly", 15), date(2027, 2, 15))
        self.assertEqual(recurring.next_due_after(date(2026, 3, 5), "yearly", 5), date(2027, 3, 5))

    def test_first_due(self):
        self.assertEqual(recurring.first_due("monthly", 10, TODAY), TODAY)
        self.assertEqual(recurring.first_due("monthly", 5, TODAY), date(2026, 12, 5))
        self.assertEqual(recurring.first_due("yearly", 5, TODAY, 3), date(2027, 3, 5))


class CommandTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)

    def send(self, text, who="Asha"):
        return service.handle_message(text, who, self.tmp.name, TODAY)

    def test_add_due_paid_cycle(self):
        self.assertIn("Next due 2026-11-12", self.send("recurring rent 25000 monthly on 12").text)
        self.assertIn("Rent is due 12 Nov (in 2 days)", self.send("due").text)
        reply = self.send("paid rent")
        self.assertIn("Next due 2026-12-12", reply.text)
        self.assertIn("Rent 25000", reply.text)
        self.assertEqual(db.total_expenses(self.tmp.name), 25000)
        self.assertEqual(self.send("due").text, "Nothing is due soon.")

    def test_overdue_stays_until_paid(self):
        self.send("recurring rent 25000 monthly on 3")  # first due is 3 Dec
        db.set_recurring_next_due(1, date(2026, 11, 3), self.tmp.name)
        self.assertIn("7 days ago", self.send("due").text)

    def test_needs_frequency(self):
        reply = self.send("recurring rent 25000")
        self.assertFalse(reply.ok)

    def test_remove_and_unknown_name(self):
        self.send("recurring rent 25000 monthly on 12")
        self.assertFalse(self.send("recurring remove school").ok)
        self.assertIn("Stopped", self.send("recurring remove rent").text)
        self.assertEqual(db.list_recurring(self.tmp.name), [])

    def test_paid_with_amount_is_a_normal_expense(self):
        self.send("recurring rent 25000 monthly on 12")
        self.assertIn("Recorded ₹300", self.send("paid 300 for tea").text)

    def test_parse_options(self):
        item = recurring.parse_recurring("recurring LIC 24000 yearly on 5 march remind 7", TODAY)
        self.assertEqual((item["frequency"], item["due_day"], item["month"], item["remind_days"]),
                         ("yearly", 5, 3, 7))
        with self.assertRaises(ParseError):
            recurring.parse_recurring("recurring rent 5000 monthly on 40", TODAY)

    def test_paid_text_is_read_back_by_the_importer(self):
        self.send("recurring school fees 12000 quarterly on 12")
        row = db.list_recurring(self.tmp.name)[0]
        line = f"10/11/26, 9:00 am - Asha: {recurring.paid_share_text(row)}\n"
        db.add_member("Asha", folder=self.tmp.name)
        summary = chat_import.stage_import(line, self.tmp.name)
        staged = db.staged_rows(summary.batch_id, self.tmp.name)
        self.assertEqual((staged[0]["amount"], staged[0]["category"]), (12000, "School Fees"))


class HinglishChatTests(unittest.TestCase):
    def test_real_world_style_export(self):
        with tempfile.TemporaryDirectory() as folder:
            db.add_member("Asha", folder=folder)
            db.add_member("Rahul", folder=folder)
            summary = chat_import.stage_import(HINGLISH, folder)
            rows = {r["description"]: r for r in db.staged_rows(summary.batch_id, folder)}
            self.assertEqual(summary.messages_read, 8)
            self.assertEqual(rows["Dhaniya and mirchi"]["category"], "Grocery")
            self.assertEqual(rows["D mart(sweets,oil,soap,milk,honey)"]["amount"], 2850)
            self.assertEqual(rows["Tyre change"]["category"], "Vehicle")
            self.assertEqual(rows["Didi for gift bhaiya Dooj"]["category"], "Gift")
            self.assertEqual(rows["Movie"]["amount"], 9000)  # edited from 900
            self.assertNotIn("Iron", rows)                  # undone


if __name__ == "__main__":
    unittest.main()

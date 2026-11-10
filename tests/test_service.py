import io
import os
import tempfile
import unittest
from datetime import date
from pathlib import Path

from openpyxl import load_workbook

import db
from service import handle_message, inr

TODAY = date(2026, 11, 10)


class ServiceTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.folder = self._tmp.name

    def tearDown(self):
        self._tmp.cleanup()

    def send(self, text, sender="Asha"):
        return handle_message(text, sender, folder=self.folder, today=TODAY)

    def test_us1_records_and_confirms(self):
        reply = self.send("Spent 450 on vegetables")
        self.assertTrue(reply.ok)
        self.assertIn("Recorded ₹450.00 under Grocery", reply.text)

    def test_us3_bad_message_saves_nothing(self):
        reply = self.send("hello there")
        self.assertFalse(reply.ok)
        self.assertIn("amount", reply.text)
        self.assertEqual(db.total_expenses(self.folder), 0)

    def test_us5_sender_is_stored(self):
        self.send("petrol 2000", sender="Rahul")
        self.send("milk 60", sender="Asha")
        senders = sorted(row["added_by"] for row in db.all_expenses(self.folder))
        self.assertEqual(senders, ["Asha", "Rahul"])

    def test_us16_total_is_always_available(self):
        self.send("Spent 450 on vegetables")
        self.send("petrol 2000", sender="Rahul")
        self.assertEqual(db.total_expenses(self.folder), 2450)
        self.assertIn("₹2,450.00", self.send("total").text)

    def test_category_totals(self):
        self.send("milk 60")
        self.send("vegetables 140")
        self.send("petrol 500")
        totals = {row["category"]: row["total"] for row in db.totals_by_category(self.folder)}
        self.assertEqual(totals, {"Grocery": 200, "Vehicle": 500})

    def test_us23_excel_file_has_the_records(self):
        self.send("Spent 450 on vegetables", sender="Asha")
        self.send("Medicine 320 yesterday", sender="Rahul")
        workbook = load_workbook(os.path.join(self.folder, "expenses.xlsx"))
        rows = list(workbook["Expenses"].values)
        self.assertEqual(rows[0][:6], ("Date", "Amount", "Category", "Description", "Added by", "Type"))
        self.assertEqual(len(rows), 3)
        by_person = {row[4]: row for row in rows[1:]}
        self.assertEqual(by_person["Asha"][1], 450)
        self.assertEqual(by_person["Asha"][2], "Grocery")
        self.assertEqual(by_person["Rahul"][0].date(), date(2026, 11, 9))

    def test_us26_only_listed_members_can_post(self):
        self.assertTrue(self.send("milk 60", sender="Anyone").ok)  # no list yet: everyone is accepted
        db.add_member("Asha", chat_name="Mom", folder=self.folder)
        rejected = self.send("milk 60", sender="Stranger")
        self.assertFalse(rejected.ok)
        self.assertIn("isn't on the family list", rejected.text)
        self.assertTrue(self.send("milk 60", sender="mom").ok)    # matched by WhatsApp name
        self.assertEqual(db.all_expenses(self.folder)[-1]["added_by"], "Asha")  # stored under the app name
        self.assertEqual(len(db.all_expenses(self.folder)), 2)    # the stranger's was not saved

    def test_paused_member_cannot_post(self):
        member_id = db.add_member("Asha", folder=self.folder)
        db.set_member_active(member_id, False, self.folder)
        self.assertFalse(self.send("milk 60", sender="Asha").ok)

    def test_us14_income_is_recorded_as_income_not_expense(self):
        reply = self.send("Income 85000 salary")
        self.assertIn("Recorded income of ₹85,000.00 (Salary)", reply.text)
        self.assertIn("November 2026: income ₹85,000.00, expenses ₹0.00, balance ₹85,000.00", reply.text)
        self.assertEqual(db.total_expenses(self.folder), 0)
        self.assertEqual(db.total_income(self.folder), 85000)
        row = db.all_expenses(self.folder)[0]
        self.assertEqual((row["entry_type"], row["category"], row["description"]),
                         ("Income", "Income", "Salary"))

    def test_income_tax_is_an_expense(self):
        self.assertIn("Recorded ₹5,000.00 under Uncategorized", self.send("Income tax 5000").text)

    def test_us17_month_command(self):
        self.send("Income 85000 salary")
        self.send("vegetables 1000")
        self.send("petrol 500")
        self.assertIn("November 2026: income ₹85,000.00, expenses ₹1,500.00, balance ₹83,500.00",
                      self.send("month").text)

    def test_us22_report_commands(self):
        self.send("Income 85000 salary")
        self.send("vegetables 1000")
        self.send("petrol 500")
        everything = self.send("report").text
        self.assertIn("November 2026: income ₹85,000.00, expenses ₹1,500.00", everything)
        self.assertIn("• Grocery: ₹1,000.00 (67%)", everything)
        self.assertIn("• Vehicle: ₹500.00 (33%)", everything)
        self.assertIn("Grocery · November 2026: ₹1,000.00 across 1 entry.", self.send("report grocery").text)
        self.assertIn("Grocery · October 2026: ₹0.00 across 0 entries.",
                      self.send("report grocery october").text)

    def test_report_followed_by_an_amount_is_an_expense(self):
        self.assertIn("Recorded ₹200.00", self.send("report card fees 200").text)

    def test_help_command(self):
        self.assertIn("Categories", self.send("help").text)

    def test_indian_number_format(self):
        self.assertEqual(inr(450), "₹450.00")
        self.assertEqual(inr(1250.5), "₹1,250.50")
        self.assertEqual(inr(1234567.5), "₹12,34,567.50")


class WebTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        os.environ["HOUSEHOLD_DATA_DIR"] = self._tmp.name
        import app as app_module
        self.client = app_module.app.test_client()

    def tearDown(self):
        os.environ.pop("HOUSEHOLD_DATA_DIR", None)
        self._tmp.cleanup()

    def test_page_form_api_and_download(self):
        self.assertEqual(self.client.get("/").status_code, 200)

        page = self.client.post("/message", data={"sender": "Asha", "text": "milk 60"},
                                follow_redirects=True)
        self.assertIn("Recorded ₹60.00 under Grocery", page.get_data(as_text=True))

        api = self.client.post("/api/message", json={"sender": "Rahul", "text": "petrol 500"})
        self.assertTrue(api.get_json()["ok"])

        self.assertIn("₹560.00", self.client.get("/").get_data(as_text=True))

        download = self.client.get("/export")
        self.assertEqual(download.status_code, 200)
        self.assertEqual(download.data[:2], b"PK")  # .xlsx files are zip files
        download.close()

    def test_reports_page_overview_and_filtered_excel(self):
        for sender, text in (("Asha", "Income 85000 salary"), ("Asha", "vegetables 1000"),
                             ("Rahul", "petrol 500")):
            self.client.post("/api/message", json={"sender": sender, "text": text})

        self.assertIn("₹85,000.00", self.client.get("/").get_data(as_text=True))  # month overview

        page = self.client.get("/reports").get_data(as_text=True)
        for expected in ("Grocery", "66.7%", "Salary", "Rahul"):
            self.assertIn(expected, page)

        grocery = self.client.get("/reports?category=Grocery&period=all").get_data(as_text=True)
        self.assertIn("₹1,000.00", grocery)
        self.assertNotIn("Petrol", grocery)

        backwards = self.client.get("/reports?period=custom&start=2026-11-10&end=2026-11-01")
        self.assertIn("start date is after the end date", backwards.get_data(as_text=True))

        download = self.client.get("/reports/export?category=Grocery&period=all")
        self.assertEqual((download.status_code, download.data[:2]), (200, b"PK"))
        summary = {row[0]: row[1] for row in load_workbook(io.BytesIO(download.data))["Summary"].values if row[0]}
        self.assertEqual(summary["Total expenses"], 1000)
        self.assertNotIn("Total income", summary)
        download.close()

        self.assertEqual(self.client.get("/reports/export?period=custom").status_code, 400)

    def test_family_and_import_pages_end_to_end(self):
        import re
        sample = (Path(__file__).resolve().parent.parent / "samples" / "family_chat_android.txt").read_bytes()

        # importing before anyone is on the list sends you to the Family page
        blocked = self.client.post("/import", data={"chat_file": (io.BytesIO(sample), "chat.txt")},
                                   content_type="multipart/form-data", follow_redirects=True)
        self.assertIn("Add your family members first", blocked.get_data(as_text=True))

        for name, extra in (("Asha", {}), ("Rahul", {}), ("Neha", {}),
                            ("Meera", {"phone": "98765 43210"})):
            self.client.post("/members/add", data={"name": name, **extra})
        self.assertIn("Meera", self.client.get("/members").get_data(as_text=True))
        dup = self.client.post("/members/add", data={"name": "asha"}, follow_redirects=True)
        self.assertIn("already on the list", dup.get_data(as_text=True))

        review = self.client.post("/import", data={"chat_file": (io.BytesIO(sample), "chat.txt")},
                                  content_type="multipart/form-data")
        page = review.get_data(as_text=True)
        self.assertEqual(review.status_code, 200)
        self.assertIn("Karan (1)", page)                  # outsider is reported, not imported
        self.assertEqual(db.total_expenses(), 0)          # still nothing saved
        batch = re.search(r'name="batch_id" value="([0-9a-f]+)"', page).group(1)
        ticked = re.findall(r'name="selected" value="(\d+)" checked', page)
        self.assertEqual(len(ticked), 8)

        done = self.client.post("/import/confirm", data={"batch_id": batch, "selected": ticked},
                                follow_redirects=True)
        self.assertIn("Imported 8 expenses", done.get_data(as_text=True))
        self.assertEqual(db.total_expenses(), 30709)

        again = self.client.post("/import", data={"chat_file": (io.BytesIO(sample), "chat.txt")},
                                 content_type="multipart/form-data")
        self.assertIn("8", again.get_data(as_text=True))  # "8 already saved earlier"
        self.assertEqual(db.total_expenses(), 30709)


if __name__ == "__main__":
    unittest.main()

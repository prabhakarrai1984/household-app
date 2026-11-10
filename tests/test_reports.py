import io
import tempfile
import unittest
from datetime import date

from openpyxl import load_workbook

import db
import export
import reports

TODAY = date(2026, 11, 10)  # a Tuesday


class PeriodTests(unittest.TestCase):
    def test_presets(self):
        resolve = lambda period: reports.resolve_period(period, today=TODAY)
        self.assertEqual(resolve("month"), (date(2026, 11, 1), date(2026, 11, 30), "November 2026"))
        self.assertEqual(resolve("last_month"), (date(2026, 10, 1), date(2026, 10, 31), "October 2026"))
        self.assertEqual(resolve("week")[:2], (date(2026, 11, 9), date(2026, 11, 15)))  # Monday to Sunday
        self.assertEqual(resolve("today")[:2], (TODAY, TODAY))
        self.assertEqual(resolve("year")[:2], (date(2026, 1, 1), date(2026, 12, 31)))
        self.assertEqual(resolve("all"), (None, None, "All time"))

    def test_last_month_across_new_year(self):
        self.assertEqual(reports.resolve_period("last_month", today=date(2026, 1, 15)),
                         (date(2025, 12, 1), date(2025, 12, 31), "December 2025"))

    def test_custom_ranges_and_labels(self):
        custom = lambda start, end: reports.resolve_period("custom", start, end, TODAY)
        self.assertEqual(custom("2026-10-01", "2026-10-31")[2], "October 2026")  # a whole month
        self.assertEqual(custom("2026-10-05", "2026-10-20")[2], "05 Oct 2026 to 20 Oct 2026")
        self.assertEqual(custom("2026-10-05", "")[2], "From 05 Oct 2026")
        self.assertEqual(custom("", "2026-10-20")[2], "Up to 20 Oct 2026")

    def test_bad_custom_input_gives_friendly_errors(self):
        for args in (("custom", "", ""), ("custom", "2026-11-10", "2026-11-01"),
                     ("custom", "10/11/2026", ""), ("nonsense", "", "")):
            with self.assertRaises(ValueError, msg=args):
                reports.resolve_period(*args, today=TODAY)


class _WithData(unittest.TestCase):
    """Six entries: two income and three expenses in November, one expense in October."""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.folder = self._tmp.name
        add = lambda amount, category, description, when, who, kind="Expense": db.add_expense(
            amount, category, description, when, who, self.folder, entry_type=kind)
        add(85000, "Income", "Salary", date(2026, 11, 1), "Asha", "Income")
        add(5000, "Income", "Rent received", date(2026, 11, 5), "Rahul", "Income")
        add(1000, "Grocery", "Vegetables", date(2026, 11, 3), "Asha")
        add(3000, "Grocery", "Monthly stock", date(2026, 11, 9), "Rahul")
        add(2000, "Vehicle", "Petrol", date(2026, 11, 9), "Rahul")
        add(4000, "Gift", "Birthday", date(2026, 10, 20), "Asha")

    def tearDown(self):
        self._tmp.cleanup()

    def report(self, **filters):
        return reports.build_report(self.folder, today=TODAY, **filters)


class ReportTests(_WithData):
    def test_this_month(self):
        report = self.report()
        self.assertEqual((report.income, report.expenses, report.balance), (90000, 6000, 84000))
        self.assertEqual(report.expense_count, 3)
        self.assertEqual(len(report.entries), 5)
        self.assertEqual([(r["category"], r["total"], r["percent"]) for r in report.by_category],
                         [("Grocery", 4000, 66.7), ("Vehicle", 2000, 33.3)])
        self.assertEqual([(r["person"], r["total"]) for r in report.by_person],
                         [("Rahul", 5000), ("Asha", 1000)])
        self.assertEqual([(r["source"], r["total"]) for r in report.income_sources],
                         [("Salary", 85000), ("Rent received", 5000)])

    def test_last_month(self):
        report = self.report(period="last_month")
        self.assertEqual((report.income, report.expenses, report.balance), (0, 4000, -4000))

    def test_category_filter_hides_income_and_balance(self):
        report = self.report(period="all", category="Grocery")
        self.assertEqual((report.expenses, report.expense_count, len(report.entries)), (4000, 2, 2))
        self.assertFalse(report.show_balance)

    def test_person_filter_ignores_capitalisation(self):
        report = self.report(person="rahul")
        self.assertEqual((report.expenses, report.income), (5000, 5000))
        self.assertEqual([r["category"] for r in report.by_category], ["Grocery", "Vehicle"])

    def test_type_filter(self):
        report = self.report(entry_type="Income")
        self.assertEqual([r["entry_type"] for r in report.entries], ["Income", "Income"])

    def test_custom_range_includes_both_end_dates(self):
        report = self.report(period="custom", start="2026-11-05", end="2026-11-09")
        self.assertEqual((report.income, report.expenses), (5000, 5000))  # rent on the 5th, spending on the 9th

    def test_unknown_category_is_rejected(self):
        with self.assertRaises(ValueError):
            self.report(category="Holidays")

    def test_month_overview(self):
        november = reports.month_overview(self.folder, on=TODAY)
        self.assertEqual((november.label, november.income, november.expenses, november.balance),
                         ("November 2026", 90000, 6000, 84000))
        october = reports.month_overview(self.folder, on=date(2026, 10, 15))
        self.assertEqual((october.income, october.expenses, october.balance), (0, 4000, -4000))

    def test_expense_totals_never_include_income(self):
        self.assertEqual(db.total_expenses(self.folder), 10000)
        self.assertEqual(db.total_income(self.folder), 90000)


class ExcelReportTests(_WithData):
    def load(self, **filters):
        data = export.report_workbook_bytes(self.report(**filters))
        return load_workbook(io.BytesIO(data))

    def test_summary_and_entries_sheets(self):
        workbook = self.load()
        self.assertEqual(workbook.sheetnames, ["Summary", "Entries"])
        summary = {row[0]: row[1] for row in workbook["Summary"].values if row[0]}
        self.assertEqual(summary["Period"], "November 2026")
        self.assertEqual((summary["Total income"], summary["Total expenses"], summary["Balance"]),
                         (90000, 6000, 84000))
        rows = list(workbook["Entries"].values)
        self.assertEqual(len(rows), 1 + 5)
        dates = [r[0].date() for r in rows[1:]]
        self.assertEqual(dates, sorted(dates))  # oldest first in the spreadsheet
        self.assertEqual({r[5] for r in rows[1:]}, {"Expense", "Income"})

    def test_category_filtered_report_has_no_income_lines(self):
        workbook = self.load(period="all", category="Grocery")
        summary = {row[0]: row[1] for row in workbook["Summary"].values if row[0]}
        self.assertEqual(summary["Total expenses"], 4000)
        self.assertNotIn("Total income", summary)
        self.assertEqual(len(list(workbook["Entries"].values)), 1 + 2)


class ReportCommandTests(unittest.TestCase):
    def command(self, text):
        return reports.parse_report_command(text, TODAY)

    def test_month_name_and_category(self):
        self.assertEqual(self.command("report grocery october"),
                         {"period": "custom", "start": "2026-10-01", "end": "2026-10-31", "category": "Grocery"})

    def test_defaults_to_this_month_all_categories(self):
        self.assertEqual(self.command("report"),
                         {"period": "month", "start": "", "end": "", "category": ""})

    def test_named_periods(self):
        self.assertEqual(self.command("report last month")["period"], "last_month")
        self.assertEqual(self.command("report today")["period"], "today")
        self.assertEqual(self.command("report this week")["period"], "week")
        self.assertEqual(self.command("report all")["period"], "all")
        year = self.command("report travel this year")
        self.assertEqual((year["period"], year["category"]), ("year", "Travel"))

    def test_a_month_that_has_not_happened_yet_means_last_year(self):
        december = self.command("report december")
        self.assertEqual((december["start"], december["end"]), ("2025-12-01", "2025-12-31"))

    def test_explicit_year(self):
        march = self.command("report gift march 2025")
        self.assertEqual((march["start"], march["end"], march["category"]),
                         ("2025-03-01", "2025-03-31", "Gift"))


if __name__ == "__main__":
    unittest.main()

"""Excel output: the always-current data/expenses.xlsx, and downloadable filtered reports."""
import io
import os
from datetime import date, datetime

from openpyxl import Workbook
from openpyxl.styles import Alignment, Font, PatternFill

import db

HEADERS = ["Date", "Amount", "Category", "Description", "Added by", "Type", "Created time"]
WIDTHS = [14, 14, 16, 36, 16, 10, 20]
HEADER_FILL = PatternFill("solid", fgColor="0F766E")
TYPE_LABELS = {"": "Everything", "Expense": "Expenses only", "Income": "Income only"}


def _style_header(cells):
    for cell in cells:
        cell.font = Font(bold=True, color="FFFFFF")
        cell.fill = HEADER_FILL
        cell.alignment = Alignment(horizontal="center")


def _fill_entries_sheet(ws, rows):
    ws.append(HEADERS)
    _style_header(ws[1])
    for row in rows:
        ws.append([
            date.fromisoformat(row["expense_date"]),
            row["amount"],
            row["category"],
            row["description"],
            row["added_by"],
            row["entry_type"],
            datetime.fromisoformat(row["created_at"]),
        ])
    for number, width in enumerate(WIDTHS, start=1):
        ws.column_dimensions[ws.cell(row=1, column=number).column_letter].width = width
    for line in ws.iter_rows(min_row=2):
        line[0].number_format = "dd-mmm-yyyy"
        line[1].number_format = "#,##0.00"
        line[6].number_format = "dd-mmm-yyyy hh:mm"
    ws.freeze_panes = "A2"
    ws.auto_filter.ref = ws.dimensions


def write_workbook(rows, path):
    wb = Workbook()
    ws = wb.active
    ws.title = "Expenses"
    _fill_entries_sheet(ws, rows)

    # Save to a temporary file first so a crash can never leave a half-written Excel file.
    temp_path = path.with_name("expenses.tmp.xlsx")
    wb.save(temp_path)
    os.replace(temp_path, path)


def refresh_excel(folder=None):
    """Rebuild data/expenses.xlsx from the database. Returns the path, or None on failure
    (for example on Windows when the file is open in Excel). The database is never affected."""
    path = db.data_dir(folder) / "expenses.xlsx"
    try:
        write_workbook(db.all_expenses(folder), path)
        return path
    except OSError:
        return None


# ---------------------------------------------------------- filtered report

def _table(ws, first_header, rows, name_key, with_percent=True):
    header = [first_header, "Entries", "Total"] + (["% of expenses"] if with_percent else [])
    ws.append(header)
    _style_header(ws[ws.max_row])
    for row in rows:
        line = [row[name_key], row["entries"], row["total"]]
        if with_percent:
            line.append(row["percent"])
        ws.append(line)
    ws.append([])


def report_workbook_bytes(report):
    """An .xlsx with a Summary sheet (totals, by category, by person) and the matching entries."""
    wb = Workbook()
    summary = wb.active
    summary.title = "Summary"
    summary.append(["Household report"])
    summary["A1"].font = Font(bold=True, size=14)
    summary.append(["Period", report.label])
    summary.append(["Category", report.category or "All"])
    summary.append(["Person", report.person or "Everyone"])
    summary.append(["Showing", TYPE_LABELS.get(report.entry_type, "Everything")])
    summary.append([])
    if report.show_balance:
        summary.append(["Total income", report.income])
    summary.append(["Total expenses", report.expenses])
    if report.show_balance:
        summary.append(["Balance", report.balance])
    summary.append([])
    if report.by_category:
        _table(summary, "Category", report.by_category, "category")
    if report.by_person:
        _table(summary, "Person", report.by_person, "person")
    if report.income_sources and report.show_balance:
        _table(summary, "Income source", report.income_sources, "source", with_percent=False)

    for column, width in zip("ABCD", (26, 18, 16, 16)):
        summary.column_dimensions[column].width = width
    for line in summary.iter_rows():
        for cell in line:
            if isinstance(cell.value, float):
                cell.number_format = "#,##0.00"

    entries = wb.create_sheet("Entries")
    _fill_entries_sheet(entries, sorted(report.entries, key=lambda r: (r["expense_date"], r["id"])))

    buffer = io.BytesIO()
    wb.save(buffer)
    return buffer.getvalue()

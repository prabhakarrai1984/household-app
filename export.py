"""Write all records to an Excel file that can be opened outside the app."""
import os
from datetime import date, datetime

from openpyxl import Workbook
from openpyxl.styles import Alignment, Font, PatternFill

import db

HEADERS = ["Date", "Amount", "Category", "Description", "Added by", "Type", "Created time"]
WIDTHS = [14, 14, 16, 36, 16, 10, 20]


def write_workbook(rows, path):
    wb = Workbook()
    ws = wb.active
    ws.title = "Expenses"
    ws.append(HEADERS)
    for cell in ws[1]:
        cell.font = Font(bold=True, color="FFFFFF")
        cell.fill = PatternFill("solid", fgColor="0F766E")
        cell.alignment = Alignment(horizontal="center")

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

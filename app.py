import io
import os
from datetime import date, datetime

from flask import Flask, flash, jsonify, redirect, render_template, request, send_file, url_for

import chat_import
import db
import export
import recurring
import reports
from message_parser import CATEGORIES, INCOME, UNCATEGORIZED
from service import describe_change, handle_message, inr

WEB_USER = "Web page"  # there are no logins yet, so changes made on the web are logged under this name

app = Flask(__name__)
app.secret_key = os.environ.get("SECRET_KEY", "dev-only-change-me")
app.config["MAX_CONTENT_LENGTH"] = 25 * 1024 * 1024  # refuse uploads above 25 MB
app.add_template_filter(inr, "inr")
app.add_template_filter(describe_change, "describe_change")


@app.template_filter("nicedate")
def nicedate(value):
    return date.fromisoformat(value).strftime("%d %b %Y")


@app.template_filter("nicetime")
def nicetime(value):
    return datetime.fromisoformat(value).strftime("%d %b, %I:%M %p")


@app.errorhandler(413)
def too_large(_error):
    return "That file is too large (limit 25 MB). Export the chat 'Without media'.", 413


# ------------------------------------------------------------------ home

@app.get("/")
def home():
    return render_template(
        "index.html",
        total=db.total_expenses(),
        overview=reports.month_overview(),
        by_category=db.totals_by_category(),
        recent=db.recent(20),
        due=recurring.due_soon(),
        sender=request.args.get("sender", ""),
    )


@app.post("/message")
def post_message():
    """The web form: type a message exactly as you would in the family chat."""
    sender = request.form.get("sender", "").strip()
    reply = handle_message(request.form.get("text", ""), sender)
    flash(reply.text, "ok" if reply.ok else "error")
    return redirect(url_for("home", sender=sender))


@app.post("/api/message")
def api_message():
    """Same logic as the form, as JSON. A WhatsApp or Telegram connection can plug in here later."""
    data = request.get_json(silent=True) or {}
    reply = handle_message(data.get("text", ""), data.get("sender", ""))
    return jsonify(reply=reply.text, ok=reply.ok)


@app.get("/export")
def export_excel():
    path = export.refresh_excel()
    if path is None:
        return "Could not create the Excel file. If it is open in Excel, close it and retry.", 500
    return send_file(path, as_attachment=True, download_name="household_expenses.xlsx")


# --------------------------------------------------------------- reports

def _report_from_request():
    args = request.args
    return reports.build_report(
        period=args.get("period", "month"), start=args.get("start", ""), end=args.get("end", ""),
        category=args.get("category", ""), person=args.get("person", ""),
        entry_type=args.get("type", ""))


@app.get("/reports")
def reports_page():
    try:
        report = _report_from_request()
    except ValueError as problem:
        flash(str(problem), "error")
        report = reports.build_report()  # fall back to this month so the page still works
    return render_template(
        "reports.html",
        report=report,
        form=request.args,
        periods=reports.PERIODS,
        types=reports.TYPES,
        categories=CATEGORIES + [UNCATEGORIZED, INCOME],
        people=db.people(),
        shown_limit=200,
    )


@app.get("/reports/export")
def reports_export():
    try:
        report = _report_from_request()
    except ValueError as problem:
        return str(problem), 400
    return send_file(
        io.BytesIO(export.report_workbook_bytes(report)), as_attachment=True,
        download_name="household_report.xlsx",
        mimetype="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")


# --------------------------------------------------- entries: edit, delete

def _entry_from_form(entry):
    """Check what was typed on the edit form. Raises ValueError with a friendly message."""
    form = request.form
    try:
        when = date.fromisoformat(form.get("expense_date", "").strip())
    except ValueError:
        raise ValueError("The date should look like 2026-11-30.") from None
    try:
        amount = float(form.get("amount", "").replace(",", "").strip())
    except ValueError:
        raise ValueError("The amount should be a number.") from None
    if not 0 < amount < 1_000_000_000:
        raise ValueError("The amount must be more than zero.")
    description = " ".join(form.get("description", "").split())[:200]
    if not description:
        raise ValueError("Please enter a description.")
    if entry["entry_type"] == "Income":
        category = INCOME  # income has no categories
    else:
        category = form.get("category", "")
        if category not in CATEGORIES + [UNCATEGORIZED]:
            raise ValueError("Pick a category from the list.")
    return {"expense_date": when, "amount": amount, "category": category, "description": description}


@app.get("/entries")
def entries_page():
    query = request.args.get("q", "").strip()
    rows = db.list_entries(limit=101, text=query or None)
    return render_template("entries.html", rows=rows[:100], more=len(rows) > 100, q=query,
                           changes=db.recent_changes(10))


@app.get("/entries/<int:entry_id>/edit")
def entry_edit_page(entry_id):
    entry = db.get_entry(entry_id)
    if entry is None:
        flash("That entry no longer exists.", "error")
        return redirect(url_for("entries_page"))
    return render_template("entry_edit.html", entry=entry, form={}, categories=CATEGORIES + [UNCATEGORIZED])


@app.post("/entries/<int:entry_id>/edit")
def entry_edit_save(entry_id):
    entry = db.get_entry(entry_id)
    if entry is None:
        flash("That entry no longer exists.", "error")
        return redirect(url_for("entries_page"))
    try:
        changes = _entry_from_form(entry)
    except ValueError as problem:
        flash(str(problem), "error")  # show the form again with what was typed
        return render_template("entry_edit.html", entry=entry, form=request.form,
                               categories=CATEGORIES + [UNCATEGORIZED]), 400
    db.update_entry(entry_id, WEB_USER, **changes)
    export.refresh_excel()
    flash("Entry updated.", "ok")
    return redirect(url_for("entries_page"))


@app.post("/entries/<int:entry_id>/delete")
def entry_delete(entry_id):
    if db.delete_entry(entry_id, WEB_USER) is None:
        flash("That entry no longer exists.", "error")
    else:
        export.refresh_excel()
        flash("Entry deleted. It is listed under Recent changes below.", "ok")
    return redirect(url_for("entries_page"))


# ------------------------------------------------------- family members

@app.get("/members")
def members_page():
    return render_template("members.html", members=db.list_members())


@app.post("/members/add")
def members_add():
    try:
        db.add_member(request.form.get("name", ""), request.form.get("chat_name", ""),
                      request.form.get("phone", ""))
        flash("Family member added.", "ok")
    except ValueError as problem:
        flash(str(problem), "error")
    return redirect(url_for("members_page"))


@app.post("/members/<int:member_id>/toggle")
def members_toggle(member_id):
    db.set_member_active(member_id, request.form.get("active") == "1")
    return redirect(url_for("members_page"))


@app.post("/members/<int:member_id>/delete")
def members_delete(member_id):
    db.delete_member(member_id)  # past expenses are kept
    return redirect(url_for("members_page"))


# ----------------------------------------------------------- chat import

@app.get("/import")
def import_page():
    return render_template("import.html")


@app.post("/import")
def import_upload():
    if not db.list_members(only_active=True):
        flash("Add your family members first, so I know whose messages to read.", "error")
        return redirect(url_for("members_page"))
    upload = request.files.get("chat_file")
    if upload is None or not upload.filename:
        flash("Choose the exported chat file first.", "error")
        return redirect(url_for("import_page"))
    try:
        text = chat_import.read_export(upload.read(), upload.filename)
    except ValueError as problem:
        flash(str(problem), "error")
        return redirect(url_for("import_page"))
    summary = chat_import.stage_import(text)
    return render_template(
        "import_review.html",
        summary=summary,
        rows=db.staged_rows(summary.batch_id),
        categories=CATEGORIES + [UNCATEGORIZED],
    )


@app.post("/import/confirm")
def import_confirm():
    selected = {int(value) for value in request.form.getlist("selected") if value.isdigit()}
    overrides = {int(key[9:]): value for key, value in request.form.items()
                 if key.startswith("category_") and key[9:].isdigit()}
    saved, duplicates = chat_import.confirm_import(request.form.get("batch_id", ""), selected, overrides)
    message = f"Imported {saved} expense{'s' if saved != 1 else ''}."
    if duplicates:
        message += f" Skipped {duplicates} already saved."
    flash(message, "ok")
    return redirect(url_for("home"))




# ------------------------------------------------------------------ recurring expenses

@app.get("/recurring")
def recurring_page():
    today = recurring.today_local()
    rows = [{"row": r, "text": recurring.due_text(r, today),
             "state": recurring.status(r, today)[0],
             "share": recurring.reminder_share_text(r, today),
             "paid_share": recurring.paid_share_text(r)} for r in db.list_recurring()]
    return render_template("recurring.html", items=rows, categories=CATEGORIES + [UNCATEGORIZED])


@app.post("/recurring/add")
def recurring_add():
    form = request.form
    try:
        amount = float(form.get("amount", "").replace(",", ""))
        day = int(form.get("due_day", ""))
        reminder = int(form.get("remind_days", "2") or 2)
        frequency = form.get("frequency", "")
        name = form.get("name", "").strip()
        category = form.get("category", UNCATEGORIZED)
        month = int(form["month"]) if form.get("month") else None
        if (not name or amount <= 0 or not 1 <= day <= 31 or not 0 <= reminder <= 60
                or frequency not in recurring.FREQUENCY_MONTHS
                or category not in CATEGORIES + [UNCATEGORIZED]):
            raise ValueError
    except ValueError:
        flash("Please fill in a name, an amount above zero, how often, and a day between 1 and 31.", "error")
        return redirect(url_for("recurring_page"))
    due = recurring.first_due(frequency, day, recurring.today_local(), month)
    db.add_recurring(name, amount, category, frequency, day, due, reminder)
    flash(f"Added {name}. Next due {due:%d %b %Y}.", "ok")
    return redirect(url_for("recurring_page"))


@app.post("/recurring/<int:recurring_id>/paid")
def recurring_paid(recurring_id):
    row = recurring.mark_paid(recurring_id, WEB_USER, recurring.today_local())
    if row is None:
        flash("That recurring expense no longer exists.", "error")
    else:
        flash(f"Recorded {row['name']} {inr(row['amount'])}. To tell the group, post: "
              f"{recurring.paid_share_text(row)}", "ok")
    return redirect(request.referrer or url_for("recurring_page"))


@app.post("/recurring/<int:recurring_id>/delete")
def recurring_delete(recurring_id):
    db.delete_recurring(recurring_id)
    flash("Stopped that recurring expense. Past payments stay.", "ok")
    return redirect(url_for("recurring_page"))


if __name__ == "__main__":
    app.run(debug=True)  # debug mode is for your own computer only

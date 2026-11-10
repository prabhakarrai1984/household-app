import os
from datetime import date

from flask import Flask, flash, jsonify, redirect, render_template, request, send_file, url_for

import chat_import
import db
import export
from message_parser import CATEGORIES, UNCATEGORIZED
from service import handle_message, inr

app = Flask(__name__)
app.secret_key = os.environ.get("SECRET_KEY", "dev-only-change-me")
app.config["MAX_CONTENT_LENGTH"] = 25 * 1024 * 1024  # refuse uploads above 25 MB
app.add_template_filter(inr, "inr")


@app.template_filter("nicedate")
def nicedate(value):
    return date.fromisoformat(value).strftime("%d %b %Y")


@app.errorhandler(413)
def too_large(_error):
    return "That file is too large (limit 25 MB). Export the chat 'Without media'.", 413


# ------------------------------------------------------------------ home

@app.get("/")
def home():
    return render_template(
        "index.html",
        total=db.total_expenses(),
        by_category=db.totals_by_category(),
        recent=db.recent(20),
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


if __name__ == "__main__":
    app.run(debug=True)  # debug mode is for your own computer only

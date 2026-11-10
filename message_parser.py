"""Turn a chat message like "Spent 450 on vegetables yesterday" into a structured expense.

No web or database code lives here, so it is easy to test and easy to reuse
later when the WhatsApp connection is added.
"""
import os
import re
from dataclasses import dataclass
from datetime import date, timedelta

CATEGORIES = [
    "Investment", "Grocery", "Medicine", "School Fees", "Study",
    "Entertainment", "Clothes", "Travel", "Vehicle", "Gift",
]
UNCATEGORIZED = "Uncategorized"

# Words a person types to name a category directly. These WIN over keyword guessing.
CATEGORY_NAMES = {
    "Investment": ["investment", "investments"],
    "Grocery": ["grocery", "groceries"],
    "Medicine": ["medicine", "medicines"],
    "School Fees": ["school fees", "school fee"],
    "Study": ["study"],
    "Entertainment": ["entertainment"],
    "Clothes": ["clothes"],
    "Travel": ["travel"],
    "Vehicle": ["vehicle"],
    "Gift": ["gift", "gifts"],
}

# Everyday words that hint at a category. Add your own family's words here.
KEYWORDS = {
    "Investment": ["sip", "mutual fund", "mutual funds", "stock", "stocks", "shares",
                   "fd", "fixed deposit", "ppf", "nps", "gold", "invest"],
    "Grocery": ["vegetable", "vegetables", "fruit", "fruits", "milk", "rice", "atta",
                "dal", "oil", "bread", "eggs", "supermarket", "bigbasket", "blinkit",
                "zepto", "kirana", "tomato", "tomatoes", "onion", "onions", "potato",
                "potatoes", "paneer", "curd", "sugar", "salt"],
    "Medicine": ["medical", "pharmacy", "doctor", "tablet", "tablets", "hospital",
                 "clinic", "chemist", "apollo"],
    "School Fees": ["school"],
    "Study": ["tuition", "course", "books", "book", "stationery", "exam", "coaching", "class"],
    "Entertainment": ["movie", "movies", "netflix", "prime", "hotstar", "spotify", "game",
                      "games", "concert", "party", "restaurant", "dining", "outing"],
    "Clothes": ["clothing", "shirt", "shirts", "jeans", "saree", "dress", "shoes",
                "footwear", "tshirt", "kurta"],
    "Travel": ["train", "flight", "bus", "ticket", "tickets", "hotel", "trip", "cab",
               "uber", "ola", "taxi", "metro", "auto"],
    "Vehicle": ["petrol", "diesel", "fuel", "car", "bike", "servicing", "car service",
                "bike service", "tyre", "parking", "fastag", "puncture", "engine oil"],
    "Gift": ["present", "birthday", "wedding", "anniversary"],
}


class ParseError(ValueError):
    """Raised when a message can't be understood. The text is safe to show to the user."""


@dataclass
class ParsedExpense:
    amount: float
    category: str
    description: str
    expense_date: date


def today_local():
    """Today's date in the family's time zone (default India), not the server's."""
    try:
        from zoneinfo import ZoneInfo
        from datetime import datetime
        return datetime.now(ZoneInfo(os.environ.get("HOUSEHOLD_TZ", "Asia/Kolkata"))).date()
    except Exception:
        return date.today()


# Matches amounts like: 450  1,250.50  ₹300  rs 300  2k
# A number followed by a unit (2 kg, 1 ltr) is a quantity, not money.
_UNITS = r"(?:kg|kgs|g|gm|gms|l|ltr|ltrs|litre|litres|pcs|pc|dozen|x)"
_AMOUNT_RE = re.compile(
    r"(?<![\w.:/])(?P<cur>₹|rs\.?|inr)?\s*(?P<num>\d[\d,]*(?:\.\d+)?)\s*"
    r"(?P<k>k(?![a-z]))?(?P<unit>\s*" + _UNITS + r"\b)?",
    re.IGNORECASE,
)

# What follows a number when it is really a time or a date: 7 pm, 8:30, 15/11, 10-11
_TIME_OR_DATE_TAIL = re.compile(r"(?:\s*(?:am|pm|a\.m\.|p\.m\.|o'clock)\b|[:/\-]\d)", re.IGNORECASE)


def _find_amount(text):
    for match in _AMOUNT_RE.finditer(text):
        if match.group("unit") and not match.group("cur"):
            continue  # "2 kg" is a quantity
        if _TIME_OR_DATE_TAIL.match(text, match.end("num")):
            continue  # "7 pm", "8:30" and "15/11" are times and dates, not money
        number = float(match.group("num").replace(",", ""))
        if match.group("k"):
            number *= 1000
        return number, match
    return None, None


def _earliest(low_text, mapping):
    """Return the category whose word appears earliest in the text, or None."""
    best = None
    for category, words in mapping.items():
        for word in words:
            found = re.search(r"\b" + re.escape(word) + r"\b", low_text)
            if found and (best is None or found.start() < best[0]):
                best = (found.start(), category)
    return best[1] if best else None


def categorize(text):
    low = text.lower()
    return _earliest(low, CATEGORY_NAMES) or _earliest(low, KEYWORDS) or UNCATEGORIZED


def _clean_description(text, amount_match, category):
    leftover = text[:amount_match.start()] + " " + text[amount_match.end():]
    leftover = re.sub(r"\b(yesterday|today)\b", " ", leftover, flags=re.IGNORECASE)
    leftover = re.sub(r"\b(spent|paid|bought|expense|rs|inr)\b", " ", leftover, flags=re.IGNORECASE)
    leftover = re.sub(r"^(?:\s*(?:on|for|at|of|in|to|the|a)\b)+", "", leftover, flags=re.IGNORECASE)
    leftover = re.sub(r"\s+", " ", leftover).strip(" ,.-:;")
    if not leftover:
        return category if category != UNCATEGORIZED else "Expense"
    return leftover[0].upper() + leftover[1:]


def parse_message(text, today=None):
    """Return a ParsedExpense, or raise ParseError with a friendly explanation."""
    text = (text or "").strip()
    if not text:
        raise ParseError("The message was empty.")
    today = today or today_local()

    amount, amount_match = _find_amount(text)
    if amount is None or amount <= 0:
        raise ParseError("I couldn't find an amount in that message.")

    expense_date = today
    if re.search(r"\byesterday\b", text, flags=re.IGNORECASE):
        expense_date = today - timedelta(days=1)

    category = categorize(text)
    description = _clean_description(text, amount_match, category)
    return ParsedExpense(round(amount, 2), category, description, expense_date)

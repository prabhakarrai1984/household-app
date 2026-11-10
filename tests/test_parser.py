import unittest
from datetime import date

from message_parser import ParseError, parse_message

TODAY = date(2026, 11, 10)


class ParserTests(unittest.TestCase):
    def parse(self, text):
        return parse_message(text, today=TODAY)

    def test_us1_amount_description_and_default_date(self):
        result = self.parse("Spent 450 on vegetables")
        self.assertEqual(result.amount, 450)
        self.assertEqual(result.category, "Grocery")
        self.assertEqual(result.description, "Vegetables")
        self.assertEqual(result.expense_date, TODAY)

    def test_us2_yesterday(self):
        result = self.parse("Medicine 320 yesterday")
        self.assertEqual(result.category, "Medicine")
        self.assertEqual(result.expense_date, date(2026, 11, 9))

    def test_us3_no_amount_is_an_error(self):
        with self.assertRaises(ParseError):
            self.parse("bought some vegetables")

    def test_us3_empty_and_zero_are_errors(self):
        for text in ("", "   ", "groceries 0"):
            with self.assertRaises(ParseError, msg=text):
                self.parse(text)

    def test_us6_keywords_pick_category(self):
        cases = {
            "petrol 2000": "Vehicle",
            "netflix 649": "Entertainment",
            "SIP 5000": "Investment",
            "train ticket 1200": "Travel",
            "saree 3500": "Clothes",
            "school fees 25000": "School Fees",
            "exam fee books 800": "Study",
            "engine oil 900": "Vehicle",
        }
        for text, expected in cases.items():
            self.assertEqual(self.parse(text).category, expected, msg=text)

    def test_us7_explicit_category_wins_over_keywords(self):
        self.assertEqual(self.parse("Gift 800 movie tickets").category, "Gift")
        self.assertEqual(self.parse("Gift 1500 birthday").category, "Gift")

    def test_us8_unknown_is_uncategorized(self):
        self.assertEqual(self.parse("Spent 450 on random stuff").category, "Uncategorized")

    def test_amount_formats(self):
        self.assertEqual(self.parse("petrol 2,000").amount, 2000)
        self.assertEqual(self.parse("Paid ₹1,250.50 for netflix").amount, 1250.5)
        self.assertEqual(self.parse("Rs 300 milk").amount, 300)
        self.assertEqual(self.parse("2k fuel").amount, 2000)

    def test_times_and_dates_are_not_amounts(self):
        for text in ("Movie at 7 pm tonight", "Dinner at 8:30", "PTM is on 15/11", "meet 10-11 am"):
            with self.assertRaises(ParseError, msg=text):
                self.parse(text)
        self.assertEqual(self.parse("movie 450 at 7 pm").amount, 450)

    def test_income_messages(self):
        result = self.parse("Income 85000 salary")
        self.assertEqual((result.entry_type, result.category, result.amount, result.description),
                         ("Income", "Income", 85000, "Salary"))
        self.assertEqual(self.parse("salary 85000").description, "Salary")
        self.assertEqual(self.parse("Income 5000").description, "Income")
        self.assertEqual(self.parse("income: 1,200 interest yesterday").expense_date, date(2026, 11, 9))

    def test_income_words_elsewhere_are_still_expenses(self):
        for text in ("Maid salary 8000", "Income tax 5000", "paid salary to driver 12000"):
            self.assertEqual(self.parse(text).entry_type, "Expense", msg=text)

    def test_quantities_are_not_amounts(self):
        result = self.parse("2 kg tomatoes 80")
        self.assertEqual(result.amount, 80)
        self.assertEqual(result.category, "Grocery")


if __name__ == "__main__":
    unittest.main()

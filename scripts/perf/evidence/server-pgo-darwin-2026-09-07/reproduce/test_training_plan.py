import unittest
from screen_http_v2 import training_identities

class TrainingPlanTests(unittest.TestCase):
    def test_exact_five_distinct_members(self):
        rows=[{"publicSha256":str(i)} for i in range(5)]
        self.assertEqual(training_identities(rows,[str(i) for i in range(27)]),set(map(str,range(5))))
        for invalid in (rows+[rows[0]],rows[:-1],rows[:-1]+[rows[0]],rows[:-1]+[{"publicSha256":"outside"}]):
            with self.subTest(rows=invalid),self.assertRaises(ValueError):
                training_identities(invalid,[str(i) for i in range(27)])

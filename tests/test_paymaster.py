"""Tests for paymaster access control and the payroll XLSX export."""

from odoo.exceptions import AccessError
from odoo.tests import TransactionCase, new_test_user, tagged

EXPORT_NAME = "PAYMASTER_BANK_DATA.xlsx"


@tagged("post_install", "-at_install")
class TestPaymaster(TransactionCase):
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.plain_user = new_test_user(
            cls.env, login="refactor_paymaster_plain", groups="base.group_user"
        )
        cls.payroll_user = new_test_user(
            cls.env,
            login="refactor_paymaster_officer",
            groups="base.group_user,hr_payroll.group_hr_payroll_user",
        )

    def test_config_hidden_from_non_payroll_users(self):
        """Company bank details are not readable outside payroll (OWASP A01)."""
        with self.assertRaises(AccessError):
            self.env["jinasena.paymaster.config"].with_user(self.plain_user).search([])

    def test_wizard_hidden_from_non_payroll_users(self):
        with self.assertRaises(AccessError):
            self.env["jinasena.paymaster.wizard"].with_user(self.plain_user).search([])

    def test_config_readable_by_payroll_officer(self):
        config = self.env["jinasena.paymaster.config"].get_config()
        self.assertTrue(config.with_user(self.payroll_user).read(["name"]))

    def _exports(self, user):
        return self.env["ir.attachment"].search(
            [
                ("name", "=", EXPORT_NAME),
                ("res_model", "=", "hr.payslip"),
                ("create_uid", "=", user.id),
            ]
        )

    def test_export_replaces_previous_file(self):
        """Salary exports do not pile up: each export replaces the last one."""
        payslips = self.env["hr.payslip"].with_user(self.payroll_user)
        first = payslips.action_export_bank_data_csv()
        second = payslips.action_export_bank_data_csv()
        self.assertEqual(first["type"], "ir.actions.act_url")
        self.assertNotEqual(first["url"], second["url"])
        self.assertEqual(len(self._exports(self.payroll_user)), 1)

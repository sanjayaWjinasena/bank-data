"""Integrity checks for everything this module ships.

Run after install (post_install), against the module's own records in the
database: these catch the breakages that file moves, field renames and
uninstalled dependencies cause, before a user meets them.
"""

from odoo.osv import expression
from odoo.tests import TransactionCase, tagged
from odoo.tools.safe_eval import safe_eval, test_python_expr

MODULE = "bank-data"


@tagged("post_install", "-at_install")
class TestModuleIntegrity(TransactionCase):
    def _module_records(self, model):
        """Records of ``model`` created by this module's data files."""
        data = self.env["ir.model.data"].search(
            [("module", "=", MODULE), ("model", "=", model)]
        )
        return self.env[model].browse(data.mapped("res_id")).exists()

    def test_views_render(self):
        """Every view combines with its parent views without error."""
        for view in self._module_records("ir.ui.view"):
            if view.type == "qweb":
                continue
            with self.subTest(view=view.xml_id or view.name):
                self.assertIn(view.model, self.env, "view on unknown model")
                self.env[view.model].get_view(view.id, view.type)

    def test_server_action_code_compiles(self):
        """Python code in server actions is valid."""
        for action in self._module_records("ir.actions.server"):
            if action.state != "code" or not action.code:
                continue
            with self.subTest(action=action.name):
                error = test_python_expr(expr=action.code.strip(), mode="exec")
                self.assertFalse(error, error)

    def test_fields_exist(self):
        """Every field this module defines is loaded in the registry."""
        for field in self._module_records("ir.model.fields"):
            with self.subTest(field=f"{field.model}.{field.name}"):
                self.assertIn(field.model, self.env)
                self.assertIn(field.name, self.env[field.model]._fields)

    def test_menus_point_to_existing_actions(self):
        """Menus do not point at deleted actions."""
        for menu in self._module_records("ir.ui.menu"):
            if menu.action:
                with self.subTest(menu=menu.complete_name):
                    self.assertTrue(menu.action.exists())

    def test_access_rules_have_group(self):
        """No access rule is open to every user (OWASP A01)."""
        for acl in self._module_records("ir.model.access"):
            with self.subTest(acl=acl.name):
                self.assertTrue(acl.group_id, "access rule without a group")

    def test_record_rule_domains_valid(self):
        """Record rule domains only use fields that exist."""
        eval_context = self.env["ir.rule"]._eval_context()
        for rule in self._module_records("ir.rule"):
            if not rule.domain_force:
                continue
            with self.subTest(rule=rule.name):
                model = self.env[rule.model_id.model]
                domain = safe_eval(rule.domain_force, eval_context)
                expression.expression(domain, model.sudo())

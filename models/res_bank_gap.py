from odoo import fields, models


class ResBankGap(models.Model):
    _inherit = "res.bank"

    x_studio_lc_limit = fields.Float(string="LC Limit")

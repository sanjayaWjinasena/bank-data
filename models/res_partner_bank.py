from odoo import fields, models


class ResPartnerBank(models.Model):
    _inherit = "res.partner.bank"

    x_branch_code = fields.Char(
        string="Branch Code",
        size=3,
        help="3-digit CBC branch code for SLIPS transfers.",
    )


class ResPartnerBankGap(models.Model):
    _inherit = "res.partner.bank"

    x_studio_bank_code_1 = fields.Char(string="Bank code")
    x_studio_branch_code_1 = fields.Char(string="Branch code")
    x_studio_swift_code = fields.Char(string="SWIFT Code")

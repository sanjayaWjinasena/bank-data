from odoo import fields, models


class ResPartnerBank(models.Model):
    _inherit = "res.partner.bank"

    branch_code = fields.Char(
        size=3,
        help="3-digit CBC branch code for SLIPS transfers.",
    )


class ResPartnerBankGap(models.Model):
    _inherit = "res.partner.bank"

    bank_code_1 = fields.Char(string="Bank code")
    branch_code_1 = fields.Char(string="Branch code")
    swift_code = fields.Char(string="SWIFT Code")

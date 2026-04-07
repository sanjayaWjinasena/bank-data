from odoo import fields, models


class ResPartnerBank(models.Model):
    _inherit = 'res.partner.bank'

    x_branch_code = fields.Char(
        string='Branch Code',
        size=3,
        help='3-digit CBC branch code for SLIPS transfers.',
    )

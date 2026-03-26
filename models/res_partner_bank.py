from odoo import api, fields, models


class ResPartnerBank(models.Model):
    _inherit = 'res.partner.bank'

    x_branch_code = fields.Char(
        string='Branch Code',
        size=3,
        help='3-digit CBC branch code for SLIPS transfers. Auto-filled when a Branch is selected.',
    )
    branch_id = fields.Many2one(
        'jinasena.bank.branch',
        string='Branch',
        domain="[('bank_id', '=', bank_id)]",
        help='Select the bank branch. Branch Code is filled automatically.',
    )

    @api.onchange('bank_id')
    def _onchange_bank_id(self):
        self.branch_id = False
        self.x_branch_code = False

    @api.onchange('branch_id')
    def _onchange_branch_id(self):
        if self.branch_id:
            self.x_branch_code = self.branch_id.branch_code

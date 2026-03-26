from odoo import fields, models


class JinasenaBank(models.Model):
    _inherit = 'res.bank'

    branch_ids = fields.One2many(
        'jinasena.bank.branch',
        'bank_id',
        string='Branches',
    )


class JinasenaBankBranch(models.Model):
    _name = 'jinasena.bank.branch'
    _description = 'Bank Branch'
    _order = 'branch_code'
    _rec_name = 'name'

    bank_id = fields.Many2one('res.bank', string='Bank', required=True, ondelete='cascade')
    name = fields.Char(string='Branch Name', required=True)
    branch_code = fields.Char(string='Branch Code', size=3, required=True,
                              help='3-digit CBC branch code for SLIPS transfers.')
    street = fields.Char(string='Address')
    city = fields.Char(string='City')
    phone = fields.Char(string='Phone')
    email = fields.Char(string='Email')
    x_studio_lc_limit = fields.Float(string='LC Limit')

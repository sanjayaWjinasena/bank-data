from odoo import fields, models


class ResBank(models.Model):
    _inherit = 'res.bank'

    x_micr_code = fields.Char(
        string='Bank MICR Code',
        size=4,
        help='4-digit SLIPS bank MICR code used in CBC Paymaster file. '
             'e.g. 7056 = Commercial Bank, 7010 = Bank of Ceylon, '
             '7719 = Nations Trust Bank, 7755 = Sampath Bank, '
             '7728 = HNB, 7737 = NSB, 7214 = Peoples Bank, 7135 = Seylan Bank',
    )

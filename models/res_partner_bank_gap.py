# -*- coding: utf-8 -*-
from odoo import models, fields

class ResPartnerBankGap(models.Model):
    _inherit = 'res.partner.bank'

    x_studio_bank_code_1 = fields.Char(string='Bank code')
    x_studio_branch_code_1 = fields.Char(string='Branch code')
    x_studio_swift_code = fields.Char(string='SWIFT Code')

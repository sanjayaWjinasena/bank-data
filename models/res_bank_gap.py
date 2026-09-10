# -*- coding: utf-8 -*-
from odoo import models, fields

class ResBankGap(models.Model):
    _inherit = 'res.bank'

    x_studio_lc_limit = fields.Float(string='LC Limit')

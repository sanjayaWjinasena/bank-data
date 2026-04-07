import logging
from odoo import api, fields, models

_logger = logging.getLogger(__name__)

# CBC format defaults used when the config table doesn't exist yet
_CFG_DEFAULTS = {
    'trn_code':      '23',
    'return_code':   '00',
    'cr_dr_code':    '0',
    'return_date':   '000000',
    'currency_code': 'SLR',
    'orig_bank_micr': '',
    'orig_branch':   '',
    'orig_account':  '',
    'orig_name':     '',
    'security_field': '      ',
    'filler':        '@',
}


class AccountMoveLine(models.Model):
    _inherit = 'account.move.line'

    # ── CBC Paymaster columns B–T, all computed (store=False) ────────────
    # B–E: pulled from the employee's bank account via partner_id
    # F–I, K, S, T: from jinasena.paymaster.config (CBC format constants)
    # J: from credit / debit
    # L–O: Jinasena originating account from config
    # P: journal line label (name)
    # Q: journal entry reference (move_id.ref)
    # R: line date

    x_dest_bank_micr = fields.Char('Dest Bank (B)',    compute='_compute_cbc_data', store=False)
    x_dest_branch    = fields.Char('Dest Branch (C)',  compute='_compute_cbc_data', store=False)
    x_dest_account   = fields.Char('Dest Account (D)', compute='_compute_cbc_data', store=False)
    x_dest_name      = fields.Char('Dest Name (E)',    compute='_compute_cbc_data', store=False)
    x_trn_code       = fields.Char('TRN Code (F)',     compute='_compute_cbc_data', store=False)
    x_return_code    = fields.Char('Return Code (G)',  compute='_compute_cbc_data', store=False)
    x_cr_dr_code     = fields.Char('Cr/Dr (H)',        compute='_compute_cbc_data', store=False)
    x_return_date    = fields.Char('Return Date (I)',  compute='_compute_cbc_data', store=False)
    x_cbc_amount     = fields.Float('Amount (J)',      compute='_compute_cbc_data', store=False,
                                     digits=(15, 2))
    x_currency_code  = fields.Char('Currency (K)',     compute='_compute_cbc_data', store=False)
    x_orig_bank_micr = fields.Char('Orig Bank (L)',    compute='_compute_cbc_data', store=False)
    x_orig_branch    = fields.Char('Orig Branch (M)',  compute='_compute_cbc_data', store=False)
    x_orig_account   = fields.Char('Orig Account (N)', compute='_compute_cbc_data', store=False)
    x_orig_name      = fields.Char('Orig Name (O)',    compute='_compute_cbc_data', store=False)
    x_particulars    = fields.Char('Particulars (P)',  compute='_compute_cbc_data', store=False)
    x_reference      = fields.Char('Reference (Q)',    compute='_compute_cbc_data', store=False)
    x_value_date     = fields.Char('Value Date (R)',   compute='_compute_cbc_data', store=False)
    x_security_field = fields.Char('Security (S)',     compute='_compute_cbc_data', store=False)
    x_filler         = fields.Char('Filler (T)',       compute='_compute_cbc_data', store=False)

    @api.depends(
        'partner_id', 'partner_id.bank_ids',
        'credit', 'debit',
        'date', 'name', 'move_id.ref',
    )
    def _compute_cbc_data(self):
        # Batch-load employees keyed by their home partner to avoid N+1 queries
        partner_ids = self.mapped('partner_id').ids
        employees = self.env['hr.employee'].search(
            [('address_home_id', 'in', partner_ids)]
        )
        emp_by_partner = {emp.address_home_id.id: emp for emp in employees}

        # Load CBC config — fall back to hardcoded defaults if the config
        # table doesn't exist yet (e.g. module partially upgraded).
        cfg = _CFG_DEFAULTS.copy()
        try:
            rec = self.env['jinasena.paymaster.config'].sudo().get_config()
            cfg.update({
                'trn_code':       rec.trn_code      or cfg['trn_code'],
                'return_code':    rec.return_code   or cfg['return_code'],
                'cr_dr_code':     rec.cr_dr_code    or cfg['cr_dr_code'],
                'return_date':    rec.return_date   or cfg['return_date'],
                'currency_code':  rec.currency_code or cfg['currency_code'],
                'orig_bank_micr': rec.orig_bank_micr or '',
                'orig_branch':    rec.orig_branch   or '',
                'orig_account':   rec.orig_account  or '',
                'orig_name':      rec.orig_name     or '',
                'security_field': rec.security_field or cfg['security_field'],
                'filler':         rec.filler        or cfg['filler'],
            })
        except Exception:
            _logger.warning(
                'bank_data: jinasena.paymaster.config not available yet '
                '(table may not exist). Using built-in defaults.',
                exc_info=False,
            )

        for line in self:
            emp  = emp_by_partner.get(line.partner_id.id)
            bank = emp.bank_account_id if emp else False

            line.x_dest_bank_micr = (bank.bank_id.x_micr_code or '') if (bank and bank.bank_id) else ''
            line.x_dest_branch    = (bank.x_branch_code or '') if bank else ''
            line.x_dest_account   = (bank.acc_number or '')[:12] if bank else ''
            line.x_dest_name      = (emp.name or '')[:20] if emp else ''

            line.x_trn_code       = cfg['trn_code']
            line.x_return_code    = cfg['return_code']
            line.x_cr_dr_code     = cfg['cr_dr_code']
            line.x_return_date    = cfg['return_date']

            line.x_cbc_amount     = line.credit or line.debit or 0.0

            line.x_currency_code  = cfg['currency_code']
            line.x_orig_bank_micr = cfg['orig_bank_micr']
            line.x_orig_branch    = cfg['orig_branch']
            line.x_orig_account   = cfg['orig_account']
            line.x_orig_name      = cfg['orig_name']

            line.x_particulars    = (line.name or '')[:15]
            line.x_reference      = (line.move_id.ref or '')[:15]
            line.x_value_date     = line.date.strftime('%y%m%d') if line.date else ''
            line.x_security_field = cfg['security_field']
            line.x_filler         = cfg['filler']

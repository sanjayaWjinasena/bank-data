import logging
from odoo import api, fields, models
from .account_move_line import _CFG_DEFAULTS

_logger = logging.getLogger(__name__)


class HrPayslip(models.Model):
    _inherit = 'hr.payslip'

    # ── CBC Paymaster columns B–T computed from payslip data ─────────────
    # B–D: employee's bank account details
    # E: employee_id.name (use directly in view)
    # F–I, K, L–O, S, T: from jinasena.paymaster.config
    # J: net_wage (use directly in view)
    # P: employee badge / number
    # Q: payslip reference
    # R: date_to as YYMMDD

    x_dest_bank_micr = fields.Char('Dest Bank (B)',    compute='_compute_cbc_payslip', store=False)
    x_dest_branch    = fields.Char('Dest Branch (C)',  compute='_compute_cbc_payslip', store=False)
    x_dest_account   = fields.Char('Dest Account (D)', compute='_compute_cbc_payslip', store=False)
    x_trn_code       = fields.Char('TRN Code (F)',     compute='_compute_cbc_payslip', store=False)
    x_return_code    = fields.Char('Return Code (G)',  compute='_compute_cbc_payslip', store=False)
    x_cr_dr_code     = fields.Char('Cr/Dr (H)',        compute='_compute_cbc_payslip', store=False)
    x_return_date    = fields.Char('Return Date (I)',  compute='_compute_cbc_payslip', store=False)
    x_currency_code  = fields.Char('Currency (K)',     compute='_compute_cbc_payslip', store=False)
    x_orig_bank_micr = fields.Char('Orig Bank (L)',    compute='_compute_cbc_payslip', store=False)
    x_orig_branch    = fields.Char('Orig Branch (M)',  compute='_compute_cbc_payslip', store=False)
    x_orig_account   = fields.Char('Orig Account (N)', compute='_compute_cbc_payslip', store=False)
    x_orig_name      = fields.Char('Orig Name (O)',    compute='_compute_cbc_payslip', store=False)
    x_particulars    = fields.Char('Particulars (P)',  compute='_compute_cbc_payslip', store=False)
    x_cbc_reference  = fields.Char('Reference (Q)',   compute='_compute_cbc_payslip', store=False)
    x_value_date     = fields.Char('Value Date (R)',   compute='_compute_cbc_payslip', store=False)
    x_security_field = fields.Char('Security (S)',     compute='_compute_cbc_payslip', store=False)
    x_filler         = fields.Char('Filler (T)',       compute='_compute_cbc_payslip', store=False)

    @api.depends(
        'employee_id', 'employee_id.bank_account_id',
        'employee_id.bank_account_id.bank_id',
        'net_wage', 'date_to', 'name',
    )
    def _compute_cbc_payslip(self):
        # Load CBC config with fallback defaults
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
                'bank_data: jinasena.paymaster.config not available. Using defaults.',
                exc_info=False,
            )

        for slip in self:
            bank = slip.employee_id.bank_account_id

            slip.x_dest_bank_micr = (bank.bank_id.x_micr_code or '') if (bank and bank.bank_id) else ''
            slip.x_dest_branch    = (bank.x_branch_code or '') if bank else ''
            slip.x_dest_account   = (bank.acc_number or '')[:12] if bank else ''

            slip.x_trn_code       = cfg['trn_code']
            slip.x_return_code    = cfg['return_code']
            slip.x_cr_dr_code     = cfg['cr_dr_code']
            slip.x_return_date    = cfg['return_date']
            slip.x_currency_code  = cfg['currency_code']
            slip.x_orig_bank_micr = cfg['orig_bank_micr']
            slip.x_orig_branch    = cfg['orig_branch']
            slip.x_orig_account   = cfg['orig_account']
            slip.x_orig_name      = cfg['orig_name']

            slip.x_particulars    = (slip.employee_id.barcode or str(slip.employee_id.id or ''))[:15]
            slip.x_cbc_reference  = (slip.name or '')[:15]
            slip.x_value_date     = slip.date_to.strftime('%y%m%d') if slip.date_to else ''
            slip.x_security_field = cfg['security_field']
            slip.x_filler         = cfg['filler']

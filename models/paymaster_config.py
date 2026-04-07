from odoo import api, fields, models


class JinasenaPaymasterConfig(models.Model):
    _name        = 'jinasena.paymaster.config'
    _description = 'CBC Paymaster Configuration'
    _rec_name    = 'name'

    name = fields.Char(default='CBC Paymaster Config', readonly=True)

    # ── CBC file format constants ─────────────────────────────────────────
    trn_code = fields.Char(
        string='TRN Code (F)', size=2, default='23', required=True,
        help='2-digit transaction type code. 23 = Salary credit transfer (SLIPS).',
    )
    return_code = fields.Char(
        string='Return Code (G)', size=2, default='00', required=True,
        help='2-digit return code. 00 = no return (normal outgoing payment).',
    )
    cr_dr_code = fields.Selection(
        selection=[('0', '0 – Credit (payment out)'), ('1', '1 – Debit (collection in)')],
        string='Cr/Dr Code (H)', default='0', required=True,
        help='Credit/Debit indicator. 0 = credit (salary payment).',
    )
    return_date = fields.Char(
        string='Return Date (I)', size=6, default='000000', required=True,
        help='Return date YYMMDD. 000000 = no return date.',
    )
    currency_code = fields.Char(
        string='Currency Code (K)', size=3, default='SLR', required=True,
        help='3-char currency code. SLR = Sri Lankan Rupee.',
    )
    security_field = fields.Char(
        string='Security Field (S)', size=6, default='      ', required=True,
        help='6-char security field. CBC standard is 6 spaces.',
    )
    filler = fields.Char(
        string='Filler (T)', size=1, default='@', required=True,
        help='1-char filler byte. CBC standard is @.',
    )

    # ── Originating bank — Jinasena's CBC account (columns L, M, N, O) ──
    orig_bank_micr = fields.Char(
        string='Orig Bank MICR (L)', size=4,
        help="4-digit SLIPS MICR code for Jinasena's bank (e.g. 7056 for Commercial Bank).",
    )
    orig_branch = fields.Char(
        string='Orig Branch Code (M)', size=3,
        help="3-digit CBC branch code for Jinasena's account (e.g. 003).",
    )
    orig_account = fields.Char(
        string='Orig Account No (N)', size=12,
        help="Jinasena's CBC account number (up to 12 digits).",
    )
    orig_name = fields.Char(
        string='Orig Name (O)', size=20,
        help="Jinasena account name as registered with CBC (up to 20 chars).",
    )

    @api.model
    def get_config(self):
        """Return the singleton config record, creating defaults if none exists."""
        config = self.search([], limit=1, order='id asc')
        if not config:
            config = self.create({'name': 'CBC Paymaster Config'})
        return config

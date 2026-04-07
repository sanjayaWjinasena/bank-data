import base64
import re
from odoo import _, api, fields, models
from odoo.exceptions import UserError


class PaymasterWizard(models.TransientModel):
    _name = 'jinasena.paymaster.wizard'
    _description = 'CBC Paymaster File Generator'

    # Works on Community (no hr.payslip.run needed).
    # When hr_payroll (Enterprise) is installed, the button on hr.payslip.run
    # passes employee_ids pre-populated.
    employee_ids = fields.Many2many(
        'hr.employee',
        string='Employees',
        required=True,
        help='Select the employees to include in this Paymaster file.',
    )
    reference = fields.Char(
        string='Reference (max 15 chars)',
        size=15,
        required=True,
        help='Appears in the Reference column of each record. e.g. SalaryMAR2026',
    )
    payment_date = fields.Date(
        string='Value Date',
        required=True,
        help='The date the bank will execute the transfers (YYMMDD in the file).',
    )
    company_account_id = fields.Many2one(
        'res.partner.bank',
        string='Company Bank Account',
        required=True,
        domain="[('partner_id.is_company', '=', True)]",
        help="Jinasena's originating Commercial Bank account.",
    )
    company_branch_code = fields.Char(
        string='Company Branch Code',
        size=3,
        required=True,
        help="3-digit CBC branch code for Jinasena's account. e.g. 003",
    )
    # ── File format config (override defaults only when bank spec changes) ──
    trn_code = fields.Char(
        string='TRN Code',
        size=2,
        default='23',
        required=True,
        help='2-digit transaction type code. 23 = Salary/Loan credit transfer (SLIPS standard).',
    )
    return_code = fields.Char(
        string='Return Code',
        size=2,
        default='00',
        required=True,
        help='2-digit return/error code. 00 = no return (normal outgoing payment).',
    )
    cr_dr_code = fields.Selection(
        selection=[('0', '0 – Credit (payment out)'), ('1', '1 – Debit (collection in)')],
        string='Cr/Dr Code',
        default='0',
        required=True,
        help='Credit/Debit indicator. 0 = credit (outgoing salary/loan payment).',
    )
    return_date = fields.Char(
        string='Return Date',
        size=6,
        default='000000',
        required=True,
        help='6-digit return date in YYMMDD. 000000 = no return date (standard for outgoing payments).',
    )
    currency_code = fields.Char(
        string='Currency Code',
        size=3,
        default='SLR',
        required=True,
        help='3-char ISO currency code. SLR = Sri Lankan Rupee.',
    )

    # Amount per employee — entered manually when not using hr_payroll
    line_ids = fields.One2many(
        'jinasena.paymaster.wizard.line',
        'wizard_id',
        string='Payment Lines',
    )

    @api.onchange('company_account_id')
    def _onchange_company_account(self):
        if self.company_account_id and self.company_account_id.x_branch_code:
            self.company_branch_code = self.company_account_id.x_branch_code

    @api.onchange('employee_ids')
    def _onchange_employees(self):
        """Pre-populate payment lines when employees are selected."""
        existing = {l.employee_id.id for l in self.line_ids}
        new_lines = []
        for emp in self.employee_ids:
            if emp.id not in existing:
                new_lines.append((0, 0, {'employee_id': emp.id, 'amount': 0.0}))
        # Remove lines for deselected employees
        remove = [(2, l.id) for l in self.line_ids if l.employee_id not in self.employee_ids]
        self.line_ids = remove + new_lines

    # ------------------------------------------------------------------
    # Fixed-width record formatter — 151 chars exactly
    # ------------------------------------------------------------------

    def _digits_only(self, value):
        return re.sub(r'\D', '', str(value or ''))

    def _format_record(self, seq, dest_bank, dest_branch, dest_acc,
                       dest_name, amount_cents, emp_number, reference,
                       value_date, orig_bank, orig_branch, orig_acc, orig_name):
        record = (
            str(seq).zfill(4)                                   # A  Tran ID         4
            + str(dest_bank).zfill(4)                           # B  Dest Bank       4
            + str(dest_branch).zfill(3)                         # C  Dest Branch     3
            + self._digits_only(dest_acc).zfill(12)             # D  Dest Account   12
            + str(dest_name)[:20].ljust(20)                     # E  Dest Name      20
            + str(self.trn_code).zfill(2)                       # F  TRN Code        2
            + str(self.return_code).zfill(2)                    # G  Return Code     2
            + str(self.cr_dr_code)                              # H  Cr/Dr Code      1
            + str(self.return_date).ljust(6)[:6]               # I  Return Date     6
            + str(int(round(amount_cents))).zfill(12)           # J  Amount         12
            + str(self.currency_code).upper()[:3].ljust(3)      # K  Currency        3
            + str(orig_bank).zfill(4)                           # L  Orig Bank       4
            + str(orig_branch).zfill(3)                         # M  Orig Branch     3
            + self._digits_only(orig_acc).zfill(12)             # N  Orig Account   12
            + str(orig_name)[:20].ljust(20)                     # O  Orig Name      20
            + str(emp_number)[:15].ljust(15)                    # P  Particulars    15
            + str(reference)[:15].ljust(15)                     # Q  Reference      15
            + value_date.strftime('%y%m%d')                     # R  Value Date      6
            + ' ' * 6                                           # S  Security Field  6
            + '@'                                               # T  Filler          1
        )
        if len(record) != 151:
            raise UserError(
                _('Internal error: record length is %d, expected 151.\nRecord: %s')
                % (len(record), record)
            )
        return record

    # ------------------------------------------------------------------
    # Main action
    # ------------------------------------------------------------------

    def action_generate(self):
        self.ensure_one()

        if not self.line_ids:
            raise UserError(_('No payment lines. Add employees and enter their payment amounts.'))

        lines_to_pay = self.line_ids.filtered(lambda l: l.amount > 0)
        if not lines_to_pay:
            raise UserError(_('All amounts are zero. Enter the payment amount for each employee.'))

        # Originating account details
        orig_acc = self.company_account_id
        orig_bank_micr = orig_acc.bank_id.x_micr_code if orig_acc.bank_id else '7056'
        orig_branch = self.company_branch_code or (orig_acc.x_branch_code or '000')
        orig_acc_number = orig_acc.acc_number or ''
        orig_name = (orig_acc.acc_holder_name or orig_acc.partner_id.name or '')

        records = []
        errors = []

        for line in lines_to_pay:
            emp = line.employee_id
            partner = emp.address_home_id or emp.address_id

            bank_accounts = self.env['res.partner.bank'].search(
                [('partner_id', '=', partner.id)], limit=10
            ) if partner else self.env['res.partner.bank']

            bank_acc = bank_accounts.filtered(lambda b: b.x_branch_code)[:1] or bank_accounts[:1]

            if not bank_acc:
                errors.append(_('Employee "%s" has no bank account configured.') % emp.name)
                continue
            if not bank_acc.x_branch_code:
                errors.append(_('Employee "%s": bank account missing Branch Code.') % emp.name)
            if not (bank_acc.bank_id and bank_acc.bank_id.x_micr_code):
                errors.append(_('Employee "%s": bank missing MICR code.') % emp.name)

            dest_bank_micr = bank_acc.bank_id.x_micr_code if bank_acc.bank_id else '0000'
            emp_number = emp.barcode or str(emp.id)
            amount_cents = line.amount * 100

            records.append(self._format_record(
                seq=len(records) + 1,
                dest_bank=dest_bank_micr,
                dest_branch=bank_acc.x_branch_code or '000',
                dest_acc=bank_acc.acc_number,
                dest_name=emp.name,
                amount_cents=amount_cents,
                emp_number=emp_number,
                reference=self.reference,
                value_date=self.payment_date,
                orig_bank=orig_bank_micr or '7056',
                orig_branch=orig_branch,
                orig_acc=orig_acc_number,
                orig_name=orig_name,
            ))

        if not records:
            msg = _('No records could be generated.')
            if errors:
                msg += '\n\n' + '\n'.join(errors)
            raise UserError(msg)

        total_cents = sum(int(round(l.amount * 100)) for l in lines_to_pay)
        summary_cr = 'Cr.%d%d' % (len(records), total_cents)
        summary_dr = 'Dr.1%d' % total_cents

        file_content = '\r\n'.join([summary_cr, summary_dr, ''] + records) + '\r\n'
        file_bytes = file_content.encode('ascii', errors='replace')

        filename = 'PAYMASTER_%s_%s.dat' % (
            self.reference.replace(' ', '_'),
            self.payment_date.strftime('%Y%m%d'),
        )
        attachment = self.env['ir.attachment'].create({
            'name': filename,
            'type': 'binary',
            'datas': base64.b64encode(file_bytes).decode(),
            'mimetype': 'application/octet-stream',
        })

        if errors:
            # Log warnings but still deliver the file
            import logging
            _logger = logging.getLogger(__name__)
            for e in errors:
                _logger.warning('Paymaster warning: %s', e)

        return {
            'type': 'ir.actions.act_url',
            'url': '/web/content/%d?download=true' % attachment.id,
            'target': 'self',
        }


class PaymasterWizardLine(models.TransientModel):
    _name = 'jinasena.paymaster.wizard.line'
    _description = 'Paymaster Wizard Payment Line'

    wizard_id   = fields.Many2one('jinasena.paymaster.wizard', required=True, ondelete='cascade')
    employee_id = fields.Many2one('hr.employee', string='Employee', required=True)
    amount      = fields.Float(string='Amount (J)', digits=(12, 2), default=0.0)

    # ── Internal helper (not shown in list) ───────────────────────────────
    bank_account_id = fields.Many2one(
        'res.partner.bank', compute='_compute_dest_fields', store=False,
    )

    # ── Per-row destination fields (depend on employee) ───────────────────
    # B
    dest_bank_micr = fields.Char(
        string='Dest Bank (B)', compute='_compute_dest_fields', store=False,
        help='4-digit SLIPS bank MICR code',
    )
    # C
    dest_branch = fields.Char(
        string='Dest Branch (C)', compute='_compute_dest_fields', store=False,
        help='3-digit branch code',
    )
    # D
    dest_account = fields.Char(
        string='Dest Account (D)', compute='_compute_dest_fields', store=False,
        help='Destination account number up to 12 digits',
    )
    # E  (employee_id.name serves as Destination Account Name)
    # P
    particulars = fields.Char(
        string='Particulars (P)', compute='_compute_dest_fields', store=False,
        help='Employee number / barcode',
    )

    # ── Batch-level fields pulled from wizard (same for every row) ────────
    # F
    trn_code = fields.Char(
        string='TRN Code (F)', compute='_compute_wizard_fields', store=False,
    )
    # G
    return_code = fields.Char(
        string='Return Code (G)', compute='_compute_wizard_fields', store=False,
    )
    # H
    cr_dr_code = fields.Char(
        string='Cr/Dr (H)', compute='_compute_wizard_fields', store=False,
    )
    # I
    return_date = fields.Char(
        string='Return Date (I)', compute='_compute_wizard_fields', store=False,
    )
    # K
    currency_code = fields.Char(
        string='Currency (K)', compute='_compute_wizard_fields', store=False,
    )
    # L
    orig_bank_micr = fields.Char(
        string='Orig Bank (L)', compute='_compute_wizard_fields', store=False,
        help='Originating bank MICR code',
    )
    # M
    orig_branch = fields.Char(
        string='Orig Branch (M)', compute='_compute_wizard_fields', store=False,
    )
    # N
    orig_account = fields.Char(
        string='Orig Account (N)', compute='_compute_wizard_fields', store=False,
    )
    # O
    orig_name = fields.Char(
        string='Orig Name (O)', compute='_compute_wizard_fields', store=False,
    )
    # Q
    reference = fields.Char(
        string='Reference (Q)', compute='_compute_wizard_fields', store=False,
    )
    # R
    value_date = fields.Char(
        string='Value Date (R)', compute='_compute_wizard_fields', store=False,
        help='YYMMDD format',
    )
    # S
    security_field = fields.Char(
        string='Security (S)', compute='_compute_wizard_fields', store=False,
    )
    # T
    filler = fields.Char(
        string='Filler (T)', compute='_compute_wizard_fields', store=False,
    )

    # ─────────────────────────────────────────────────────────────────────

    @api.depends('employee_id')
    def _compute_dest_fields(self):
        for rec in self:
            emp = rec.employee_id
            if not emp:
                rec.bank_account_id = False
                rec.dest_bank_micr  = False
                rec.dest_branch     = False
                rec.dest_account    = False
                rec.particulars     = False
                continue

            partner = emp.address_home_id or emp.address_id
            if partner:
                accounts = self.env['res.partner.bank'].search(
                    [('partner_id', '=', partner.id)], limit=10
                )
                acc = accounts.filtered(lambda b: b.x_branch_code)[:1] or accounts[:1]
            else:
                acc = self.env['res.partner.bank']

            rec.bank_account_id = acc or False
            rec.dest_account    = acc.acc_number if acc else False
            rec.dest_branch     = acc.x_branch_code if acc else False
            rec.dest_bank_micr  = acc.bank_id.x_micr_code if (acc and acc.bank_id) else False
            rec.particulars     = emp.barcode or str(emp.id)

    @api.depends(
        'wizard_id.trn_code', 'wizard_id.return_code', 'wizard_id.cr_dr_code',
        'wizard_id.return_date', 'wizard_id.currency_code',
        'wizard_id.company_account_id', 'wizard_id.company_branch_code',
        'wizard_id.reference', 'wizard_id.payment_date',
    )
    def _compute_wizard_fields(self):
        for rec in self:
            wiz = rec.wizard_id
            orig_acc = wiz.company_account_id

            rec.trn_code      = wiz.trn_code or '23'
            rec.return_code   = wiz.return_code or '00'
            rec.cr_dr_code    = wiz.cr_dr_code or '0'
            rec.return_date   = wiz.return_date or '000000'
            rec.currency_code = wiz.currency_code or 'SLR'
            rec.orig_bank_micr = (
                orig_acc.bank_id.x_micr_code if (orig_acc and orig_acc.bank_id) else False
            )
            rec.orig_branch   = wiz.company_branch_code or False
            rec.orig_account  = orig_acc.acc_number if orig_acc else False
            rec.orig_name     = (
                orig_acc.acc_holder_name or
                (orig_acc.partner_id.name if orig_acc else False)
            )
            rec.reference     = wiz.reference or False
            rec.value_date    = (
                wiz.payment_date.strftime('%y%m%d') if wiz.payment_date else False
            )
            rec.security_field = '      '
            rec.filler         = '@'

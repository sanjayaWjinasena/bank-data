/**
 * Bank Data Gap Analysis
 *
 * Compares the Excel Paymaster file structure against the current
 * Odoo Bank Data report (account.move.line) to identify:
 *   • What Excel fields already have an Odoo column (mapped)
 *   • What Odoo columns are named incorrectly for their purpose
 *   • What Excel fields have NO Odoo field at all (must be created)
 *   • Which existing Odoo fields are empty (data not populated)
 *   • Recommended Studio fields to add / rename
 *
 * All data comes from local JSON files — no Odoo login required.
 *
 * Output:
 *   bank-audit-output/bank-data-gap-analysis.html
 */

import { test } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';

const OUT      = path.join(__dirname, 'results');
const REPORT   = path.join(OUT, 'bank-data-gap-analysis.html');


// ─── Definitions ─────────────────────────────────────────────────────────────

/** Every column in the Excel paymaster file */
const EXCEL_FIELDS: Array<{
  key:         string;
  label:       string;
  type:        string;
  description: string;
  sample:      string;
  isConstant:  boolean;
  constantVal: string;
}> = [
  {
    key: 'emp_id',       label: 'Employee ID',
    type: 'char',
    description: 'Unique employee number used to identify the payee',
    sample: '1101003',
    isConstant: false, constantVal: '',
  },
  {
    key: 'dest_name',    label: 'Beneficiary Name',
    type: 'char',
    description: 'Full name of the payment recipient',
    sample: 'U N D Gunaweera',
    isConstant: false, constantVal: '',
  },
  {
    key: 'dest_account', label: 'Destination Account No.',
    type: 'char',
    description: 'Destination bank account number',
    sample: '850546',
    isConstant: false, constantVal: '',
  },
  {
    key: 'dest_bank',    label: 'Destination Bank MICR',
    type: 'integer',
    description: 'MICR code of the destination bank (e.g. 7010 = BOC)',
    sample: '7010',
    isConstant: false, constantVal: '',
  },
  {
    key: 'dest_branch',  label: 'Destination Branch Code',
    type: 'integer',
    description: 'Branch code of the destination bank',
    sample: '45',
    isConstant: false, constantVal: '',
  },
  {
    key: 'trn_code',     label: 'Transaction Code',
    type: 'integer',
    description: 'Paymaster transaction type code. Always 23 for salary/loan payments.',
    sample: '23',
    isConstant: true, constantVal: '23',
  },
  {
    key: 'cr_dr',        label: 'Credit/Debit Flag',
    type: 'integer',
    description: 'Credit=0, Debit=1. Always 0 (credit) for outgoing payments.',
    sample: '0',
    isConstant: true, constantVal: '0',
  },
  {
    key: 'amount_rs',    label: 'Amount (Rs)',
    type: 'float',
    description: 'Payment amount in Sri Lankan Rupees',
    sample: '35000.00',
    isConstant: false, constantVal: '',
  },
  {
    key: 'amount_cents', label: 'Amount (Cents)',
    type: 'integer',
    description: 'Amount × 100 in cents (derived from Amount Rs)',
    sample: '3500000',
    isConstant: false, constantVal: '= amount_rs × 100',
  },
  {
    key: 'currency',     label: 'Currency',
    type: 'char',
    description: 'Currency code. Always SLR.',
    sample: 'SLR',
    isConstant: true, constantVal: 'SLR',
  },
  {
    key: 'orig_bank',    label: 'Originating Bank MICR',
    type: 'integer',
    description: 'MICR code of Jinasena\'s own bank (Commercial Bank = 7056)',
    sample: '7056',
    isConstant: true, constantVal: '7056',
  },
  {
    key: 'orig_branch',  label: 'Originating Branch',
    type: 'integer',
    description: 'Branch code of Jinasena\'s bank account',
    sample: '3 or 50',
    isConstant: false, constantVal: '',
  },
  {
    key: 'orig_account', label: 'Originating Account No.',
    type: 'char',
    description: 'Jinasena\'s own account number that funds are debited from',
    sample: '1500001888',
    isConstant: true, constantVal: '1500001888',
  },
  {
    key: 'orig_name',    label: 'Originating Name',
    type: 'char',
    description: 'Name of the sending organisation',
    sample: 'Jinasena (Pvt) Ltd',
    isConstant: true, constantVal: 'Jinasena (Pvt) Ltd',
  },
  {
    key: 'reference',    label: 'Payment Reference',
    type: 'char',
    description: 'Batch/payment reference string (e.g. LoanInsJUNE2025)',
    sample: 'LoanInsJUNE2025',
    isConstant: false, constantVal: '',
  },
  {
    key: 'value_date',   label: 'Value Date',
    type: 'char',
    description: 'Effective date in DDMMYY format (e.g. 250725 = 25 Jul 2025)',
    sample: '250725',
    isConstant: false, constantVal: '',
  },
];

/** Current Odoo Bank Data view columns (account.move.line) */
const ODOO_COLUMNS: Array<{
  field:       string;
  label:       string;
  ttype:       string;
  isStudio:    boolean;
  isReadonly:  boolean;
  isEmpty:     boolean;   // all records have false/null for this field
  note:        string;
}> = [
  {
    field: 'x_studio_to_account',      label: 'To Account',
    ttype: 'char', isStudio: true, isReadonly: true, isEmpty: true,
    note: 'Destination bank account number — linked from payslip/employee bank',
  },
  {
    field: 'amount_currency',           label: 'Amount',
    ttype: 'monetary', isStudio: false, isReadonly: false, isEmpty: false,
    note: 'Standard Odoo monetary field — populated from journal entry',
  },
  {
    field: 'x_studio_beneficiary_name', label: 'Beneficiary Name',
    ttype: 'char', isStudio: true, isReadonly: true, isEmpty: true,
    note: 'Employee/beneficiary full name — linked from payslip',
  },
  {
    field: 'x_studio_beneficiary_id',   label: 'Beneficiary ID',
    ttype: 'char', isStudio: true, isReadonly: true, isEmpty: true,
    note: 'Employee ID/number — linked from payslip',
  },
  {
    field: 'x_studio_swift_code',       label: 'Swift Code',
    ttype: 'char', isStudio: true, isReadonly: true, isEmpty: true,
    note: 'LABELLED as Swift Code but intended for bank MICR. Naming conflict.',
  },
  {
    field: 'x_studio_purpose_code',     label: 'Purpose Code',
    ttype: 'char', isStudio: true, isReadonly: true, isEmpty: true,
    note: 'Unclear purpose — may be reference or transaction code',
  },
];

/** Standard account.move.line fields useful for paymaster */
const ODOO_STANDARD_USEFUL: Array<{
  field:  string;
  label:  string;
  ttype:  string;
  note:   string;
}> = [
  { field: 'partner_id',   label: 'Partner',    ttype: 'many2one', note: 'Beneficiary partner record' },
  { field: 'ref',          label: 'Reference',  ttype: 'char',     note: 'Journal entry reference — could hold payment reference' },
  { field: 'date',         label: 'Date',       ttype: 'date',     note: 'Journal entry date — approximate value date' },
  { field: 'currency_id',  label: 'Currency',   ttype: 'many2one', note: 'Payment currency (SLR)' },
  { field: 'company_id',   label: 'Company',    ttype: 'many2one', note: 'Originating company (Jinasena)' },
  { field: 'move_id',      label: 'Journal Entry', ttype: 'many2one', note: 'Parent journal entry — has ref, date, amount' },
  { field: 'name',         label: 'Label',      ttype: 'char',     note: 'Line description/label' },
];

// ─── Mapping table ────────────────────────────────────────────────────────────

type MapStatus = 'MAPPED' | 'PARTIAL' | 'WRONG' | 'MISSING' | 'DERIVED' | 'CONSTANT';

interface FieldMapping {
  excelKey:     string;
  excelLabel:   string;
  odooField:    string;
  odooLabel:    string;
  status:       MapStatus;
  statusNote:   string;
  action:       string;
}

const MAPPING: FieldMapping[] = [
  {
    excelKey: 'emp_id',       excelLabel: 'Employee ID',
    odooField: 'x_studio_beneficiary_id', odooLabel: 'Beneficiary ID',
    status: 'PARTIAL',
    statusNote: 'Field exists but is labelled "Beneficiary ID" — should be renamed to "Employee ID". Currently empty (not populated).',
    action: 'Rename x_studio_beneficiary_id → "Employee ID". Populate via payslip link.',
  },
  {
    excelKey: 'dest_name',    excelLabel: 'Beneficiary Name',
    odooField: 'x_studio_beneficiary_name', odooLabel: 'Beneficiary Name',
    status: 'MAPPED',
    statusNote: 'Field and label match correctly. Currently empty — needs data population.',
    action: 'Populate via payslip → employee name link.',
  },
  {
    excelKey: 'dest_account', excelLabel: 'Destination Account No.',
    odooField: 'x_studio_to_account', odooLabel: 'To Account',
    status: 'MAPPED',
    statusNote: 'Field matches. Currently empty — needs data from employee\'s bank account.',
    action: 'Populate via payslip → employee → bank account number.',
  },
  {
    excelKey: 'dest_bank',    excelLabel: 'Destination Bank MICR',
    odooField: 'x_studio_swift_code', odooLabel: 'Swift Code',
    status: 'WRONG',
    statusNote: 'Field is labelled "Swift Code" but paymaster needs MICR code (e.g. 7010), not SWIFT/BIC. These are different values. Currently empty.',
    action: 'Rename x_studio_swift_code to "Dest Bank MICR Code". Populate from res.bank.x_micr_code via employee bank account.',
  },
  {
    excelKey: 'dest_branch',  excelLabel: 'Destination Branch Code',
    odooField: '—',           odooLabel: '—',
    status: 'MISSING',
    statusNote: 'No field exists in Odoo for destination branch code.',
    action: 'Create new Studio field: x_studio_dest_branch (Integer) "Destination Branch Code". Populate from res.partner.bank.x_branch_code.',
  },
  {
    excelKey: 'trn_code',     excelLabel: 'Transaction Code',
    odooField: '—',           odooLabel: '—',
    status: 'CONSTANT',
    statusNote: 'Always 23 for paymaster payments. No Odoo field exists.',
    action: 'Create new Studio field: x_studio_trn_code (Integer, default=23) "Transaction Code". OR hard-code 23 in the file generator.',
  },
  {
    excelKey: 'cr_dr',        excelLabel: 'Credit/Debit Flag',
    odooField: '—',           odooLabel: '—',
    status: 'CONSTANT',
    statusNote: 'Always 0 (credit payment). No Odoo field exists.',
    action: 'Hard-code 0 in the file generator — no Studio field needed.',
  },
  {
    excelKey: 'amount_rs',    excelLabel: 'Amount (Rs)',
    odooField: 'amount_currency', odooLabel: 'Amount',
    status: 'MAPPED',
    statusNote: 'Standard monetary field — populated from journal entry amount.',
    action: 'No action — use amount_currency directly.',
  },
  {
    excelKey: 'amount_cents', excelLabel: 'Amount (Cents)',
    odooField: '—',           odooLabel: '—',
    status: 'DERIVED',
    statusNote: 'Derived value: amount_rs × 100. No separate Odoo field needed.',
    action: 'Calculate in file generator: amount_currency × 100.',
  },
  {
    excelKey: 'currency',     excelLabel: 'Currency',
    odooField: 'currency_id', odooLabel: 'Currency',
    status: 'MAPPED',
    statusNote: 'Standard currency field. Always SLR.',
    action: 'Use currency_id.name directly.',
  },
  {
    excelKey: 'orig_bank',    excelLabel: 'Originating Bank MICR',
    odooField: '—',           odooLabel: '—',
    status: 'CONSTANT',
    statusNote: 'Always 7056 (Commercial Bank). No Odoo field exists.',
    action: 'Create Studio field x_studio_orig_bank (Integer) "Orig Bank MICR" on journal/company. OR hard-code 7056 in file generator.',
  },
  {
    excelKey: 'orig_branch',  excelLabel: 'Originating Branch',
    odooField: '—',           odooLabel: '—',
    status: 'MISSING',
    statusNote: 'No Odoo field. Value varies (3 or 50 seen in Excel).',
    action: 'Create Studio field x_studio_orig_branch (Integer) "Orig Branch Code". Set on journal entry or company bank account.',
  },
  {
    excelKey: 'orig_account', excelLabel: 'Originating Account No.',
    odooField: '—',           odooLabel: '—',
    status: 'CONSTANT',
    statusNote: 'Always 1500001888 (Jinasena Commercial Bank account). No Odoo field.',
    action: 'This is the company\'s own bank account. Already exists in res.partner.bank. Hard-code or link from journal.',
  },
  {
    excelKey: 'orig_name',    excelLabel: 'Originating Name',
    odooField: 'company_id',  odooLabel: 'Company',
    status: 'PARTIAL',
    statusNote: 'Company name is available via company_id.name. Value in Excel is "Jinasena (Pvt) Ltd" (shortened from full name).',
    action: 'Use company_id.name OR add a "Short Name" field on res.company. Hard-code in file generator for now.',
  },
  {
    excelKey: 'reference',    excelLabel: 'Payment Reference',
    odooField: 'ref',         odooLabel: 'Reference',
    status: 'PARTIAL',
    statusNote: 'Standard ref field exists but is the journal entry reference. May not match paymaster reference. x_studio_purpose_code could also serve this.',
    action: 'Clarify whether x_studio_purpose_code = payment reference. If yes, rename to "Payment Reference". Otherwise use ref.',
  },
  {
    excelKey: 'value_date',   excelLabel: 'Value Date',
    odooField: 'date',        odooLabel: 'Date',
    status: 'PARTIAL',
    statusNote: 'Standard date field exists. Format must be converted from Odoo YYYY-MM-DD to paymaster DDMMYY.',
    action: 'Use date field + convert format in file generator.',
  },
];

// ─── Stats ────────────────────────────────────────────────────────────────────

const counts = {
  MAPPED:   MAPPING.filter(m => m.status === 'MAPPED').length,
  PARTIAL:  MAPPING.filter(m => m.status === 'PARTIAL').length,
  WRONG:    MAPPING.filter(m => m.status === 'WRONG').length,
  MISSING:  MAPPING.filter(m => m.status === 'MISSING').length,
  DERIVED:  MAPPING.filter(m => m.status === 'DERIVED').length,
  CONSTANT: MAPPING.filter(m => m.status === 'CONSTANT').length,
};

const needsNewField  = MAPPING.filter(m => m.status === 'MISSING');
const needsFix       = MAPPING.filter(m => m.status === 'WRONG' || m.status === 'PARTIAL');
const readyFields    = MAPPING.filter(m => m.status === 'MAPPED');
const hardCodeFields = MAPPING.filter(m => m.status === 'CONSTANT' || m.status === 'DERIVED');

// ─── Build report ─────────────────────────────────────────────────────────────

test('Bank Data Gap Analysis', async () => {
  test.setTimeout(10_000);

  // Summary output
  console.log('\n  Excel fields:     ' + EXCEL_FIELDS.length);
  console.log('  Odoo columns:     ' + ODOO_COLUMNS.length);
  console.log('  Fully mapped:     ' + counts.MAPPED);
  console.log('  Partial/unclear:  ' + counts.PARTIAL);
  console.log('  Wrong field name: ' + counts.WRONG);
  console.log('  Missing (no field):' + counts.MISSING);
  console.log('  Derived/constant: ' + (counts.DERIVED + counts.CONSTANT));

  // ── Status badge color helper ──────────────────────────────────────────────
  function statusBadge(s: MapStatus): string {
    const cfg: Record<MapStatus, { bg: string; fg: string; icon: string }> = {
      MAPPED:   { bg: '#052e16', fg: '#4ade80', icon: '✔' },
      PARTIAL:  { bg: '#1c1407', fg: '#fbbf24', icon: '⚠' },
      WRONG:    { bg: '#2d0707', fg: '#f87171', icon: '✘' },
      MISSING:  { bg: '#2d0707', fg: '#f87171', icon: '✘' },
      DERIVED:  { bg: '#0c1a2e', fg: '#60a5fa', icon: '↗' },
      CONSTANT: { bg: '#0c1a2e', fg: '#60a5fa', icon: '⬡' },
    };
    const c = cfg[s];
    return `<span style="background:${c.bg};color:${c.fg};padding:2px 10px;border-radius:4px;font-weight:700;font-size:11px;white-space:nowrap">${c.icon} ${s}</span>`;
  }

  // ── Mapping table rows ─────────────────────────────────────────────────────
  const mapRows = MAPPING.map(m => {
    const exDef = EXCEL_FIELDS.find(f => f.key === m.excelKey)!;
    const rowBg = m.status === 'MAPPED'   ? '#0a1a0f' :
                  m.status === 'PARTIAL'  ? '#181208' :
                  m.status === 'WRONG'    ? '#1a0a0a' :
                  m.status === 'MISSING'  ? '#1a0a0a' : '#0a0f1a';
    return `<tr style="background:${rowBg};border-bottom:1px solid #1e293b">
      <td style="padding:8px 12px">
        <div style="font-weight:700;color:#e2e8f0">${m.excelLabel}</div>
        <div style="font-family:monospace;color:#64748b;font-size:11px">${m.excelKey}</div>
        ${exDef.isConstant ? `<div style="color:#60a5fa;font-size:10px">constant: ${exDef.constantVal}</div>` : ''}
      </td>
      <td style="padding:8px 12px;font-size:12px;color:#94a3b8">${exDef.type}</td>
      <td style="padding:8px 12px;font-family:monospace;color:#fbbf24;font-size:11px">${exDef.sample}</td>
      <td style="padding:8px 12px">
        ${m.odooField !== '—'
          ? `<div style="font-family:monospace;color:#60a5fa;font-size:11px">${m.odooField}</div>
             <div style="color:#94a3b8;font-size:11px">${m.odooLabel}</div>`
          : `<span style="color:#475569;font-size:12px">— no field —</span>`
        }
      </td>
      <td style="padding:8px 12px">${statusBadge(m.status)}</td>
      <td style="padding:8px 12px;font-size:12px;color:#94a3b8">${m.statusNote}</td>
      <td style="padding:8px 12px;font-size:12px;color:#e2e8f0">${m.action}</td>
    </tr>`;
  }).join('');

  // ── New fields table ───────────────────────────────────────────────────────
  const newFieldSuggestions: Array<{
    excelField:  string;
    suggested:   string;
    label:       string;
    type:        string;
    populate:    string;
  }> = [
    {
      excelField: 'dest_branch',
      suggested:  'x_studio_dest_branch',
      label:      'Destination Branch Code',
      type:       'Integer',
      populate:   'Link from hr.payslip → employee → bank account → res.partner.bank.x_branch_code',
    },
    {
      excelField: 'orig_branch',
      suggested:  'x_studio_orig_branch',
      label:      'Originating Branch Code',
      type:       'Integer',
      populate:   'Set on the payroll journal or company bank account (res.partner.bank)',
    },
    {
      excelField: 'trn_code',
      suggested:  'x_studio_trn_code',
      label:      'Transaction Code',
      type:       'Integer (default 23)',
      populate:   'Hard-code 23 on creation, or set as default on the Bank Data action',
    },
  ];

  const renameActions: Array<{
    current:  string;
    newName:  string;
    why:      string;
  }> = [
    {
      current: 'x_studio_swift_code → "Swift Code"',
      newName: '"Dest Bank MICR Code"',
      why:     'Swift/BIC codes are alphanumeric (e.g. CCEYLKLX). MICR codes are numeric (7010, 7056). The field holds MICR, not SWIFT.',
    },
    {
      current: 'x_studio_beneficiary_id → "Beneficiary ID"',
      newName: '"Employee ID / Number"',
      why:     'The Excel emp_id is the employee\'s payroll number. "Beneficiary ID" is ambiguous.',
    },
    {
      current: 'x_studio_purpose_code → "Purpose Code"',
      newName: '"Payment Reference"',
      why:     'The Excel reference field (LoanInsJUNE2025, etc.) is what goes here. "Purpose Code" suggests something like a bank purpose category code.',
    },
  ];

  // ── Odoo columns status ────────────────────────────────────────────────────
  const odooColRows = ODOO_COLUMNS.map(c => {
    const mapped = MAPPING.find(m => m.odooField === c.field);
    const status = c.isEmpty
      ? `<span style="background:#2d0707;color:#f87171;padding:2px 8px;border-radius:4px;font-size:11px">EMPTY</span>`
      : `<span style="background:#052e16;color:#4ade80;padding:2px 8px;border-radius:4px;font-size:11px">HAS DATA</span>`;
    return `<tr style="border-bottom:1px solid #1e293b">
      <td style="padding:8px 12px;font-family:monospace;color:#60a5fa;font-size:12px">${c.field}</td>
      <td style="padding:8px 12px;color:#e2e8f0">${c.label}</td>
      <td style="padding:8px 12px;color:#94a3b8;font-size:12px">${c.ttype}</td>
      <td style="padding:8px 12px">
        <span style="background:${c.isStudio ? '#0c1a2e' : '#1a1a0a'};color:${c.isStudio ? '#60a5fa' : '#fbbf24'};padding:2px 8px;border-radius:4px;font-size:11px">${c.isStudio ? 'Studio' : 'Standard'}</span>
      </td>
      <td style="padding:8px 12px">${status}</td>
      <td style="padding:8px 12px;color:#94a3b8;font-size:12px">${mapped ? mapped.excelLabel : '<span style="color:#475569">not in Excel</span>'}</td>
      <td style="padding:8px 12px;color:#94a3b8;font-size:12px">${c.note}</td>
    </tr>`;
  }).join('');

  // ── HTML ──────────────────────────────────────────────────────────────────
  const html = `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8">
<title>Bank Data Gap Analysis</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:'Segoe UI',system-ui,sans-serif;background:#0f172a;color:#e2e8f0;padding:32px}
  h1{color:#38bdf8;margin-bottom:4px;font-size:22px}
  h2{color:#7dd3fc;font-size:15px;margin:32px 0 12px;border-bottom:1px solid #1e293b;padding-bottom:6px;display:flex;align-items:center;gap:10px}
  h2 .count{background:#1e293b;color:#94a3b8;font-size:12px;padding:2px 10px;border-radius:10px;font-weight:400}
  p.sub{color:#64748b;font-size:12px;margin-bottom:20px}
  .summary{display:flex;flex-wrap:wrap;gap:12px;margin:16px 0 24px}
  .badge{padding:10px 20px;border-radius:8px;font-weight:700;font-size:13px;text-align:center;min-width:130px}
  .b-green {background:#052e16;color:#4ade80;border:1px solid #166534}
  .b-amber {background:#1c1407;color:#fbbf24;border:1px solid #92400e}
  .b-red   {background:#2d0707;color:#f87171;border:1px solid #7f1d1d}
  .b-blue  {background:#0c1a2e;color:#60a5fa;border:1px solid #1e40af}
  table{width:100%;border-collapse:collapse;font-size:12px;margin-bottom:8px}
  th{background:#1e293b;padding:8px 12px;text-align:left;color:#94a3b8;position:sticky;top:0;white-space:nowrap;border-bottom:2px solid #334155}
  tr:hover{filter:brightness(1.15)}
  .scroll{overflow-x:auto;margin-bottom:32px}
  .action-card{background:#1e293b;border-radius:8px;padding:16px 20px;margin-bottom:12px;border-left:4px solid #1e40af}
  .action-card.red{border-left-color:#dc2626}
  .action-card.amber{border-left-color:#d97706}
  .action-card.green{border-left-color:#16a34a}
  .action-card h3{font-size:13px;color:#e2e8f0;margin-bottom:6px;display:flex;align-items:center;gap:8px}
  .action-card p{font-size:12px;color:#94a3b8;margin-top:4px}
  .action-card .tag{font-family:monospace;color:#60a5fa;font-size:11px;background:#0f172a;padding:1px 6px;border-radius:3px}
  .tabs{display:flex;gap:4px;margin-bottom:0;border-bottom:2px solid #1e293b}
  .tab{padding:9px 20px;cursor:pointer;border-radius:6px 6px 0 0;color:#94a3b8;font-size:13px;font-weight:600;background:#1e293b}
  .tab.active{background:#0f172a;color:#38bdf8;border-bottom:2px solid #38bdf8;margin-bottom:-2px}
  .tab-content{display:none;padding-top:20px}
  .tab-content.active{display:block}
</style>
<script>
function showTab(id) {
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
  document.getElementById('tab-'+id).classList.add('active');
  document.getElementById('content-'+id).classList.add('active');
}
</script>
</head><body>

<h1>Bank Data Gap Analysis</h1>
<p class="sub">Generated ${new Date().toLocaleString()} &nbsp;·&nbsp; Excel Paymaster File vs Odoo Bank Data Report (account.move.line)</p>

<!-- Summary Badges -->
<div class="summary">
  <div class="badge b-blue">Excel Fields: ${EXCEL_FIELDS.length}</div>
  <div class="badge b-blue">Odoo Columns: ${ODOO_COLUMNS.length}</div>
  <div class="badge b-green">✔ Fully Mapped: ${counts.MAPPED}</div>
  <div class="badge b-amber">⚠ Partial / Unclear: ${counts.PARTIAL}</div>
  <div class="badge b-red">✘ Wrong Field Name: ${counts.WRONG}</div>
  <div class="badge b-red">✘ Missing (No Field): ${counts.MISSING}</div>
  <div class="badge b-blue">↗ Derived / Constant: ${counts.DERIVED + counts.CONSTANT}</div>
</div>

<!-- Tabs -->
<div class="tabs">
  <div class="tab active" id="tab-mapping"  onclick="showTab('mapping')">Field Mapping (${MAPPING.length})</div>
  <div class="tab"        id="tab-odoo"     onclick="showTab('odoo')">Current Odoo Columns (${ODOO_COLUMNS.length})</div>
  <div class="tab"        id="tab-actions"  onclick="showTab('actions')">Required Actions</div>
  <div class="tab"        id="tab-excel"    onclick="showTab('excel')">Excel Fields Reference (${EXCEL_FIELDS.length})</div>
</div>

<!-- Tab: Field Mapping -->
<div class="tab-content active" id="content-mapping">
  <div class="scroll"><table>
    <thead><tr>
      <th style="min-width:180px">Excel Field</th>
      <th style="width:70px">Type</th>
      <th style="width:100px">Sample Value</th>
      <th style="min-width:180px">Odoo Field</th>
      <th style="width:110px">Status</th>
      <th style="min-width:260px">Analysis</th>
      <th style="min-width:260px">Recommended Action</th>
    </tr></thead>
    <tbody>${mapRows}</tbody>
  </table></div>
</div>

<!-- Tab: Current Odoo Columns -->
<div class="tab-content" id="content-odoo">
  <p style="color:#64748b;font-size:12px;margin-bottom:12px">
    The Bank Data report currently shows 6 columns on <span style="font-family:monospace;color:#60a5fa">account.move.line</span>.
    All Studio fields are empty — no data has been populated yet.
  </p>
  <div class="scroll"><table>
    <thead><tr>
      <th>Field Name</th>
      <th>Label</th>
      <th>Type</th>
      <th>Origin</th>
      <th>Data Status</th>
      <th>Maps to Excel</th>
      <th>Notes</th>
    </tr></thead>
    <tbody>${odooColRows}</tbody>
  </table></div>
</div>

<!-- Tab: Required Actions -->
<div class="tab-content" id="content-actions">

  <h2>Fields That Must Be Created <span class="count">${needsNewField.length} new Studio fields</span></h2>
  ${newFieldSuggestions.map(f => `
  <div class="action-card red">
    <h3>
      <span style="color:#f87171">NEW FIELD</span>
      <span class="tag">${f.suggested}</span>
      <span style="color:#94a3b8;font-weight:400">→ "${f.label}"</span>
    </h3>
    <p><strong style="color:#e2e8f0">Type:</strong> ${f.type} &nbsp;·&nbsp;
       <strong style="color:#e2e8f0">Excel column:</strong> ${f.excelField}</p>
    <p><strong style="color:#e2e8f0">How to populate:</strong> ${f.populate}</p>
  </div>`).join('')}

  <h2>Fields That Need Renaming / Fixing <span class="count">${needsFix.length} fields</span></h2>
  ${renameActions.map(r => `
  <div class="action-card amber">
    <h3>
      <span style="color:#fbbf24">RENAME</span>
      <span style="color:#94a3b8;font-size:12px;font-weight:400">${r.current}</span>
      <span style="color:#e2e8f0">→</span>
      <span style="color:#4ade80">${r.newName}</span>
    </h3>
    <p>${r.why}</p>
  </div>`).join('')}

  <h2>Fields Already Mapped — Just Need Data Population <span class="count">${readyFields.length} fields</span></h2>
  ${readyFields.map(m => `
  <div class="action-card green">
    <h3>
      <span style="color:#4ade80">POPULATE</span>
      <span class="tag">${m.odooField}</span>
      <span style="color:#94a3b8;font-weight:400">→ "${m.odooLabel}"</span>
    </h3>
    <p>${m.action}</p>
  </div>`).join('')}

  <h2>Fields to Hard-Code / Derive in File Generator <span class="count">${hardCodeFields.length} fields</span></h2>
  ${hardCodeFields.map(m => {
    const exDef = EXCEL_FIELDS.find(f => f.key === m.excelKey)!;
    return `
  <div class="action-card" style="border-left-color:#1e40af">
    <h3>
      <span style="color:#60a5fa">${m.status}</span>
      <span style="color:#94a3b8;font-weight:400;font-size:12px">${m.excelLabel}</span>
      ${exDef.isConstant ? `<span style="color:#4ade80;font-size:12px">= ${exDef.constantVal}</span>` : ''}
    </h3>
    <p>${m.action}</p>
  </div>`;
  }).join('')}

</div>

<!-- Tab: Excel Fields Reference -->
<div class="tab-content" id="content-excel">
  <div class="scroll"><table>
    <thead><tr>
      <th>#</th>
      <th>Field Key</th>
      <th>Label</th>
      <th>Type</th>
      <th>Sample Value</th>
      <th>Constant?</th>
      <th>Description</th>
    </tr></thead>
    <tbody>
    ${EXCEL_FIELDS.map((f, i) => `
      <tr style="border-bottom:1px solid #1e293b">
        <td style="padding:7px 12px;color:#64748b">${i + 1}</td>
        <td style="padding:7px 12px;font-family:monospace;color:#60a5fa;font-size:12px">${f.key}</td>
        <td style="padding:7px 12px;font-weight:600">${f.label}</td>
        <td style="padding:7px 12px;color:#94a3b8;font-size:12px">${f.type}</td>
        <td style="padding:7px 12px;font-family:monospace;color:#fbbf24;font-size:12px">${f.sample}</td>
        <td style="padding:7px 12px">
          ${f.isConstant
            ? `<span style="background:#0c1a2e;color:#60a5fa;padding:2px 8px;border-radius:4px;font-size:11px">YES: ${f.constantVal}</span>`
            : `<span style="color:#475569;font-size:12px">—</span>`}
        </td>
        <td style="padding:7px 12px;color:#94a3b8;font-size:12px">${f.description}</td>
      </tr>`).join('')}
    </tbody>
  </table></div>
</div>

</body></html>`;

  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(REPORT, html);
  console.log(`\n  Saved: ${REPORT}`);
});

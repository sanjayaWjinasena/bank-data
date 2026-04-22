/**
 * Paymaster Bank Data Report
 *
 * Reads the extracted Excel paymaster data and generates a formatted
 * HTML bank payment report that mirrors the paymaster file structure.
 *
 * Output:
 *   bank-audit-output/paymaster-report.html
 */

import { test } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';

const OUT        = path.join(__dirname, 'results');
const EXCEL_JSON = path.join(__dirname, '../paymaster-gap-analysis/results/excel-paymaster-data.json');
const REPORT     = path.join(OUT, 'paymaster-report.html');

interface PaymasterRecord {
  dest_bank:    number;
  dest_branch:  number;
  dest_account: string;
  dest_name:    string;
  trn_code:     number;
  cr_dr:        number;
  amount_cents: number;
  amount_rs:    number;
  currency:     string;
  orig_bank:    number;
  orig_branch:  number;
  orig_account: string;
  orig_name:    string;
  emp_id:       string;
  reference:    string;
  value_date:   string;
}

// Bank MICR code names (Sri Lanka)
const BANK_NAMES: Record<number, string> = {
  7010: 'BOC – Bank of Ceylon',
  7056: 'Commercial Bank of Ceylon',
  7135: 'Hatton National Bank (HNB)',
  7214: 'National Savings Bank (NSB)',
  7278: 'People\'s Bank',
  7719: 'Sampath Bank',
  7728: 'Seylan Bank',
  7737: 'Nations Trust Bank (NTB)',
  7755: 'DFCC Bank',
};

function fmtAmt(rs: number): string {
  return rs.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function fmtDate(d: string): string {
  // "250725" → "25 Jul 2025"
  if (d.length !== 6) return d;
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const day   = d.substring(0, 2);
  const month = parseInt(d.substring(2, 4), 10);
  const year  = '20' + d.substring(4, 6);
  return `${day} ${months[month - 1] || '?'} ${year}`;
}

test('Paymaster Bank Data Report', async () => {
  test.setTimeout(30_000);

  // ── Load data ─────────────────────────────────────────────────────────────
  const records: PaymasterRecord[] = JSON.parse(fs.readFileSync(EXCEL_JSON, 'utf-8'));

  // ── Summary stats ─────────────────────────────────────────────────────────
  const totalAmt    = records.reduce((s, r) => s + r.amount_rs, 0);
  const uniqueEmps  = new Set(records.map(r => r.emp_id)).size;
  const uniqueBanks = new Map<number, number>();
  for (const r of records) uniqueBanks.set(r.dest_bank, (uniqueBanks.get(r.dest_bank) || 0) + r.amount_rs);
  const valueDate   = fmtDate(records[0]?.value_date || '');
  const reference   = [...new Set(records.map(r => r.reference))].join(', ');
  const origAccount = records[0]?.orig_account || '';
  const origName    = records[0]?.orig_name || '';
  const origBank    = records[0]?.orig_bank || '';
  const origBranch  = records[0]?.orig_branch || '';

  // Group records by destination bank MICR
  const byBank = new Map<number, PaymasterRecord[]>();
  for (const r of records) {
    if (!byBank.has(r.dest_bank)) byBank.set(r.dest_bank, []);
    byBank.get(r.dest_bank)!.push(r);
  }

  // ── Build table rows ───────────────────────────────────────────────────────
  let tableRows = '';
  let seq = 1;
  const sortedBanks = [...byBank.keys()].sort((a, b) => a - b);

  for (const micr of sortedBanks) {
    const bankName = BANK_NAMES[micr] || `Bank MICR ${micr}`;
    const bankRecs = byBank.get(micr)!;
    const bankTotal = bankRecs.reduce((s, r) => s + r.amount_rs, 0);

    // Bank group header
    tableRows += `<tr class="bank-group">
      <td colspan="9" style="padding:8px 14px;background:#0c1a2e;color:#38bdf8;font-weight:700;font-size:13px;border-top:2px solid #1e40af;border-bottom:1px solid #1e293b">
        MICR ${micr} &nbsp;·&nbsp; ${bankName} &nbsp;&nbsp;
        <span style="color:#94a3b8;font-weight:400">${bankRecs.length} payment${bankRecs.length > 1 ? 's' : ''} &nbsp;·&nbsp; Rs ${fmtAmt(bankTotal)}</span>
      </td>
    </tr>`;

    for (const r of bankRecs) {
      tableRows += `<tr style="border-bottom:1px solid #1e293b">
        <td style="padding:6px 14px;color:#64748b;font-family:monospace">${seq++}</td>
        <td style="padding:6px 14px;font-family:monospace;color:#fbbf24">${r.emp_id}</td>
        <td style="padding:6px 14px">${r.dest_name}</td>
        <td style="padding:6px 14px;font-family:monospace">${r.dest_account}</td>
        <td style="padding:6px 14px;font-family:monospace;color:#94a3b8">${r.dest_branch}</td>
        <td style="padding:6px 14px;font-family:monospace;color:#60a5fa">${r.trn_code}</td>
        <td style="padding:6px 14px;color:#94a3b8;font-size:11px">${r.reference}</td>
        <td style="padding:6px 14px;font-family:monospace;color:#4ade80;text-align:right">${fmtAmt(r.amount_rs)}</td>
        <td style="padding:6px 14px;color:#64748b;font-size:11px">${r.currency}</td>
      </tr>`;
    }

    // Bank subtotal row
    tableRows += `<tr style="background:#0c1a2e;border-bottom:2px solid #1e293b">
      <td colspan="7" style="padding:5px 14px;text-align:right;color:#94a3b8;font-size:12px">Subtotal — ${bankName}</td>
      <td style="padding:5px 14px;font-family:monospace;color:#38bdf8;font-weight:700;text-align:right">${fmtAmt(bankTotal)}</td>
      <td></td>
    </tr>`;
  }

  // Grand total row
  tableRows += `<tr style="background:#052e16;border-top:2px solid #4ade80">
    <td colspan="7" style="padding:8px 14px;text-align:right;color:#4ade80;font-weight:700">GRAND TOTAL</td>
    <td style="padding:8px 14px;font-family:monospace;color:#4ade80;font-weight:700;text-align:right">${fmtAmt(totalAmt)}</td>
    <td style="padding:8px 14px;color:#64748b">SLR</td>
  </tr>`;

  // ── Bank summary cards ─────────────────────────────────────────────────────
  const bankCards = sortedBanks.map(micr => {
    const name  = BANK_NAMES[micr] || `MICR ${micr}`;
    const recs  = byBank.get(micr)!;
    const total = recs.reduce((s, r) => s + r.amount_rs, 0);
    const pct   = ((total / totalAmt) * 100).toFixed(1);
    return `<div class="bank-card">
      <div class="micr">${micr}</div>
      <div class="bname">${name}</div>
      <div class="bamt">Rs ${fmtAmt(total)}</div>
      <div class="bpct">${recs.length} payments &nbsp;·&nbsp; ${pct}%</div>
    </div>`;
  }).join('');

  // ── HTML ──────────────────────────────────────────────────────────────────
  const html = `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8">
<title>Paymaster Bank Data Report</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:'Segoe UI',system-ui,sans-serif;background:#0f172a;color:#e2e8f0;padding:32px}
  h1{color:#38bdf8;margin-bottom:4px;font-size:22px}
  h2{color:#7dd3fc;font-size:14px;margin:28px 0 12px;border-bottom:1px solid #1e293b;padding-bottom:6px}
  .sub{color:#64748b;font-size:12px;margin-bottom:20px}
  /* Header block */
  .header-grid{display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:24px}
  .info-box{background:#1e293b;border-radius:8px;padding:16px;border-left:3px solid #1e40af}
  .info-box .label{color:#64748b;font-size:11px;text-transform:uppercase;letter-spacing:.06em;margin-bottom:4px}
  .info-box .value{color:#e2e8f0;font-size:14px;font-weight:600}
  .info-box .value.mono{font-family:monospace;color:#60a5fa}
  /* Summary badges */
  .summary{display:flex;flex-wrap:wrap;gap:12px;margin-bottom:24px}
  .badge{padding:10px 18px;border-radius:6px;font-weight:700;font-size:13px;text-align:center}
  .b-blue{background:#0c1a2e;color:#60a5fa;border:1px solid #1e40af}
  .b-green{background:#052e16;color:#4ade80;border:1px solid #166534}
  .b-amber{background:#1c1407;color:#fbbf24;border:1px solid #92400e}
  /* Bank cards */
  .bank-cards{display:flex;flex-wrap:wrap;gap:12px;margin-bottom:28px}
  .bank-card{background:#1e293b;border-radius:8px;padding:14px 18px;min-width:200px;border-top:3px solid #1e40af}
  .bank-card .micr{font-family:monospace;color:#38bdf8;font-size:18px;font-weight:700}
  .bank-card .bname{color:#94a3b8;font-size:12px;margin:4px 0}
  .bank-card .bamt{color:#4ade80;font-size:15px;font-weight:700;font-family:monospace}
  .bank-card .bpct{color:#64748b;font-size:11px;margin-top:4px}
  /* Table */
  table{width:100%;border-collapse:collapse;font-size:12px}
  th{background:#1e293b;padding:8px 14px;text-align:left;color:#94a3b8;position:sticky;top:0;white-space:nowrap;border-bottom:2px solid #334155}
  th.right{text-align:right}
  tr:hover{background:#1a2744 !important}
  .scroll{overflow-x:auto}
  /* Originating account box */
  .orig-box{background:#1e293b;border-radius:8px;padding:16px 20px;margin-bottom:24px;display:flex;gap:40px;border-left:3px solid #4ade80}
  .orig-box .field{display:flex;flex-direction:column;gap:3px}
  .orig-box .field .lbl{font-size:10px;text-transform:uppercase;letter-spacing:.06em;color:#64748b}
  .orig-box .field .val{font-family:monospace;color:#4ade80;font-size:14px;font-weight:600}
  .orig-box .field .val.sm{color:#94a3b8;font-size:13px}
</style>
</head><body>

<h1>Paymaster Bank Data Report</h1>
<p class="sub">Generated ${new Date().toLocaleString()} &nbsp;·&nbsp; Jinasena Agricultural Machinery (Pvt) Ltd &nbsp;·&nbsp; Value Date: ${valueDate}</p>

<!-- Originating Account -->
<h2>Originating Account</h2>
<div class="orig-box">
  <div class="field"><div class="lbl">Organisation</div><div class="val sm">${origName}</div></div>
  <div class="field"><div class="lbl">Bank MICR</div><div class="val">${origBank}</div></div>
  <div class="field"><div class="lbl">Branch</div><div class="val">${origBranch}</div></div>
  <div class="field"><div class="lbl">Account Number</div><div class="val">${origAccount}</div></div>
  <div class="field"><div class="lbl">Reference</div><div class="val sm">${reference}</div></div>
  <div class="field"><div class="lbl">Value Date</div><div class="val">${valueDate}</div></div>
</div>

<!-- Summary -->
<h2>Summary</h2>
<div class="summary">
  <div class="badge b-blue">Total Payments: ${records.length}</div>
  <div class="badge b-blue">Unique Employees: ${uniqueEmps}</div>
  <div class="badge b-blue">Destination Banks: ${sortedBanks.length}</div>
  <div class="badge b-green">Total Amount: Rs ${fmtAmt(totalAmt)}</div>
  <div class="badge b-amber">TRN Code: ${records[0]?.trn_code ?? 23}</div>
</div>

<!-- Bank Breakdown -->
<h2>Destination Banks</h2>
<div class="bank-cards">${bankCards}</div>

<!-- Payment Detail Table -->
<h2>Payment Details</h2>
<div class="scroll"><table>
  <thead><tr>
    <th style="width:44px">#</th>
    <th>Emp ID</th>
    <th>Beneficiary Name</th>
    <th>Account Number</th>
    <th>Branch</th>
    <th>TRN</th>
    <th>Reference</th>
    <th class="right">Amount (Rs)</th>
    <th>CCY</th>
  </tr></thead>
  <tbody>${tableRows}</tbody>
</table></div>

</body></html>`;

  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(REPORT, html);
  console.log(`\n  Saved: ${REPORT}`);
  console.log(`  ${records.length} payments · Rs ${fmtAmt(totalAmt)} · ${sortedBanks.length} banks`);
});

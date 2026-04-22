/**
 * Paymaster Gap Analysis — Playwright Script
 *
 * Reads the Excel-extracted paymaster data (43 records, 30 employees) and
 * cross-references against live Odoo data to show exactly what is present
 * vs missing to generate the paymaster bank payment file.
 *
 * Data fetched from Odoo via RPC:
 *   • hr.employee        — employee list with all ID / bank account fields
 *   • hr.employee.bank   — direct employee bank account records
 *   • res.partner.bank   — bank account details (acc_number, x_branch_code)
 *   • res.bank           — bank master (name, bic, x_micr_code)
 *   • hr.payslip         — latest net wage per employee
 *
 * Output:
 *   bank-audit-output/paymaster-gap-analysis.html
 *   bank-audit-output/paymaster-gap-analysis.json
 */

import { test, Page } from '@playwright/test';
import * as dotenv from 'dotenv';
import * as fs from 'fs';
import * as path from 'path';
import { login, selectCompany, BASE_URL, sleep } from '../helpers/payroll-helpers';

dotenv.config({ path: path.resolve(__dirname, '../..', '.env') });

// ─── Paths ────────────────────────────────────────────────────────────────────

const OUT        = path.join(__dirname, 'results');
const EXCEL_JSON = path.join(OUT, 'excel-paymaster-data.json');
const REPORT     = path.join(OUT, 'paymaster-gap-analysis.html');
const DATA_JSON  = path.join(OUT, 'paymaster-gap-analysis.json');

// ─── Types ────────────────────────────────────────────────────────────────────

interface ExcelRecord {
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

interface OdooEmployee {
  id:                  number;
  name:                string;
  barcode:             string | false;
  identification_id:   string | false;
  employee_number:     string | false;   // may not exist — handled gracefully
  bank_account_id:     [number, string] | false;
  department_id:       [number, string] | false;
  job_title:           string | false;
  company_id:          [number, string] | false;
}

interface OdooPartnerBank {
  id:              number;
  partner_id:      [number, string] | false;
  acc_number:      string;
  bank_id:         [number, string] | false;
  acc_holder_name: string | false;
  x_branch_code:   string | false;
}

interface OdooBank {
  id:           number;
  name:         string;
  bic:          string | false;
  x_micr_code:  string | false;
}

interface OdooPayslip {
  id:             number;
  employee_id:    [number, string];
  net_wage:       number;
  payslip_run_id: [number, string] | false;
  date_from:      string;
  date_to:        string;
  state:          string;
  number:         string;
}

// ─── RPC helper ──────────────────────────────────────────────────────────────

async function rpc<T>(
  page: Page,
  model: string,
  method: string,
  args: unknown[],
  kwargs: Record<string, unknown> = {}
): Promise<T> {
  const url = `${BASE_URL}/web/dataset/call_kw`;
  return page.evaluate(
    async ({ url, model, method, args, kwargs }) => {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          jsonrpc: '2.0', method: 'call', id: 1,
          params: { model, method, args, kwargs },
        }),
      });
      const json = await res.json();
      if (json.error) throw new Error(JSON.stringify(json.error));
      return json.result;
    },
    { url, model, method, args, kwargs }
  );
}

async function searchRead<T>(
  page: Page,
  model: string,
  domain: unknown[],
  fields: string[],
  extra: Record<string, unknown> = {}
): Promise<T[]> {
  return rpc<T[]>(page, model, 'search_read', [domain], {
    fields,
    limit: 0,
    ...extra,
  });
}

// ─── Activate debug mode ─────────────────────────────────────────────────────

async function activateDebugMode(page: Page) {
  await page.goto(`${BASE_URL}/web?debug=1`, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await sleep(2000);
  console.log('  Debug mode activated via URL');
}

// ─── Discover employee ID fields ──────────────────────────────────────────────

/** Returns the list of x_ prefixed char fields on hr.employee (potential employee-number fields) */
async function getEmployeeCustomFields(page: Page): Promise<string[]> {
  type FieldInfo = { name: string; ttype: string };
  const fields = await searchRead<FieldInfo>(page, 'ir.model.fields', [
    ['model', '=', 'hr.employee'],
    ['ttype', 'in', ['char', 'integer']],
    ['name', 'like', 'x_'],
    ['store', '=', true],
  ], ['name', 'ttype']);
  return fields.map(f => f.name);
}

// ─── Main test ────────────────────────────────────────────────────────────────

test('Paymaster Gap Analysis', async ({ page }) => {
  test.setTimeout(300_000);

  // ── 1. Load Excel data ─────────────────────────────────────────────────────
  console.log('\n[1] Loading Excel paymaster data...');
  const excelRecords: ExcelRecord[] = JSON.parse(fs.readFileSync(EXCEL_JSON, 'utf-8'));
  const excelEmpIds  = [...new Set(excelRecords.map(r => r.emp_id))];
  const uniqueBanks  = [...new Set(excelRecords.map(r => r.dest_bank))];
  console.log(`    ${excelRecords.length} records, ${excelEmpIds.length} unique employees`);
  console.log(`    MICR codes in Excel: ${uniqueBanks.join(', ')}`);

  // ── 2. Login + company + debug ─────────────────────────────────────────────
  console.log('\n[2] Logging in...');
  await login(page);
  await selectCompany(page);
  await activateDebugMode(page);

  // ── 3. Discover custom employee ID fields ──────────────────────────────────
  console.log('\n[3] Discovering hr.employee custom fields...');
  const customEmpFields = await getEmployeeCustomFields(page);
  console.log(`    Custom x_ fields: [${customEmpFields.join(', ')}]`);

  // ── 4. Fetch Odoo employees ────────────────────────────────────────────────
  console.log('\n[4] Fetching hr.employee records...');
  const baseEmpFields = ['name', 'barcode', 'identification_id', 'bank_account_id',
                         'department_id', 'job_title', 'company_id', 'active'];
  const allEmpFields  = [...baseEmpFields, ...customEmpFields];

  let employees: OdooEmployee[] = [];
  try {
    employees = await searchRead<OdooEmployee>(
      page, 'hr.employee',
      [['company_id.name', 'ilike', 'Agricultural']],
      allEmpFields
    );
  } catch {
    // Fallback: fetch all employees if company filter fails
    employees = await searchRead<OdooEmployee>(page, 'hr.employee', [], allEmpFields);
  }
  console.log(`    Fetched ${employees.length} employees from Odoo`);

  // ── 5. Fetch hr.employee.bank (dedicated employee bank accounts) ───────────
  console.log('\n[5] Fetching hr.employee.bank records...');
  let empBankLinks: Array<{ id: number; employee_id: [number, string]; bank_account_id: [number, string] | false }> = [];
  try {
    empBankLinks = await searchRead(page, 'hr.employee.bank',
      [], ['employee_id', 'bank_account_id']);
    console.log(`    ${empBankLinks.length} employee bank links`);
  } catch {
    console.log('    hr.employee.bank not accessible — using bank_account_id on hr.employee');
  }

  // ── 6. Fetch res.partner.bank ──────────────────────────────────────────────
  console.log('\n[6] Fetching res.partner.bank records...');
  let partnerBanks: OdooPartnerBank[] = [];
  try {
    partnerBanks = await searchRead<OdooPartnerBank>(
      page, 'res.partner.bank', [],
      ['partner_id', 'acc_number', 'bank_id', 'acc_holder_name', 'x_branch_code']
    );
  } catch {
    // x_branch_code may not exist
    partnerBanks = await searchRead<OdooPartnerBank>(
      page, 'res.partner.bank', [],
      ['partner_id', 'acc_number', 'bank_id', 'acc_holder_name']
    );
  }
  console.log(`    ${partnerBanks.length} bank accounts in res.partner.bank`);

  // ── 7. Fetch res.bank ──────────────────────────────────────────────────────
  console.log('\n[7] Fetching res.bank records...');
  let banks: OdooBank[] = [];
  try {
    banks = await searchRead<OdooBank>(page, 'res.bank', [], ['name', 'bic', 'x_micr_code']);
  } catch {
    banks = await searchRead<OdooBank>(page, 'res.bank', [], ['name', 'bic']);
  }
  console.log(`    ${banks.length} banks in res.bank`);

  // Build lookup maps
  const bankById   = new Map<number, OdooBank>(banks.map(b => [b.id, b]));
  const pbById     = new Map<number, OdooPartnerBank>(partnerBanks.map(pb => [pb.id, pb]));

  // ── 8. Fetch latest payslips ───────────────────────────────────────────────
  console.log('\n[8] Fetching hr.payslip records...');
  const payslips: OdooPayslip[] = await searchRead<OdooPayslip>(
    page, 'hr.payslip',
    [['state', 'in', ['done', 'paid']]],
    ['employee_id', 'net_wage', 'payslip_run_id', 'date_from', 'date_to', 'state', 'number'],
    { order: 'date_to desc', limit: 1000 }
  );
  console.log(`    ${payslips.length} done/paid payslips`);

  // Latest payslip per employee
  const latestPayslip = new Map<number, OdooPayslip>();
  for (const ps of payslips) {
    const empId = ps.employee_id[0];
    if (!latestPayslip.has(empId)) latestPayslip.set(empId, ps);
  }

  // ── 9. Build employee lookup by all ID fields ──────────────────────────────
  console.log('\n[9] Building employee ID lookup maps...');

  // Map: odoo_field_value → employee (for matching Excel emp_id)
  const empByBarcode     = new Map<string, OdooEmployee>();
  const empByIdCard      = new Map<string, OdooEmployee>();
  const empByCustomField = new Map<string, Map<string, OdooEmployee>>();

  for (const emp of employees) {
    if (emp.barcode)           empByBarcode.set(String(emp.barcode).trim(), emp);
    if (emp.identification_id) empByIdCard.set(String(emp.identification_id).trim(), emp);
    for (const cf of customEmpFields) {
      const val = (emp as Record<string, unknown>)[cf];
      if (val && val !== false) {
        if (!empByCustomField.has(cf)) empByCustomField.set(cf, new Map());
        empByCustomField.get(cf)!.set(String(val).trim(), emp);
      }
    }
  }

  function findEmployee(excelId: string): { emp: OdooEmployee | null; matchedField: string } {
    if (empByBarcode.has(excelId))  return { emp: empByBarcode.get(excelId)!, matchedField: 'barcode' };
    if (empByIdCard.has(excelId))   return { emp: empByIdCard.get(excelId)!, matchedField: 'identification_id' };
    for (const [cf, m] of empByCustomField.entries()) {
      if (m.has(excelId)) return { emp: m.get(excelId)!, matchedField: cf };
    }
    return { emp: null, matchedField: 'none' };
  }

  // ── 10. Gap analysis per record ────────────────────────────────────────────
  console.log('\n[10] Running gap analysis...');

  interface RecordAnalysis {
    excel:           ExcelRecord;
    empFound:        boolean;
    matchedField:    string;
    odooEmp:         OdooEmployee | null;
    hasBankAccount:  boolean;
    bankAccountId:   number | null;
    partnerBank:     OdooPartnerBank | null;
    accNumber:       string;
    bankRecord:      OdooBank | null;
    micrCode:        string;
    branchCode:      string;
    micrMatch:       boolean;     // Excel dest_bank == Odoo MICR code
    branchMatch:     boolean;     // Excel dest_branch == Odoo branch code
    accMatch:        boolean;     // Excel dest_account == Odoo acc_number
    hasPayslip:      boolean;
    netWage:         number;
    isComplete:      boolean;
    missingItems:    string[];
  }

  const analysis: RecordAnalysis[] = [];

  for (const rec of excelRecords) {
    const { emp, matchedField } = findEmployee(rec.emp_id);
    const missing: string[] = [];

    if (!emp) missing.push('Employee not found in Odoo');

    // Resolve bank account
    let bankAccId: number | null = null;
    let partnerBank: OdooPartnerBank | null = null;

    if (emp) {
      if (emp.bank_account_id && emp.bank_account_id !== false) {
        bankAccId = emp.bank_account_id[0];
      } else {
        // Check hr.employee.bank links
        const link = empBankLinks.find(l => l.employee_id[0] === emp.id);
        if (link && link.bank_account_id) bankAccId = link.bank_account_id[0];
      }

      if (bankAccId) {
        partnerBank = pbById.get(bankAccId) || null;
      }

      if (!bankAccId)   missing.push('No bank account linked');
      if (!partnerBank) missing.push('Bank account record missing in res.partner.bank');
    }

    const accNumber  = partnerBank?.acc_number || '';
    const branchCode = partnerBank ? String((partnerBank as Record<string, unknown>).x_branch_code || '') : '';

    // Resolve bank / MICR
    let bankRecord: OdooBank | null = null;
    let micrCode = '';
    if (partnerBank && partnerBank.bank_id) {
      bankRecord = bankById.get(partnerBank.bank_id[0]) || null;
      micrCode   = bankRecord ? String((bankRecord as Record<string, unknown>).x_micr_code || '') : '';
    }

    if (!micrCode)   missing.push('Bank MICR code missing in res.bank');
    if (!branchCode) missing.push('Branch code missing in res.partner.bank');
    if (!accNumber)  missing.push('Account number missing');

    // Compare Excel vs Odoo values
    const micrMatch   = micrCode   !== '' && String(rec.dest_bank)   === micrCode.trim();
    const branchMatch = branchCode !== '' && String(rec.dest_branch) === branchCode.trim();
    const accMatch    = accNumber  !== '' && rec.dest_account        === accNumber.trim();

    if (micrCode && !micrMatch)     missing.push(`MICR mismatch: Excel=${rec.dest_bank} vs Odoo=${micrCode}`);
    if (branchCode && !branchMatch) missing.push(`Branch mismatch: Excel=${rec.dest_branch} vs Odoo=${branchCode}`);
    if (accNumber && !accMatch)     missing.push(`Acct# mismatch: Excel=${rec.dest_account} vs Odoo=${accNumber}`);

    // Payslip
    const ps = emp ? latestPayslip.get(emp.id) : undefined;
    if (!ps) missing.push('No completed payslip found');

    analysis.push({
      excel:          rec,
      empFound:       !!emp,
      matchedField,
      odooEmp:        emp,
      hasBankAccount: !!bankAccId,
      bankAccountId:  bankAccId,
      partnerBank,
      accNumber,
      bankRecord,
      micrCode,
      branchCode,
      micrMatch,
      branchMatch,
      accMatch,
      hasPayslip:     !!ps,
      netWage:        ps?.net_wage || 0,
      isComplete:     missing.length === 0,
      missingItems:   missing,
    });
  }

  // ── 11. Summary stats ──────────────────────────────────────────────────────
  const complete   = analysis.filter(a => a.isComplete).length;
  const empFound   = analysis.filter(a => a.empFound).length;
  const hasBankAcc = analysis.filter(a => a.hasBankAccount).length;
  const hasMicr    = analysis.filter(a => a.micrCode !== '').length;
  const hasBranch  = analysis.filter(a => a.branchCode !== '').length;
  const micrMatch  = analysis.filter(a => a.micrMatch).length;

  console.log(`\n  Results:`);
  console.log(`    Total Excel records:       ${excelRecords.length}`);
  console.log(`    Employees found in Odoo:   ${empFound}/${excelRecords.length}`);
  console.log(`    Has bank account:          ${hasBankAcc}/${excelRecords.length}`);
  console.log(`    Has MICR code:             ${hasMicr}/${excelRecords.length}`);
  console.log(`    Has branch code:           ${hasBranch}/${excelRecords.length}`);
  console.log(`    MICR matches Excel:        ${micrMatch}/${excelRecords.length}`);
  console.log(`    Fully complete records:    ${complete}/${excelRecords.length}`);

  // ── 12. Save JSON ──────────────────────────────────────────────────────────
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(DATA_JSON, JSON.stringify({
    generated: new Date().toISOString(),
    summary: { total: excelRecords.length, complete, empFound, hasBankAcc, hasMicr, hasBranch, micrMatch },
    uniqueEmployeesInExcel: excelEmpIds.length,
    customEmpFieldsChecked: customEmpFields,
    odooStats: {
      employees: employees.length,
      partnerBanks: partnerBanks.length,
      banks: banks.length,
      payslips: payslips.length,
    },
    analysis: analysis.map(a => ({
      emp_id:        a.excel.emp_id,
      dest_name:     a.excel.dest_name,
      amount_rs:     a.excel.amount_rs,
      reference:     a.excel.reference,
      empFound:      a.empFound,
      matchedField:  a.matchedField,
      odooName:      a.odooEmp?.name || null,
      hasBankAccount: a.hasBankAccount,
      accNumber:     a.accNumber,
      odooMicr:      a.micrCode,
      excelMicr:     String(a.excel.dest_bank),
      micrMatch:     a.micrMatch,
      odioBranch:    a.branchCode,
      excelBranch:   String(a.excel.dest_branch),
      branchMatch:   a.branchMatch,
      accMatch:      a.accMatch,
      netWage:       a.netWage,
      isComplete:    a.isComplete,
      missingItems:  a.missingItems,
    })),
    banks: banks.map(b => ({
      id: b.id, name: b.name, bic: b.bic,
      x_micr_code: (b as Record<string, unknown>).x_micr_code || null,
    })),
    partnerBanks: partnerBanks.map(pb => ({
      id: pb.id, acc_number: pb.acc_number,
      partner_id: pb.partner_id,
      bank_id: pb.bank_id,
      acc_holder_name: pb.acc_holder_name,
      x_branch_code: (pb as Record<string, unknown>).x_branch_code || null,
    })),
  }, null, 2));
  console.log(`\n  Saved: ${DATA_JSON}`);

  // ── 13. Generate HTML report ───────────────────────────────────────────────
  console.log('\n[13] Generating HTML report...');

  const totalAmt = excelRecords.reduce((s, r) => s + r.amount_rs, 0);
  const completeAmt = analysis.filter(a => a.isComplete).reduce((s, a) => s + a.excel.amount_rs, 0);

  // Table rows for all records
  const recordRows = analysis.map(a => {
    const statusColor = a.isComplete ? '#4ade80' : '#f87171';
    const statusBg    = a.isComplete ? '#052e16' : '#2d0707';
    const statusIcon  = a.isComplete ? '✔' : '✘';

    const cell = (ok: boolean | string, val: string) => {
      const c = ok === true ? '#4ade80' : ok === false ? '#f87171' : '#fbbf24';
      return `<td style="padding:5px 10px;color:${c};font-family:monospace">${val}</td>`;
    };

    const missing = a.missingItems.length > 0
      ? `<ul style="margin:0;padding-left:16px;color:#f87171;font-size:11px">${a.missingItems.map(m => `<li>${m}</li>`).join('')}</ul>`
      : '<span style="color:#4ade80">All data present</span>';

    return `<tr style="background:${statusBg};border-bottom:1px solid #1e293b">
      <td style="padding:5px 10px;color:${statusColor};font-weight:700">${statusIcon}</td>
      <td style="padding:5px 10px;font-family:monospace">${a.excel.emp_id}</td>
      <td style="padding:5px 10px">${a.excel.dest_name}</td>
      <td style="padding:5px 10px;color:#94a3b8;font-size:11px">${a.excel.reference}</td>
      ${cell(a.empFound, a.empFound ? (a.odooEmp?.name || '?') : '❌ Not Found')}
      <td style="padding:5px 10px;color:#64748b;font-size:11px">${a.matchedField !== 'none' ? a.matchedField : '—'}</td>
      ${cell(a.hasBankAccount, a.hasBankAccount ? (a.accNumber || 'linked') : '❌ None')}
      ${cell(a.micrCode !== '', a.micrCode || '❌ Missing')}
      <td style="padding:5px 10px;font-family:monospace;color:#94a3b8">${a.excel.dest_bank}</td>
      ${cell(a.micrMatch, a.micrMatch ? '✔ Match' : a.micrCode ? '✘ Mismatch' : '—')}
      ${cell(a.branchCode !== '', a.branchCode || '❌ Missing')}
      <td style="padding:5px 10px;font-family:monospace;color:#94a3b8">${a.excel.dest_branch}</td>
      ${cell(a.branchMatch, a.branchMatch ? '✔ Match' : a.branchCode ? '✘ Mismatch' : '—')}
      <td style="padding:5px 10px;font-family:monospace;color:#94a3b8">${a.excel.dest_account}</td>
      ${cell(a.accMatch, a.accMatch ? '✔ Match' : a.accNumber ? `✘ ${a.accNumber}` : '❌ Missing')}
      <td style="padding:5px 10px;font-family:monospace;color:#60a5fa">${a.excel.amount_rs.toLocaleString('en-US', { minimumFractionDigits: 2 })}</td>
      <td style="padding:5px 10px">${missing}</td>
    </tr>`;
  }).join('');

  // Employee summary rows (unique employees)
  const empMap = new Map<string, RecordAnalysis[]>();
  for (const a of analysis) {
    if (!empMap.has(a.excel.emp_id)) empMap.set(a.excel.emp_id, []);
    empMap.get(a.excel.emp_id)!.push(a);
  }

  const empRows = [...empMap.entries()].map(([empId, recs]) => {
    const first = recs[0];
    const totalAmt = recs.reduce((s, r) => s + r.excel.amount_rs, 0);
    const allComplete = recs.every(r => r.isComplete);
    const bg = allComplete ? '#052e16' : '#2d0707';
    const ic = allComplete ? '✔' : '✘';
    const c  = allComplete ? '#4ade80' : '#f87171';
    const allMissing = [...new Set(recs.flatMap(r => r.missingItems))];

    return `<tr style="background:${bg};border-bottom:1px solid #1e293b">
      <td style="padding:5px 10px;color:${c};font-weight:700">${ic}</td>
      <td style="padding:5px 10px;font-family:monospace">${empId}</td>
      <td style="padding:5px 10px">${first.odooEmp?.name || first.excel.dest_name}</td>
      <td style="padding:5px 10px;color:${first.empFound ? '#4ade80' : '#f87171'}">${first.empFound ? '✔' : '✘'}</td>
      <td style="padding:5px 10px;color:${first.hasBankAccount ? '#4ade80' : '#f87171'}">${first.hasBankAccount ? first.accNumber : '✘ None'}</td>
      <td style="padding:5px 10px;color:${first.micrCode ? '#4ade80' : '#f87171'};font-family:monospace">${first.micrCode || '✘'}</td>
      <td style="padding:5px 10px;color:${first.branchCode ? '#4ade80' : '#f87171'};font-family:monospace">${first.branchCode || '✘'}</td>
      <td style="padding:5px 10px;font-family:monospace;color:#60a5fa">${totalAmt.toLocaleString('en-US', { minimumFractionDigits: 2 })}</td>
      <td style="padding:5px 10px;font-size:11px;color:#f87171">${allMissing.join(' | ') || '—'}</td>
    </tr>`;
  }).join('');

  // Bank MICR cross-reference
  const bankMicrRows = banks.map(b => {
    const micr = String((b as Record<string, unknown>).x_micr_code || '');
    const inExcel = uniqueBanks.includes(Number(micr));
    const c = inExcel ? '#4ade80' : '#64748b';
    return `<tr style="border-bottom:1px solid #1e293b">
      <td style="padding:5px 10px">${b.name}</td>
      <td style="padding:5px 10px;font-family:monospace;color:#60a5fa">${micr || '—'}</td>
      <td style="padding:5px 10px;font-family:monospace;color:#94a3b8">${b.bic || '—'}</td>
      <td style="padding:5px 10px;color:${c}">${inExcel ? '✔ In Excel' : '—'}</td>
    </tr>`;
  }).join('');

  const html = `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8">
<title>Paymaster Gap Analysis</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:'Segoe UI',system-ui,sans-serif;background:#0f172a;color:#e2e8f0;padding:32px}
  h1{color:#38bdf8;margin-bottom:6px}
  h2{color:#7dd3fc;font-size:15px;margin:28px 0 10px;border-bottom:1px solid #1e293b;padding-bottom:6px}
  p.sub{color:#64748b;font-size:12px;margin-bottom:16px}
  .summary{display:flex;flex-wrap:wrap;gap:12px;margin:16px 0 24px}
  .badge{padding:10px 20px;border-radius:6px;font-weight:700;font-size:13px;min-width:150px;text-align:center}
  .green{background:#052e16;color:#4ade80}
  .red{background:#2d0707;color:#f87171}
  .blue{background:#0c1a2e;color:#60a5fa}
  .amber{background:#1c1407;color:#fbbf24}
  table{width:100%;border-collapse:collapse;font-size:12px;margin-bottom:32px}
  th{background:#1e293b;padding:7px 10px;text-align:left;color:#94a3b8;position:sticky;top:0;white-space:nowrap}
  tr:hover{background:#1e293b !important}
  .scroll-wrap{overflow-x:auto;margin-bottom:32px}
  .tabs{display:flex;gap:4px;margin-bottom:0;border-bottom:2px solid #1e293b}
  .tab{padding:8px 20px;cursor:pointer;border-radius:6px 6px 0 0;color:#94a3b8;font-size:13px;font-weight:600;background:#1e293b}
  .tab.active{background:#0f172a;color:#38bdf8;border-bottom:2px solid #38bdf8;margin-bottom:-2px}
  .tab-content{display:none;padding-top:20px}
  .tab-content.active{display:block}
  .legend{display:flex;gap:16px;margin-bottom:12px;font-size:11px}
  .leg{display:flex;align-items:center;gap:6px}
  .dot{width:10px;height:10px;border-radius:50%}
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

<h1>Paymaster Gap Analysis</h1>
<p class="sub">Generated ${new Date().toLocaleString()} · Jinasena Agricultural Machinery (Pvt) Ltd · Odoo vs Excel Paymaster</p>

<div class="summary">
  <div class="badge blue">Total Records: ${excelRecords.length}</div>
  <div class="badge blue">Total Amount: Rs ${totalAmt.toLocaleString('en-US', { minimumFractionDigits: 2 })}</div>
  <div class="badge ${complete === excelRecords.length ? 'green' : 'red'}">Complete: ${complete}/${excelRecords.length}</div>
  <div class="badge ${completeAmt === totalAmt ? 'green' : 'amber'}">Ready Amount: Rs ${completeAmt.toLocaleString('en-US', { minimumFractionDigits: 2 })}</div>
  <div class="badge ${empFound === excelRecords.length ? 'green' : 'red'}">Employees Found: ${empFound}/${excelRecords.length}</div>
  <div class="badge ${hasBankAcc === excelRecords.length ? 'green' : 'red'}">Has Bank Acct: ${hasBankAcc}/${excelRecords.length}</div>
  <div class="badge ${hasMicr === excelRecords.length ? 'green' : 'red'}">Has MICR: ${hasMicr}/${excelRecords.length}</div>
  <div class="badge ${hasBranch === excelRecords.length ? 'green' : 'red'}">Has Branch: ${hasBranch}/${excelRecords.length}</div>
  <div class="badge ${micrMatch === excelRecords.length ? 'green' : 'amber'}">MICR Match: ${micrMatch}/${excelRecords.length}</div>
</div>

<div class="tabs">
  <div class="tab active" id="tab-records" onclick="showTab('records')">All Records (${excelRecords.length})</div>
  <div class="tab" id="tab-employees" onclick="showTab('employees')">By Employee (${excelEmpIds.length})</div>
  <div class="tab" id="tab-banks" onclick="showTab('banks')">Banks / MICR (${banks.length})</div>
  <div class="tab" id="tab-missing" onclick="showTab('missing')">Missing Data (${excelRecords.length - complete})</div>
</div>

<!-- Tab: All Records -->
<div class="tab-content active" id="content-records">
  <div class="legend">
    <div class="leg"><div class="dot" style="background:#4ade80"></div>Complete / Match</div>
    <div class="leg"><div class="dot" style="background:#f87171"></div>Missing / Mismatch</div>
    <div class="leg"><div class="dot" style="background:#fbbf24"></div>Warning</div>
  </div>
  <div class="scroll-wrap"><table>
    <thead><tr>
      <th>Status</th>
      <th>Emp ID</th>
      <th>Excel Name</th>
      <th>Reference</th>
      <th>Odoo Employee</th>
      <th>Matched Via</th>
      <th>Acct# (Odoo)</th>
      <th>MICR (Odoo)</th>
      <th>MICR (Excel)</th>
      <th>MICR?</th>
      <th>Branch (Odoo)</th>
      <th>Branch (Excel)</th>
      <th>Branch?</th>
      <th>Acct# (Excel)</th>
      <th>Acct?</th>
      <th>Amount (Rs)</th>
      <th>Issues</th>
    </tr></thead>
    <tbody>${recordRows}</tbody>
  </table></div>
</div>

<!-- Tab: By Employee -->
<div class="tab-content" id="content-employees">
  <div class="scroll-wrap"><table>
    <thead><tr>
      <th>Status</th>
      <th>Emp ID</th>
      <th>Name</th>
      <th>In Odoo?</th>
      <th>Bank Acct#</th>
      <th>MICR</th>
      <th>Branch</th>
      <th>Total (Rs)</th>
      <th>Issues</th>
    </tr></thead>
    <tbody>${empRows}</tbody>
  </table></div>
</div>

<!-- Tab: Banks / MICR -->
<div class="tab-content" id="content-banks">
  <p style="color:#64748b;font-size:12px;margin-bottom:12px">
    MICR codes in Excel: <span style="color:#60a5fa;font-family:monospace">${uniqueBanks.join(', ')}</span>
  </p>
  <div class="scroll-wrap"><table>
    <thead><tr>
      <th>Bank Name</th>
      <th>MICR Code (x_micr_code)</th>
      <th>BIC / SWIFT</th>
      <th>In Excel Paymaster?</th>
    </tr></thead>
    <tbody>${bankMicrRows}</tbody>
  </table></div>
  <h2>res.partner.bank Records (${partnerBanks.length})</h2>
  <div class="scroll-wrap"><table>
    <thead><tr>
      <th>ID</th><th>Account Number</th><th>Holder</th><th>Bank</th><th>Branch Code (x_branch_code)</th>
    </tr></thead>
    <tbody>
      ${partnerBanks.map(pb => `<tr style="border-bottom:1px solid #1e293b">
        <td style="padding:5px 10px;color:#64748b">${pb.id}</td>
        <td style="padding:5px 10px;font-family:monospace">${pb.acc_number}</td>
        <td style="padding:5px 10px">${pb.acc_holder_name || '—'}</td>
        <td style="padding:5px 10px;color:#94a3b8">${pb.bank_id ? pb.bank_id[1] : '—'}</td>
        <td style="padding:5px 10px;font-family:monospace;color:${(pb as Record<string,unknown>).x_branch_code ? '#4ade80' : '#f87171'}">${(pb as Record<string,unknown>).x_branch_code || '✘ Empty'}</td>
      </tr>`).join('')}
    </tbody>
  </table></div>
</div>

<!-- Tab: Missing Data -->
<div class="tab-content" id="content-missing">
  <p style="color:#64748b;font-size:12px;margin-bottom:12px">
    ${excelRecords.length - complete} records have missing or mismatched data and cannot be included in the paymaster file without remediation.
  </p>
  <div class="scroll-wrap"><table>
    <thead><tr>
      <th>Emp ID</th>
      <th>Excel Name</th>
      <th>Amount (Rs)</th>
      <th>Missing Items</th>
    </tr></thead>
    <tbody>
      ${analysis.filter(a => !a.isComplete).map(a => `
      <tr style="background:#2d0707;border-bottom:1px solid #1e293b">
        <td style="padding:5px 10px;font-family:monospace">${a.excel.emp_id}</td>
        <td style="padding:5px 10px">${a.excel.dest_name}</td>
        <td style="padding:5px 10px;font-family:monospace;color:#60a5fa">${a.excel.amount_rs.toLocaleString('en-US', { minimumFractionDigits: 2 })}</td>
        <td style="padding:5px 10px">
          <ul style="margin:0;padding-left:16px;color:#fbbf24;font-size:11px">
            ${a.missingItems.map(m => `<li>${m}</li>`).join('')}
          </ul>
        </td>
      </tr>`).join('')}
    </tbody>
  </table></div>
</div>

</body></html>`;

  fs.writeFileSync(REPORT, html);
  console.log(`  Saved: ${REPORT}`);
  console.log('\n  Done.');
});

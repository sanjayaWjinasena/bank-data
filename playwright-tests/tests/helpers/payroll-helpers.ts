/**
 * Shared helpers for Payroll / EPF / ETF Playwright tests
 */
import { Page } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';

export const BASE_URL = (process.env.ODOO_URL || '').replace(/\/$/, '');
export const EMAIL    = process.env.ODOO_EMAIL   || '';
export const PASSWORD = process.env.ODOO_PASSWORD || '';

// Known URLs for Jinasena Agricultural Machinery (cids=2)
export const URLS = {
  payslips: `${BASE_URL}/web#action=1541&model=hr.payslip&view_type=list&cids=2&menu_id=812`,
  etf:      `${BASE_URL}/web#action=2893&model=account.move.line&view_type=list&cids=2&menu_id=1475`,
  epf:      `${BASE_URL}/web#action=2894&model=account.move.line&view_type=list&cids=2&menu_id=1476`,
};

export interface PayslipRow {
  reference:  string;
  employee:   string;
  batchName:  string;
  basicWage:  number;
  grossWage:  number;
  netWage:    number;
  status:     string;   // Draft | Waiting | Done | Paid
}

export interface EtfRow {
  surname:    string;
  initials:   string;
  nicNumber:  string;
  etfNumber:  string;
  amount:     number;
}

export interface EpfRow {
  nicNumber:            string;
  surname:              string;
  initials:             string;
  epfNumber:            string;
  label:                string;
  totalContribution:    number;
  employerContribution: number;
  memberContribution:   number;
  totalEarnings:        number;
}

// ─── Parsing ────────────────────────────────────────────────────────────────

/** Parse "1,191.0000 Rs" or "37,200.0000" → 37200 */
export function parseAmount(raw: string): number {
  const cleaned = raw.replace(/[^\d.-]/g, '');
  return parseFloat(cleaned) || 0;
}

/** Round to 2 decimal places */
export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Check if two amounts are equal within a tolerance (default ±2 Rs for rounding) */
export function withinTolerance(actual: number, expected: number, tol = 2): boolean {
  return Math.abs(actual - expected) <= tol;
}

// ─── Employee matching ───────────────────────────────────────────────────────

/**
 * Match a payslip employee string like "J M C Dilini"
 * against ETF/EPF surname + initials like ("Dilini", "J M C")
 */
export function employeesMatch(payslipEmployee: string, surname: string, initials: string): boolean {
  const full = `${initials.trim()} ${surname.trim()}`.toLowerCase();
  const emp  = payslipEmployee.trim().toLowerCase();
  if (emp === full) return true;
  // Also accept if surname is last word of payslip employee string
  const parts = emp.split(/\s+/);
  return parts[parts.length - 1] === surname.trim().toLowerCase();
}

// ─── Navigation ─────────────────────────────────────────────────────────────

export function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

export async function login(page: Page) {
  await page.goto(`${BASE_URL}/web/login`, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.fill('input[name="login"]',    EMAIL);
  await page.fill('input[name="password"]', PASSWORD);
  await page.click('button:has-text("Log in"), button[type="submit"]:not(.oe_search_button)');
  await page.waitForSelector('.o_main_navbar', { timeout: 20000 });
  await sleep(1500);
}

export async function selectCompany(page: Page) {
  // If already on the right company, skip
  const navText = await page.locator('.o_main_navbar').textContent().catch(() => '');
  if (navText?.includes('Agricultural')) {
    console.log('  Already on Jinasena Agricultural Machinery — skipping switch');
    return;
  }

  // Open the company switcher
  const switcher = page.locator('.o_menu_systray .o_switch_company_menu').first();
  if (!await switcher.isVisible({ timeout: 5000 }).catch(() => false)) {
    console.log('  ⚠ Company switcher not visible — skipping');
    return;
  }
  await switcher.click();
  await sleep(800);

  // Use Playwright text locator — more reliable than CSS :has-text for Odoo dropdowns
  const item = page.getByText(/Agricultural Machinery/i).first();

  if (!await item.isVisible({ timeout: 4000 }).catch(() => false)) {
    // Debug: print what's visible in any dropdown
    const allItems = await page.locator(
      '.o-dropdown--menu li, .dropdown-menu li, .o_switch_company_menu li'
    ).allTextContents().catch(() => []);
    console.log(`  Company dropdown items: [${allItems.map(t => t.trim()).filter(Boolean).join(' | ')}]`);
    // Also try reading the full systray text
    const systrayText = await page.locator('.o_menu_systray').textContent().catch(() => '');
    console.log(`  Systray text: "${systrayText?.trim().substring(0, 120)}"`);
    await page.keyboard.press('Escape');
    console.log('  ⚠ Agricultural Machinery not found in dropdown — skipping switch');
    return;
  }

  // Plain click — don't use Promise.all([waitForNavigation, click]) as it races with Odoo's router
  await item.click();

  // Handle optional Confirm dialog that some Odoo versions show
  await sleep(1500);
  const confirm = page.locator('button:has-text("Confirm"), button:has-text("OK")').first();
  if (await confirm.isVisible({ timeout: 2000 }).catch(() => false)) {
    await confirm.click();
    await sleep(1500);
  }

  // Wait for the app to fully load after reload
  await page.waitForSelector('.o_main_navbar', { timeout: 30000 });
  await sleep(2000);

  const newNav = await page.locator('.o_main_navbar').textContent().catch(() => '');
  if (newNav?.includes('Agricultural')) {
    console.log('  ✔ Switched to Jinasena Agricultural Machinery (Pvt) Ltd');
  } else {
    console.log(`  ⚠ Company switch may have failed — navbar: "${newNav?.trim().substring(0, 60)}"`);
  }
}

export async function goTo(page: Page, url: string) {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await sleep(3000);
}

export async function clearFilters(page: Page) {
  for (let i = 0; i < 8; i++) {
    const x = page.locator('.o_searchview_facet .o_delete, .o_facet_remove').first();
    if (!await x.isVisible({ timeout: 800 }).catch(() => false)) break;
    await x.click(); await sleep(500);
  }
  await sleep(500);
}

export async function expandGroups(page: Page) {
  const headers = page.locator('.o_group_header');
  const n = await headers.count();
  for (let i = 0; i < n; i++) {
    await headers.nth(i).locator('td').first().click({ force: true }).catch(() => {});
    await sleep(400);
  }
}

// ─── Data extraction ─────────────────────────────────────────────────────────

async function getColumns(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll('.o_list_view thead th, .o_list_table thead th'))
      .map(th => (th as HTMLElement).innerText.trim()).filter(Boolean)
  );
}

/** Parse Odoo pager text "1-80 / 85" → { end: 80, total: 85 }.
 *  Returns null if the pager text doesn't match the expected format. */
function parsePager(text: string): { end: number; total: number } | null {
  // Matches "1-80 / 85" or "1 – 80 / 85" or "81-85 / 85"
  const m = text.match(/([\d,]+)\s*[-–]\s*([\d,]+)\s*\/\s*([\d,]+)/);
  if (!m) return null;
  return {
    end:   parseInt(m[2].replace(/,/g, ''), 10),
    total: parseInt(m[3].replace(/,/g, ''), 10),
  };
}

async function getAllRows(page: Page, cols: string[]): Promise<Array<Record<string, string>>> {
  const all: Array<Record<string, string>> = [];

  while (true) {
    const rows: Array<Record<string, string>> = await page.evaluate((columns: string[]) => {
      return Array.from(document.querySelectorAll(
        '.o_list_view tbody tr.o_data_row, .o_list_table tbody tr.o_data_row'
      )).map(row => {
        const obj: Record<string, string> = {};
        Array.from(row.querySelectorAll('td.o_data_cell')).forEach((cell, i) => {
          obj[columns[i] || `col_${i}`] = (cell as HTMLElement).innerText.trim();
        });
        return obj;
      });
    }, cols);
    all.push(...rows);

    // Read pager AFTER collecting this page's rows.
    // "1-80 / 85" → end=80, total=85.  If end >= total we are on the last page.
    const pagerText = await page.locator('.o_pager_counter, .o_pager_value').textContent().catch(() => '');
    const pager = parsePager(pagerText ?? '');
    if (pager) {
      console.log(`    pager: ${pagerText?.trim()} (end=${pager.end}, total=${pager.total})`);
      if (pager.end >= pager.total) break;   // last page — stop
    }

    const next = page.locator('.o_pager_next:not([disabled])').first();
    if (!await next.isVisible({ timeout: 800 }).catch(() => false)) break;
    await next.click(); await sleep(1200);
  }
  return all;
}

export async function fetchPayslips(page: Page): Promise<PayslipRow[]> {
  await goTo(page, URLS.payslips);
  await clearFilters(page);
  await expandGroups(page);
  const cols = await getColumns(page);
  const raw  = await getAllRows(page, cols);
  return raw.map(r => ({
    reference: r['Reference']  || '',
    employee:  r['Employee']   || '',
    batchName: r['Batch Name'] || '',
    basicWage: parseAmount(r['Basic Wage']  || '0'),
    grossWage: parseAmount(r['Gross Wage']  || '0'),
    netWage:   parseAmount(r['Net Wage']    || '0'),
    status:    r['Status']     || '',
  }));
}

export async function fetchEtf(page: Page): Promise<EtfRow[]> {
  await goTo(page, URLS.etf);
  await clearFilters(page);
  const cols = await getColumns(page);
  const raw  = await getAllRows(page, cols);
  return raw.map(r => ({
    surname:   r['Surname']    || '',
    initials:  r['Initials']   || '',
    nicNumber: r['NIC Number'] || '',
    etfNumber: r['ETF Number'] || '',
    amount:    parseAmount(r['Amount'] || '0'),
  }));
}

export async function fetchEpf(page: Page): Promise<EpfRow[]> {
  await goTo(page, URLS.epf);
  await clearFilters(page);
  const cols = await getColumns(page);
  const raw  = await getAllRows(page, cols);
  return raw.map(r => ({
    nicNumber:            r['NIC Number']             || '',
    surname:              r['Surname']                || '',
    initials:             r['Initials']               || '',
    epfNumber:            r['EPF Number']             || '',
    label:                r['Label']                  || '',
    totalContribution:    parseAmount(r['Total Contribution']      || '0'),
    employerContribution: parseAmount(r["Employer's Contribution"] || '0'),
    memberContribution:   parseAmount(r["Member's Contribution"]   || '0'),
    totalEarnings:        parseAmount(r['Total Earnings']          || '0'),
  }));
}

// ─── Report helpers ──────────────────────────────────────────────────────────

export interface TestResult {
  name:    string;
  status:  'PASS' | 'FAIL' | 'WARN';
  detail:  string;
  expected?: string;
  actual?:   string;
}

export function buildHtmlReport(
  title: string,
  results: TestResult[],
  outPath: string
) {
  const pass = results.filter(r => r.status === 'PASS').length;
  const fail = results.filter(r => r.status === 'FAIL').length;
  const warn = results.filter(r => r.status === 'WARN').length;

  const rows = results.map(r => {
    const color = r.status === 'PASS' ? '#4ade80' : r.status === 'FAIL' ? '#f87171' : '#fbbf24';
    const bg    = r.status === 'PASS' ? '#052e16' : r.status === 'FAIL' ? '#2d0707' : '#1c1407';
    return `<tr style="background:${bg}">
      <td style="padding:6px 12px;color:${color};font-weight:700">${r.status}</td>
      <td style="padding:6px 12px">${r.name}</td>
      <td style="padding:6px 12px;color:#94a3b8">${r.detail}</td>
      <td style="padding:6px 12px;color:#60a5fa;font-family:monospace">${r.expected || ''}</td>
      <td style="padding:6px 12px;color:#f87171;font-family:monospace">${r.actual   || ''}</td>
    </tr>`;
  }).join('');

  const html = `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8">
<title>${title}</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:'Segoe UI',system-ui,sans-serif;background:#0f172a;color:#e2e8f0;padding:32px}
  h1{color:#38bdf8;margin-bottom:8px}
  .summary{display:flex;gap:16px;margin:16px 0 24px}
  .badge{padding:8px 20px;border-radius:6px;font-weight:700;font-size:14px}
  .pass{background:#052e16;color:#4ade80} .fail{background:#2d0707;color:#f87171} .warn{background:#1c1407;color:#fbbf24}
  table{width:100%;border-collapse:collapse;font-size:13px}
  th{background:#1e293b;padding:8px 12px;text-align:left;color:#94a3b8;position:sticky;top:0}
  tr{border-bottom:1px solid #1e293b}
  p{color:#64748b;font-size:12px;margin-bottom:16px}
</style></head><body>
<h1>${title}</h1>
<p>Generated ${new Date().toLocaleString()} · Odoo Payroll · Jinasena Agricultural Machinery (Pvt) Ltd</p>
<div class="summary">
  <div class="badge pass">✔ PASS: ${pass}</div>
  <div class="badge fail">✘ FAIL: ${fail}</div>
  <div class="badge warn">⚠ WARN: ${warn}</div>
</div>
<table>
  <thead><tr>
    <th style="width:80px">Status</th>
    <th style="width:300px">Test</th>
    <th>Detail</th>
    <th style="width:180px">Expected</th>
    <th style="width:180px">Actual</th>
  </tr></thead>
  <tbody>${rows}</tbody>
</table>
</body></html>`;

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, html);
}

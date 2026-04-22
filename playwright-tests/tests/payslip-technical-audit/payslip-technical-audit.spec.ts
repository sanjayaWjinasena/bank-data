/**
 * Payslip Technical Audit — Playwright Script
 * Activates debug mode, navigates Payroll list/form views to extract column
 * and field technical names, then collects all payslip-related models/fields/
 * actions/views via RPC.  Also fetches live payslip records cross-referenced
 * with each employee's bank account details and generates a rich HTML report.
 *
 * Sections covered:
 *   Step 1 — Login + company switch (shared helpers)
 *   Step 2 — Activate debug mode via Ctrl+K command palette
 *   Step 3 — Navigate to Payroll → Slips list/form (extract column + field names)
 *   Step 4 — Navigate to Settings → Technical (screenshot proof)
 *   Step 5 — RPC calls for models / fields / actions / views / server actions
 *             + live payslip + bank account data
 *   Step 6 — Generate rich dark-theme HTML report + raw JSON
 *
 * Output:
 *   bank-audit-output/payslip-technical-audit-report.html
 *   bank-audit-output/payslip-technical-audit-data.json
 *   bank-audit-output/screenshots/  (prefixed ps_)
 */

import { test, Page } from '@playwright/test';
import * as dotenv from 'dotenv';
import * as fs from 'fs';
import * as path from 'path';
import { login, selectCompany, BASE_URL, sleep } from '../helpers/payroll-helpers';

dotenv.config({ path: path.resolve(__dirname, '../..', '.env') });

// ─── Output paths ─────────────────────────────────────────────────────────────

const OUT    = path.join(__dirname, 'results');
const SS_DIR = path.join(__dirname, 'screenshots');
const REPORT = path.join(OUT, 'payslip-technical-audit-report.html');
const DATA   = path.join(OUT, 'payslip-technical-audit-data.json');

// ─── RPC types ────────────────────────────────────────────────────────────────

interface IrModel {
  id:        number;
  name:      string;
  model:     string;
  modules:   string;
  info:      string | false;
  transient: boolean;
}

interface IrField {
  id:                number;
  name:              string;
  field_description: string;
  ttype:             string;
  model_id:          [number, string];
  required:          boolean;
  readonly:          boolean;
  store:             boolean;
  help:              string | false;
  related:           string | false;
  compute:           string | false;
  depends:           string | false;
  index:             boolean;
  groups:            string | false;
}

interface IrActionWindow {
  id:               number;
  name:             string;
  res_model:        string;
  view_mode:        string;
  domain:           string | false;
  context:          string | false;
  help:             string | false;
  binding_model_id: [number, string] | false;
  groups_id:        number[];
}

interface IrView {
  id:         number;
  name:       string;
  type:       string;
  model:      string;
  priority:   number;
  inherit_id: [number, string] | false;
  arch:       string;
  active:     boolean;
}

interface IrActionServer {
  id:               number;
  name:             string;
  model_id:         [number, string];
  model_name:       string;
  state:            string;
  code:             string | false;
  binding_model_id: [number, string] | false;
}

interface HrPayslip {
  id:             number;
  name:           string;
  number:         string | false;
  employee_id:    [number, string];
  date_from:      string;
  date_to:        string;
  state:          string;
  basic_wage:     number;
  gross_wage:     number;
  net_wage:       number;
  struct_id:      [number, string] | false;
  payslip_run_id: [number, string] | false;
}

interface HrEmployee {
  id:              number;
  name:            string;
  bank_account_id: [number, string] | false;
  job_title:       string | false;
  department_id:   [number, string] | false;
  company_id:      [number, string] | false;
}

interface ResPartnerBank {
  id:              number;
  partner_id:      [number, string] | false;
  acc_number:      string;
  bank_id:         [number, string] | false;
  acc_holder_name: string | false;
  company_id:      [number, string] | false;
}

interface ColumnInfo {
  label:     string;
  technical: string;
  title:     string;
}

interface FormFieldInfo {
  name:  string;
  label: string;
}

interface AuditData {
  generatedAt:         string;
  columnHeaders:       ColumnInfo[];
  formFields:          FormFieldInfo[];
  models:              IrModel[];
  fields:              IrField[];
  actions:             IrActionWindow[];
  views:               IrView[];
  serverActions:       IrActionServer[];
  payslips:            HrPayslip[];
  employees:           HrEmployee[];
  employeeBankAccounts: ResPartnerBank[];
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function screenshot(page: Page, name: string): Promise<void> {
  fs.mkdirSync(SS_DIR, { recursive: true });
  const safe = name.replace(/[^a-zA-Z0-9_-]/g, '_').substring(0, 80);
  await page.screenshot({ path: path.join(SS_DIR, `${safe}.png`), fullPage: false }).catch(() => {});
  console.log(`  [screenshot] ${safe}.png`);
}

/**
 * Call Odoo's JSON-RPC endpoint from within the browser context.
 * Uses the authenticated session cookie already present in the page.
 */
async function rpc<T = unknown>(
  page: Page,
  model: string,
  method: string,
  args: unknown[],
  kwargs: Record<string, unknown> = {}
): Promise<T> {
  const baseUrl = BASE_URL;
  return page.evaluate(
    async ({ base, model, method, args, kwargs }) => {
      const res = await fetch(`${base}/web/dataset/call_kw`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          jsonrpc: '2.0',
          method:  'call',
          id:      1,
          params:  { model, method, args, kwargs },
        }),
      });
      const json = await res.json();
      if (json.error) throw new Error(JSON.stringify(json.error));
      return json.result;
    },
    { base: baseUrl, model, method, args, kwargs }
  ) as T;
}

/** search_read convenience wrapper — always requests all records (limit 0). */
async function searchRead<T>(
  page: Page,
  model: string,
  domain: unknown[],
  fields: string[],
  order?: string
): Promise<T[]> {
  return rpc<T[]>(page, model, 'search_read', [domain], {
    fields,
    limit: 0,
    order: order ?? 'id asc',
    context: { lang: 'en_US' },
  });
}

// ─── Step 2: Activate debug mode (verbatim from bank-technical-audit.spec.ts) ──

async function activateDebugMode(page: Page): Promise<void> {
  console.log('\n[Step 2] Activating debug mode via Ctrl+K command palette...');

  await page.keyboard.press('Control+k');
  await sleep(1200);

  const paletteSelectors = [
    '.o_command_palette',
    '.o_command_palette_dialog',
    '.modal .o_command_palette_search',
    '[class*="command_palette"]',
  ];
  let paletteFound = false;
  for (const sel of paletteSelectors) {
    if (await page.locator(sel).first().isVisible({ timeout: 2000 }).catch(() => false)) {
      console.log(`  Command palette found: ${sel}`);
      paletteFound = true;
      break;
    }
  }

  if (!paletteFound) {
    console.log('  Command palette not found via Ctrl+K — falling back to direct URL');
    await page.goto(`${BASE_URL}/web?debug=1`, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await sleep(2000);
    await verifyDebugActive(page);
    return;
  }

  const inputSelectors = [
    '.o_command_palette_search input',
    '.o_command_palette input',
    '[class*="command_palette"] input',
    '.modal input[type="text"]',
    '.modal input',
  ];
  let inputFilled = false;
  for (const sel of inputSelectors) {
    const loc = page.locator(sel).first();
    if (await loc.isVisible({ timeout: 1500 }).catch(() => false)) {
      await loc.fill('debug');
      inputFilled = true;
      console.log(`  Typed "debug" into palette input: ${sel}`);
      break;
    }
  }

  if (!inputFilled) {
    await page.keyboard.type('debug');
    console.log('  Typed "debug" via keyboard (no specific input found)');
  }

  await sleep(1000);

  const debugItemSelectors = [
    'button:has-text("Activate the developer mode")',
    '[class*="command"] button:has-text("developer")',
    '.o_command:has-text("developer mode")',
    '.o_command:has-text("Activate")',
    'li:has-text("Activate the developer mode")',
    'li:has-text("developer mode")',
    '[data-command]:has-text("developer")',
  ];

  let debugClicked = false;
  for (const sel of debugItemSelectors) {
    const loc = page.locator(sel).first();
    if (await loc.isVisible({ timeout: 2000 }).catch(() => false)) {
      await loc.click();
      debugClicked = true;
      console.log(`  Clicked debug activation item: ${sel}`);
      break;
    }
  }

  if (!debugClicked) {
    const anyDebugItem = page.locator('text=/activate.*developer/i, text=/enable.*debug/i, text=/debug mode/i').first();
    if (await anyDebugItem.isVisible({ timeout: 2000 }).catch(() => false)) {
      await anyDebugItem.click();
      debugClicked = true;
      console.log('  Clicked debug item via broad text match');
    }
  }

  if (!debugClicked) {
    await page.keyboard.press('Escape');
    await sleep(500);
    console.log('  Debug item not found in palette — falling back to direct URL navigation');
    await page.goto(`${BASE_URL}/web?debug=1`, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await sleep(2000);
  } else {
    try {
      await page.waitForURL(/debug/, { timeout: 10000 });
      console.log('  Page reloaded with debug parameter in URL');
    } catch {
      await sleep(2500);
    }
  }

  await verifyDebugActive(page);
}

async function verifyDebugActive(page: Page): Promise<void> {
  const url = page.url();
  if (url.includes('debug')) {
    console.log(`  Debug mode confirmed via URL: ${url}`);
    return;
  }
  const debugIcon = page.locator('.o_debug_manager, [title*="debug"], [title*="Debug"]').first();
  if (await debugIcon.isVisible({ timeout: 3000 }).catch(() => false)) {
    console.log('  Debug mode confirmed via navbar bug icon');
    return;
  }
  console.log(`  Warning: debug mode unconfirmed — URL: ${url}`);
}

// ─── Step 3: Navigate to Payroll Slips list view + extract column/field names ──

async function extractPayslipViewMetadata(page: Page): Promise<{
  columnHeaders: ColumnInfo[];
  formFields:    FormFieldInfo[];
}> {
  console.log('\n[Step 3] Navigating to Payroll → Slips list view...');

  // Navigate to the payslip list view with debug assets mode
  await page.goto(
    `${BASE_URL}/web?debug=assets#action=1541&model=hr.payslip&view_type=list&cids=2&menu_id=812`,
    { waitUntil: 'domcontentloaded', timeout: 30000 }
  );
  await sleep(3000);

  // Wait for list table to load
  const listSelectors = ['.o_list_view', '.o_list_table', 'table.o_list_table'];
  for (const sel of listSelectors) {
    if (await page.locator(sel).first().isVisible({ timeout: 5000 }).catch(() => false)) {
      console.log(`  List view found: ${sel}`);
      break;
    }
  }

  // If the action ID didn't work, try the canonical payroll URL
  if (!(await page.locator('.o_list_view, .o_list_table').first().isVisible({ timeout: 3000 }).catch(() => false))) {
    console.log('  Trying fallback URL: /odoo/payroll?debug=assets');
    await page.goto(`${BASE_URL}/odoo/payroll?debug=assets`, {
      waitUntil: 'domcontentloaded', timeout: 30000,
    });
    await sleep(3000);
  }

  // ── Remove active groupby/search filters (e.g. "Batch" groupby) ─────────────
  // The default payslips view has a "Batch" groupby that collapses all rows.
  // We remove it so data rows are visible for form-field extraction.
  console.log('  Clearing active search filters/groupby...');
  for (let i = 0; i < 6; i++) {
    const deleteBtn = page.locator(
      '.o_searchview_facet .o_delete, .o_facet_remove, .o_searchview .o_delete'
    ).first();
    if (!await deleteBtn.isVisible({ timeout: 800 }).catch(() => false)) break;
    await deleteBtn.click();
    await sleep(600);
  }
  await sleep(800);

  // ── Expand any remaining group headers ───────────────────────────────────────
  const groupHeaders = page.locator('.o_group_header');
  const groupCount = await groupHeaders.count();
  if (groupCount > 0) {
    console.log(`  Expanding ${groupCount} group(s)...`);
    for (let i = 0; i < groupCount; i++) {
      await groupHeaders.nth(i).locator('td').first().click({ force: true }).catch(() => {});
      await sleep(300);
    }
    await sleep(800);
  }

  await screenshot(page, 'ps_03a_payslip_list_view');

  // Extract column header technical names from th[data-name] in debug mode
  const columnHeaders: ColumnInfo[] = await page.evaluate(() => {
    return Array.from(
      document.querySelectorAll(
        '.o_list_view thead th[data-name], .o_list_table thead th[data-name]'
      )
    ).map(th => ({
      label:     (th as HTMLElement).innerText.trim(),
      technical: (th as HTMLElement).dataset['name'] || '',
      title:     (th as HTMLElement).title || '',
    })).filter(c => c.technical);
  });
  console.log(`  Extracted ${columnHeaders.length} column headers`);

  // Click the first data row to open the payslip form view
  let formFields: FormFieldInfo[] = [];
  const firstRow = page.locator('.o_list_view tbody tr.o_data_row, .o_list_table tbody tr.o_data_row').first();
  if (await firstRow.isVisible({ timeout: 4000 }).catch(() => false)) {
    console.log('  Opening first payslip record for form field extraction...');
    await firstRow.click();
    await sleep(2500);

    // Wait for form view
    await page.locator('.o_form_view, .o_form_sheet').first().isVisible({ timeout: 6000 }).catch(() => {});

    await screenshot(page, 'ps_03b_payslip_form_view');

    // Extract form field technical names from [name] attributes on field widgets
    formFields = await page.evaluate(() => {
      const seen = new Set<string>();
      return Array.from(
        document.querySelectorAll('.o_form_view [name], .o_field_widget[name]')
      ).map(el => ({
        name:  (el as HTMLElement).getAttribute('name') || '',
        label: (
          el.closest('.o_wrap_field, .o_field_widget')
            ?.querySelector('.o_form_label')
            ?.textContent?.trim() ||
          el.closest('.o_setting_box, .o_group')
            ?.querySelector('label')
            ?.textContent?.trim() || ''
        ),
      }))
      .filter(f => {
        if (!f.name || f.name.startsWith('_')) return false;
        if (seen.has(f.name)) return false;
        seen.add(f.name);
        return true;
      });
    });
    console.log(`  Extracted ${formFields.length} form field names`);

    // Navigate back to list
    await page.goBack({ waitUntil: 'domcontentloaded', timeout: 15000 }).catch(async () => {
      await page.goto(
        `${BASE_URL}/web?debug=assets#action=1541&model=hr.payslip&view_type=list&cids=2&menu_id=812`,
        { waitUntil: 'domcontentloaded', timeout: 30000 }
      );
    });
    await sleep(2000);
    await screenshot(page, 'ps_03c_back_to_list');
  } else {
    console.log('  No payslip rows found — skipping form field extraction');
  }

  return { columnHeaders, formFields };
}

// ─── Step 4: Navigate to Settings → Technical (verbatim from bank script) ────

async function navigateToSettingsTechnical(page: Page): Promise<void> {
  console.log('\n[Step 4] Navigating to Settings → Technical...');

  await page.goto(`${BASE_URL}/odoo/settings?debug=1`, {
    waitUntil: 'domcontentloaded',
    timeout: 30000,
  });
  await sleep(2000);

  const techSelectors = [
    '.o_nav_entry:has-text("Technical")',
    'a.o_nav_entry:has-text("Technical")',
    'li.o_nav_entry:has-text("Technical")',
    '.o_settings_container a:has-text("Technical")',
    'nav a:has-text("Technical")',
    '.navbar a:has-text("Technical")',
    'a:has-text("Technical")',
  ];

  let techClicked = false;
  for (const sel of techSelectors) {
    const loc = page.locator(sel).first();
    if (await loc.isVisible({ timeout: 2000 }).catch(() => false)) {
      await loc.click();
      techClicked = true;
      console.log(`  Clicked Technical menu: ${sel}`);
      break;
    }
  }

  if (!techClicked) {
    console.log('  Technical menu not found in Settings — OK, RPC data collection continues');
  } else {
    await sleep(1000);
    await screenshot(page, 'ps_04a_settings_technical_menu');
    await page.keyboard.press('Escape');
    await sleep(500);
  }

  await screenshot(page, 'ps_04b_settings_page_debug');
}

// ─── Step 5: RPC data collection ─────────────────────────────────────────────

async function collectAllPayslipData(page: Page): Promise<Omit<AuditData, 'columnHeaders' | 'formFields' | 'generatedAt'>> {
  console.log('\n[Step 5] Collecting payslip-related data via RPC...');

  // ── 5A: Payslip-related models ──────────────────────────────────────────────
  console.log('  5A: Fetching ir.model (payslip models)...');
  const payslipModels = await searchRead<IrModel>(
    page,
    'ir.model',
    [['model', 'ilike', 'payslip']],
    ['name', 'model', 'modules', 'info', 'transient']
  );
  console.log(`      Found ${payslipModels.length} payslip models`);

  const extraModels = await searchRead<IrModel>(
    page,
    'ir.model',
    [['model', 'in', ['hr.employee', 'res.partner.bank', 'hr.payslip.run', 'hr.contract']]],
    ['name', 'model', 'modules', 'info', 'transient']
  );
  console.log(`      Found ${extraModels.length} extra related models`);

  // Deduplicate models by id
  const modelMap = new Map<number, IrModel>();
  for (const m of [...payslipModels, ...extraModels]) modelMap.set(m.id, m);
  const models = Array.from(modelMap.values()).sort((a, b) => a.model.localeCompare(b.model));
  console.log(`      Deduplicated: ${models.length} unique models`);

  // ── 5B: Fields on payslip models ────────────────────────────────────────────
  console.log('  5B: Fetching ir.model.fields (fields on payslip models)...');
  const payslipFields = await searchRead<IrField>(
    page,
    'ir.model.fields',
    [['model_id.model', 'in', [
      'hr.payslip',
      'hr.payslip.line',
      'hr.payslip.run',
      'hr.payslip.worked_days',
      'hr.payslip.input',
      'hr.employee',
      'res.partner.bank',
    ]]],
    ['name', 'field_description', 'ttype', 'model_id', 'required', 'readonly',
     'store', 'help', 'related', 'compute', 'depends', 'index', 'groups']
  );
  console.log(`      Found ${payslipFields.length} fields from payslip models`);

  const namedFields = await searchRead<IrField>(
    page,
    'ir.model.fields',
    [['name', 'ilike', 'payslip']],
    ['name', 'field_description', 'ttype', 'model_id', 'required', 'readonly',
     'store', 'help', 'related', 'compute', 'depends', 'index', 'groups']
  );
  console.log(`      Found ${namedFields.length} fields named *payslip*`);

  // Merge + deduplicate by id, sort by model then field name
  const fieldMap = new Map<number, IrField>();
  for (const f of [...payslipFields, ...namedFields]) fieldMap.set(f.id, f);
  const fields = Array.from(fieldMap.values()).sort((a, b) => {
    const ma = Array.isArray(a.model_id) ? a.model_id[1] : '';
    const mb = Array.isArray(b.model_id) ? b.model_id[1] : '';
    return ma.localeCompare(mb) || a.name.localeCompare(b.name);
  });
  console.log(`      Deduplicated: ${fields.length} unique fields`);

  // ── 5C: Window actions ───────────────────────────────────────────────────────
  console.log('  5C: Fetching ir.actions.act_window (payslip actions)...');
  const actions = await searchRead<IrActionWindow>(
    page,
    'ir.actions.act_window',
    [['res_model', 'ilike', 'payslip']],
    ['name', 'res_model', 'view_mode', 'domain', 'context', 'help',
     'binding_model_id', 'groups_id']
  );
  console.log(`      Found ${actions.length} window actions`);

  // ── 5D: Views (no 'module' field — not in Odoo 17 ir.ui.view) ───────────────
  console.log('  5D: Fetching ir.ui.view (payslip views)...');
  const views = await searchRead<IrView>(
    page,
    'ir.ui.view',
    [['model', 'ilike', 'payslip']],
    ['name', 'type', 'model', 'priority', 'inherit_id', 'arch', 'active']
  );
  console.log(`      Found ${views.length} views`);

  // ── 5E: Server actions ───────────────────────────────────────────────────────
  console.log('  5E: Fetching ir.actions.server (payslip server actions)...');
  const serverActions = await searchRead<IrActionServer>(
    page,
    'ir.actions.server',
    [['model_name', 'ilike', 'payslip']],
    ['name', 'model_id', 'model_name', 'state', 'code', 'binding_model_id']
  ).catch(async () => {
    console.log('      Retrying server actions with model_id.model domain...');
    return searchRead<IrActionServer>(
      page,
      'ir.actions.server',
      [['model_id.model', 'ilike', 'payslip']],
      ['name', 'model_id', 'model_name', 'state', 'code', 'binding_model_id']
    );
  });
  console.log(`      Found ${serverActions.length} server actions`);

  // ── 5F: Live payslip + bank account data ─────────────────────────────────────
  console.log('  5F: Fetching live hr.payslip records...');
  const payslips = await searchRead<HrPayslip>(
    page,
    'hr.payslip',
    [['company_id.name', 'ilike', 'Jinasena']],
    ['name', 'number', 'employee_id', 'date_from', 'date_to', 'state',
     'basic_wage', 'gross_wage', 'net_wage', 'struct_id', 'payslip_run_id'],
    'date_from desc'
  ).catch(async () => {
    // Fallback: some Odoo 17 installations use different wage field names
    console.log('      Retrying payslips without wage fields...');
    return searchRead<HrPayslip>(
      page,
      'hr.payslip',
      [['company_id.name', 'ilike', 'Jinasena']],
      ['name', 'number', 'employee_id', 'date_from', 'date_to', 'state',
       'struct_id', 'payslip_run_id'],
      'date_from desc'
    );
  });
  console.log(`      Found ${payslips.length} payslip records`);

  console.log('  5F: Fetching res.partner.bank (employee bank accounts)...');
  const employeeBankAccounts = await searchRead<ResPartnerBank>(
    page,
    'res.partner.bank',
    [],
    ['partner_id', 'acc_number', 'bank_id', 'acc_holder_name', 'company_id']
  );
  console.log(`      Found ${employeeBankAccounts.length} bank accounts`);

  console.log('  5F: Fetching hr.employee records...');
  const employees = await searchRead<HrEmployee>(
    page,
    'hr.employee',
    [],
    ['name', 'bank_account_id', 'job_title', 'department_id', 'company_id']
  );
  console.log(`      Found ${employees.length} employees`);

  return {
    models,
    fields,
    actions,
    views,
    serverActions,
    payslips,
    employees,
    employeeBankAccounts,
  };
}

// ─── Step 6: HTML report builder ─────────────────────────────────────────────

/** Escape HTML entities to prevent XSS in the report. */
function esc(s: unknown): string {
  if (s === null || s === undefined || s === false) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Colour-coded badge for Odoo field types. */
function fieldTypeBadge(ttype: string): string {
  const colours: Record<string, string> = {
    char:       '#3b82f6',
    text:       '#eab308',
    html:       '#ca8a04',
    many2one:   '#8b5cf6',
    one2many:   '#f97316',
    many2many:  '#ef4444',
    boolean:    '#22c55e',
    integer:    '#14b8a6',
    float:      '#0d9488',
    monetary:   '#06b6d4',
    date:       '#6366f1',
    datetime:   '#4f46e5',
    binary:     '#6b7280',
    selection:  '#d97706',
    reference:  '#c026d3',
    serialized: '#78716c',
    json:       '#78716c',
  };
  const bg = colours[ttype] ?? '#475569';
  return `<span style="background:${bg};color:#fff;padding:2px 7px;border-radius:4px;font-size:11px;font-weight:600;white-space:nowrap">${esc(ttype)}</span>`;
}

/** Small badge for boolean flags (required, readonly, etc.) */
function boolBadge(val: boolean, trueLabel: string, trueColor: string): string {
  if (!val) return '';
  return `<span style="background:${trueColor};color:#fff;padding:1px 6px;border-radius:4px;font-size:10px;font-weight:600">${trueLabel}</span>`;
}

// ── Tab 1: Payslips + Bank Data ────────────────────────────────────────────────

function buildPayslipBankTable(
  payslips:            HrPayslip[],
  employees:           HrEmployee[],
  employeeBankAccounts: ResPartnerBank[]
): string {
  // Build lookup maps
  // employee.bank_account_id is a direct many2one to res.partner.bank
  const employeeById = new Map<number, HrEmployee>();
  const bankById     = new Map<number, ResPartnerBank>();

  for (const emp of employees) employeeById.set(emp.id, emp);
  for (const bank of employeeBankAccounts) bankById.set(bank.id, bank);

  // Summary stats
  const employeeIds = new Set(payslips.map(p => Array.isArray(p.employee_id) ? p.employee_id[0] : 0));
  let withBank = 0;
  for (const empId of employeeIds) {
    const emp = employeeById.get(empId);
    if (emp && Array.isArray(emp.bank_account_id)) withBank++;
  }
  const withoutBank = employeeIds.size - withBank;

  const summaryHtml = `
    <div style="display:flex;gap:14px;flex-wrap:wrap;margin-bottom:20px">
      <div style="background:#1e293b;border:1px solid #334155;border-top:3px solid #38bdf8;border-radius:10px;padding:14px 22px;min-width:120px;text-align:center">
        <div style="font-size:28px;font-weight:800;color:#38bdf8">${payslips.length}</div>
        <div style="font-size:12px;color:#94a3b8;margin-top:4px">Total Payslips</div>
      </div>
      <div style="background:#1e293b;border:1px solid #334155;border-top:3px solid #8b5cf6;border-radius:10px;padding:14px 22px;min-width:120px;text-align:center">
        <div style="font-size:28px;font-weight:800;color:#8b5cf6">${employeeIds.size}</div>
        <div style="font-size:12px;color:#94a3b8;margin-top:4px">Employees</div>
      </div>
      <div style="background:#1e293b;border:1px solid #334155;border-top:3px solid #22c55e;border-radius:10px;padding:14px 22px;min-width:140px;text-align:center">
        <div style="font-size:28px;font-weight:800;color:#22c55e">${withBank}</div>
        <div style="font-size:12px;color:#94a3b8;margin-top:4px">With Bank Account</div>
      </div>
      <div style="background:#1e293b;border:1px solid #334155;border-top:3px solid #ef4444;border-radius:10px;padding:14px 22px;min-width:140px;text-align:center">
        <div style="font-size:28px;font-weight:800;color:#ef4444">${withoutBank}</div>
        <div style="font-size:12px;color:#94a3b8;margin-top:4px">No Bank Account</div>
      </div>
    </div>`;

  const stateColors: Record<string, { bg: string; label: string }> = {
    draft:  { bg: '#475569', label: 'Draft' },
    verify: { bg: '#d97706', label: 'Waiting' },
    done:   { bg: '#16a34a', label: 'Done' },
    paid:   { bg: '#0369a1', label: 'Paid' },
    cancel: { bg: '#dc2626', label: 'Cancelled' },
  };

  const fmtCurrency = (v: number | undefined): string => {
    if (v == null || isNaN(v)) return '—';
    return new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(v);
  };

  // Sort payslips by employee name then date descending
  const sorted = [...payslips].sort((a, b) => {
    const nameA = Array.isArray(a.employee_id) ? a.employee_id[1] : '';
    const nameB = Array.isArray(b.employee_id) ? b.employee_id[1] : '';
    return nameA.localeCompare(nameB) || (b.date_from ?? '').localeCompare(a.date_from ?? '');
  });

  const rows = sorted.map(p => {
    const empName  = Array.isArray(p.employee_id) ? p.employee_id[1] : String(p.employee_id);
    const ref      = esc(p.number) || esc(p.name);
    const batch    = Array.isArray(p.payslip_run_id) ? esc(p.payslip_run_id[1]) : '—';
    const netWage  = fmtCurrency((p as any).net_wage);

    return `<tr>
      <td style="color:#e2e8f0;font-weight:500">${esc(empName)}</td>
      <td style="font-family:monospace;font-size:12px;color:#94a3b8">${ref}</td>
      <td style="color:#94a3b8;font-size:12px">${batch}</td>
      <td style="text-align:right;font-family:monospace;color:#38bdf8;font-weight:600">${netWage}</td>
    </tr>`;
  }).join('');

  if (!rows.trim()) {
    return summaryHtml + '<p style="color:#64748b">No payslip records found for Jinasena.</p>';
  }

  return summaryHtml + `
    <div style="overflow-x:auto">
      <table>
        <thead><tr>
          <th>Employee</th>
          <th style="width:160px">Reference</th>
          <th style="width:180px">Batch Name</th>
          <th style="width:130px;text-align:right">Net Wage</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;
}

// ── Tab 2: Column Headers ──────────────────────────────────────────────────────

function buildColumnHeadersTable(columns: ColumnInfo[]): string {
  if (!columns.length) return '<p style="color:#64748b">No column headers extracted. Payslip list view may not have loaded in debug mode.</p>';
  const rows = columns.map(c => `
    <tr>
      <td style="color:#e2e8f0">${esc(c.label)}</td>
      <td><code style="color:#38bdf8">${esc(c.technical)}</code></td>
      <td style="color:#94a3b8;font-size:12px">${esc(c.title)}</td>
    </tr>`).join('');
  return `
    <table>
      <thead><tr>
        <th>Display Label</th>
        <th style="width:220px">Technical Name (data-name)</th>
        <th>Title / Tooltip</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
}

// ── Tab 3: Form Fields ─────────────────────────────────────────────────────────

function buildFormFieldsTable(formFields: FormFieldInfo[]): string {
  if (!formFields.length) return '<p style="color:#64748b">No form fields extracted. Form view may not have loaded or no payslip records exist.</p>';
  const rows = formFields.map(f => `
    <tr>
      <td><code style="color:#38bdf8">${esc(f.name)}</code></td>
      <td style="color:#e2e8f0">${esc(f.label) || '<span style="color:#475569">—</span>'}</td>
    </tr>`).join('');
  return `
    <table>
      <thead><tr>
        <th style="width:260px">Field Name (name attribute)</th>
        <th>Label</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
}

// ── Tab 4: Models ──────────────────────────────────────────────────────────────

function buildModelsTable(models: IrModel[]): string {
  if (!models.length) return '<p style="color:#64748b">No models found.</p>';
  const rows = models.map(m => `
    <tr>
      <td><code style="color:#38bdf8">${esc(m.model)}</code></td>
      <td>${esc(m.name)}</td>
      <td style="color:#94a3b8;font-size:12px">${esc(m.modules)}</td>
      <td style="color:#64748b;font-size:12px">${esc(m.info) || '—'}</td>
      <td>${m.transient ? '<span style="background:#7c3aed;color:#fff;padding:1px 6px;border-radius:4px;font-size:10px">transient</span>' : ''}</td>
    </tr>`).join('');
  return `
    <table>
      <thead><tr>
        <th>Technical Name (model)</th>
        <th>Label / Description</th>
        <th>Module(s)</th>
        <th>Info</th>
        <th>Flags</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
}

// ── Tab 5: Fields ──────────────────────────────────────────────────────────────

function buildFieldsTable(fields: IrField[]): string {
  if (!fields.length) return '<p style="color:#64748b">No fields found.</p>';
  const rows = fields.map(f => {
    const modelLabel = Array.isArray(f.model_id) ? f.model_id[1] : String(f.model_id);
    const flags = [
      boolBadge(f.required, 'required',    '#dc2626'),
      boolBadge(f.readonly, 'readonly',    '#0369a1'),
      boolBadge(!f.store,   'non-stored',  '#78716c'),
      boolBadge(f.index,    'indexed',     '#065f46'),
    ].filter(Boolean).join(' ');
    const compute = f.compute
      ? `<code style="color:#a78bfa;font-size:11px">${esc(f.compute)}</code>`
      : '';
    const related = f.related
      ? `<span style="color:#94a3b8;font-size:11px">→ ${esc(f.related)}</span>`
      : '';
    return `
      <tr>
        <td style="font-size:11px;color:#94a3b8">${esc(modelLabel)}</td>
        <td><code style="color:#38bdf8">${esc(f.name)}</code></td>
        <td>${esc(f.field_description)}</td>
        <td>${fieldTypeBadge(f.ttype)}</td>
        <td>${flags}</td>
        <td>${compute}${related}</td>
        <td style="color:#64748b;font-size:11px;max-width:240px">${esc(f.help) || ''}</td>
      </tr>`;
  }).join('');
  return `
    <table>
      <thead><tr>
        <th style="width:160px">Model</th>
        <th style="width:180px">Field Name</th>
        <th>Label</th>
        <th style="width:120px">Type</th>
        <th style="width:160px">Flags</th>
        <th style="width:200px">Compute / Related</th>
        <th>Help</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
}

// ── Tab 6: Actions ─────────────────────────────────────────────────────────────

function buildActionsTable(actions: IrActionWindow[]): string {
  if (!actions.length) return '<p style="color:#64748b">No window actions found.</p>';
  const rows = actions.map(a => `
    <tr>
      <td style="color:#64748b;font-size:11px">${a.id}</td>
      <td style="color:#e2e8f0">${esc(a.name)}</td>
      <td><code style="color:#38bdf8;font-size:11px">${esc(a.res_model)}</code></td>
      <td style="color:#94a3b8;font-size:12px">${esc(a.view_mode)}</td>
      <td><code style="color:#a78bfa;font-size:11px">${esc(a.domain) || '[]'}</code></td>
      <td><code style="color:#6ee7b7;font-size:11px">${esc(a.context) || '{}'}</code></td>
    </tr>`).join('');
  return `
    <table>
      <thead><tr>
        <th style="width:60px">ID</th>
        <th>Name</th>
        <th style="width:180px">Model</th>
        <th style="width:160px">View Modes</th>
        <th style="width:180px">Domain</th>
        <th>Context</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
}

// ── Tab 7: Views + Server Actions ─────────────────────────────────────────────

function buildViewsTable(views: IrView[]): string {
  if (!views.length) return '<p style="color:#64748b">No views found.</p>';
  const rows = views.map(v => {
    const inheritLabel = Array.isArray(v.inherit_id)
      ? `<span style="color:#94a3b8;font-size:11px">${esc(v.inherit_id[1])}</span>`
      : '';
    const archSnippet = (v.arch || '').substring(0, 300);
    return `
      <tr>
        <td style="color:#64748b;font-size:11px">${v.id}</td>
        <td style="color:#e2e8f0">${esc(v.name)}</td>
        <td><span style="background:#1e3a5f;color:#38bdf8;padding:2px 7px;border-radius:4px;font-size:11px">${esc(v.type)}</span></td>
        <td><code style="color:#38bdf8;font-size:11px">${esc(v.model)}</code></td>
        <td style="color:#94a3b8;font-size:12px;text-align:center">${v.priority}</td>
        <td>${inheritLabel}</td>
        <td><pre style="margin:0;color:#6ee7b7;font-size:10px;white-space:pre-wrap;max-width:400px;overflow:hidden">${esc(archSnippet)}${v.arch && v.arch.length > 300 ? '\n…' : ''}</pre></td>
      </tr>`;
  }).join('');
  return `
    <table>
      <thead><tr>
        <th style="width:55px">ID</th>
        <th>Name</th>
        <th style="width:80px">Type</th>
        <th style="width:180px">Model</th>
        <th style="width:60px">Prio</th>
        <th style="width:180px">Inherits</th>
        <th>Arch (first 300 chars)</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
}

function buildServerActionsTable(serverActions: IrActionServer[]): string {
  if (!serverActions.length) return '<p style="color:#64748b">No server actions found.</p>';
  const rows = serverActions.map(sa => {
    const modelLabel = Array.isArray(sa.model_id) ? sa.model_id[1] : String(sa.model_id ?? sa.model_name ?? '');
    const stateColors: Record<string, string> = {
      code:           '#7c3aed',
      object_create:  '#0369a1',
      object_write:   '#0369a1',
      multi:          '#065f46',
      email:          '#b45309',
      sms:            '#b45309',
    };
    const stateBg    = stateColors[sa.state] ?? '#334155';
    const stateBadge = `<span style="background:${stateBg};color:#fff;padding:2px 7px;border-radius:4px;font-size:11px;font-weight:600">${esc(sa.state)}</span>`;
    const codeBlock  = sa.code
      ? `<pre style="margin:0;background:#0d1117;color:#a5f3fc;font-size:11px;padding:8px;border-radius:4px;white-space:pre-wrap;max-width:500px;overflow:auto;max-height:200px"><code>${esc(sa.code)}</code></pre>`
      : '<span style="color:#64748b;font-size:11px">—</span>';
    return `
      <tr>
        <td style="color:#e2e8f0">${esc(sa.name)}</td>
        <td style="color:#94a3b8;font-size:12px">${esc(modelLabel)}</td>
        <td>${stateBadge}</td>
        <td>${codeBlock}</td>
      </tr>`;
  }).join('');
  return `
    <table>
      <thead><tr>
        <th>Name</th>
        <th style="width:180px">Model</th>
        <th style="width:100px">State</th>
        <th>Python Code</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
}

// ── Master HTML builder ────────────────────────────────────────────────────────

function buildHtmlReport(data: AuditData): string {
  const ts = new Date(data.generatedAt).toLocaleString('en-US', {
    dateStyle: 'full', timeStyle: 'medium',
  });

  const summaryItems = [
    { label: 'Payslips',       count: data.payslips.length,       color: '#38bdf8' },
    { label: 'Models',         count: data.models.length,         color: '#3b82f6' },
    { label: 'Fields',         count: data.fields.length,         color: '#8b5cf6' },
    { label: 'Window Actions', count: data.actions.length,        color: '#22c55e' },
    { label: 'Views',          count: data.views.length,          color: '#f97316' },
    { label: 'Server Actions', count: data.serverActions.length,  color: '#ef4444' },
  ];

  const summaryHtml = summaryItems.map(s => `
    <div class="summary-badge" style="border-color:${s.color}">
      <span class="summary-count" style="color:${s.color}">${s.count}</span>
      <span class="summary-label">${s.label}</span>
    </div>`).join('');

  const tabs = [
    {
      id:      'payslips',
      label:   `Payslips + Bank Data (${data.payslips.length})`,
      content: buildPayslipBankTable(data.payslips, data.employees, data.employeeBankAccounts),
    },
    {
      id:      'columns',
      label:   `Column Headers (${data.columnHeaders.length})`,
      content: buildColumnHeadersTable(data.columnHeaders),
    },
    {
      id:      'formfields',
      label:   `Form Fields (${data.formFields.length})`,
      content: buildFormFieldsTable(data.formFields),
    },
    {
      id:      'models',
      label:   `Models (${data.models.length})`,
      content: buildModelsTable(data.models),
    },
    {
      id:      'fields',
      label:   `Fields (${data.fields.length})`,
      content: buildFieldsTable(data.fields),
    },
    {
      id:      'actions',
      label:   `Actions (${data.actions.length})`,
      content: buildActionsTable(data.actions),
    },
    {
      id:      'viewsserver',
      label:   `Views & Server Actions (${data.views.length + data.serverActions.length})`,
      content: `
        <h3 style="color:#94a3b8;font-size:13px;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:12px">
          Views (${data.views.length})
        </h3>
        ${buildViewsTable(data.views)}
        <h3 style="color:#94a3b8;font-size:13px;text-transform:uppercase;letter-spacing:0.5px;margin:24px 0 12px">
          Server Actions (${data.serverActions.length})
        </h3>
        ${buildServerActionsTable(data.serverActions)}`,
    },
  ];

  // Tab 0 (payslips) is active by default
  const tabButtons = tabs
    .map((t, i) => `<button class="tab-btn${i === 0 ? ' active' : ''}" onclick="showTab('${t.id}')" id="btn-${t.id}">${t.label}</button>`)
    .join('');

  const tabPanels = tabs
    .map((t, i) => `<div class="tab-panel${i === 0 ? '' : ' hidden'}" id="panel-${t.id}">${t.content}</div>`)
    .join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Payslip Technical Audit — Odoo 17</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

    body {
      font-family: 'Segoe UI', system-ui, -apple-system, sans-serif;
      background: #0f172a;
      color: #e2e8f0;
      padding: 32px 24px;
      min-height: 100vh;
    }

    .header { margin-bottom: 28px; }
    .header h1 {
      color: #38bdf8;
      font-size: 26px;
      font-weight: 700;
      letter-spacing: -0.5px;
      margin-bottom: 6px;
    }
    .header .subtitle { color: #64748b; font-size: 13px; }
    .header .subtitle strong { color: #94a3b8; }

    .summary-row {
      display: flex;
      flex-wrap: wrap;
      gap: 14px;
      margin-bottom: 28px;
    }
    .summary-badge {
      display: flex;
      flex-direction: column;
      align-items: center;
      background: #1e293b;
      border: 1px solid #334155;
      border-radius: 10px;
      padding: 14px 22px;
      min-width: 120px;
      border-top-width: 3px;
    }
    .summary-count { font-size: 30px; font-weight: 800; line-height: 1; }
    .summary-label { font-size: 12px; color: #94a3b8; margin-top: 4px; }

    .tabs {
      display: flex;
      flex-wrap: wrap;
      gap: 4px;
      margin-bottom: 20px;
      border-bottom: 1px solid #1e293b;
      padding-bottom: 10px;
    }
    .tab-btn {
      background: #1e293b;
      color: #94a3b8;
      border: 1px solid #334155;
      border-radius: 6px;
      padding: 8px 16px;
      font-size: 13px;
      cursor: pointer;
      transition: background 0.15s, color 0.15s;
    }
    .tab-btn:hover { background: #334155; color: #e2e8f0; }
    .tab-btn.active {
      background: #0369a1;
      color: #fff;
      border-color: #0369a1;
    }

    .tab-panel { overflow-x: auto; }
    .tab-panel.hidden { display: none; }

    table {
      width: 100%;
      border-collapse: collapse;
      font-size: 12px;
    }
    thead th {
      background: #1e293b;
      padding: 10px 12px;
      text-align: left;
      color: #94a3b8;
      font-size: 11px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      position: sticky;
      top: 0;
      z-index: 1;
      border-bottom: 1px solid #334155;
    }
    tbody tr { border-bottom: 1px solid #1e293b; }
    tbody tr:hover { background: #162032; }
    tbody td { padding: 8px 12px; vertical-align: top; }

    code {
      font-family: 'Cascadia Code', 'Fira Code', 'Consolas', monospace;
      font-size: 12px;
    }
    pre {
      font-family: 'Cascadia Code', 'Fira Code', 'Consolas', monospace;
    }

    p { color: #64748b; font-size: 13px; padding: 16px 0; }
  </style>
</head>
<body>

  <div class="header">
    <h1>Payslip Technical Audit</h1>
    <p class="subtitle">
      <strong>Jinasena Agricultural Machinery (Pvt) Ltd</strong> &nbsp;|&nbsp;
      Odoo 17 &nbsp;|&nbsp; Generated: <strong>${ts}</strong>
    </p>
  </div>

  <div class="summary-row">
    ${summaryHtml}
  </div>

  <div class="tabs">
    ${tabButtons}
  </div>

  ${tabPanels}

  <script>
    function showTab(id) {
      document.querySelectorAll('.tab-panel').forEach(p => p.classList.add('hidden'));
      document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
      document.getElementById('panel-' + id).classList.remove('hidden');
      document.getElementById('btn-' + id).classList.add('active');
    }
  </script>

</body>
</html>`;
}

// ─── Main test ────────────────────────────────────────────────────────────────

test.setTimeout(0);

test('Payslip Technical Audit — Models, Fields, Actions, Views + Live Bank Data', async ({ page }) => {
  // Create output directories
  fs.mkdirSync(OUT, { recursive: true });
  fs.mkdirSync(SS_DIR, { recursive: true });

  // ── Step 1: Login + Company Switch ──────────────────────────────────────────
  console.log('\n[Step 1] Logging in and switching company...');
  await login(page);
  await screenshot(page, 'ps_01a_after_login');

  await selectCompany(page);
  await screenshot(page, 'ps_01b_after_company_switch');
  console.log('  Login and company switch complete');

  // ── Step 2: Activate debug mode ─────────────────────────────────────────────
  await activateDebugMode(page);
  await screenshot(page, 'ps_02_debug_active');

  // ── Step 3: Navigate to Payroll Slips list/form and extract metadata ─────────
  const { columnHeaders, formFields } = await extractPayslipViewMetadata(page);

  // ── Step 4: Navigate to Settings → Technical (verification + screenshot) ────
  await navigateToSettingsTechnical(page);

  // ── Step 5: Collect data via RPC ─────────────────────────────────────────────
  // Navigate to a stable page with active session before making RPC calls
  await page.goto(`${BASE_URL}/web?debug=1`, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await sleep(2000);

  const rpcData = await collectAllPayslipData(page);

  const auditData: AuditData = {
    generatedAt: new Date().toISOString(),
    columnHeaders,
    formFields,
    ...rpcData,
  };

  // ── Save raw JSON ────────────────────────────────────────────────────────────
  fs.writeFileSync(DATA, JSON.stringify(auditData, null, 2));
  console.log(`\n[Output] Raw JSON saved to: ${DATA}`);

  // ── Step 6: Generate HTML report ─────────────────────────────────────────────
  console.log('\n[Step 6] Generating HTML report...');
  const html = buildHtmlReport(auditData);
  fs.writeFileSync(REPORT, html);
  console.log(`[Output] HTML report saved to: ${REPORT}`);

  // Final summary
  console.log('\n=== PAYSLIP AUDIT COMPLETE ===');
  console.log(`  Payslips:        ${auditData.payslips.length}`);
  console.log(`  Employees:       ${auditData.employees.length}`);
  console.log(`  Bank Accounts:   ${auditData.employeeBankAccounts.length}`);
  console.log(`  Column Headers:  ${auditData.columnHeaders.length}`);
  console.log(`  Form Fields:     ${auditData.formFields.length}`);
  console.log(`  Models:          ${auditData.models.length}`);
  console.log(`  Fields:          ${auditData.fields.length}`);
  console.log(`  Window Actions:  ${auditData.actions.length}`);
  console.log(`  Views:           ${auditData.views.length}`);
  console.log(`  Server Actions:  ${auditData.serverActions.length}`);
  console.log('==============================\n');
});

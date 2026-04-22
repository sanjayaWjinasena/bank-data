/**
 * Bank Data Report — Playwright Investigation Script
 *
 * PURPOSE: Discover what model/fields "Payroll → Reporting → Bank Data" uses,
 *          extract ALL records via RPC (and DOM fallback), and generate a report.
 *
 * Steps:
 *   1 — Login + company switch + debug mode
 *   2 — Navigate Payroll → Reporting → Bank Data via real menu clicks
 *   3 — Capture URL + extract column headers (debug mode metadata)
 *   4 — RPC investigation: resolve model, search bank actions/menus
 *   5 — Fetch all records (RPC preferred, DOM fallback with pagination)
 *   6 — Save raw JSON investigation data
 *   7 — Generate dark-theme HTML report
 *
 * Outputs:
 *   bank-audit-output/bank-data-investigation.json
 *   bank-audit-output/bank-data-report.html
 *   bank-audit-output/screenshots/bd_*.png
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
const REPORT = path.join(OUT, 'bank-data-report.html');
const DATA   = path.join(OUT, 'bank-data-investigation.json');

// ─── Types ────────────────────────────────────────────────────────────────────

interface ColumnInfo {
  label:     string;
  technical: string;
  title:     string;
}

interface ActionInfo {
  id:        number;
  name:      string;
  res_model: string;
  view_mode: string;
  domain:    string | false;
  context:   string | false;
}

interface MenuInfo {
  id:            number;
  name:          string;
  complete_name: string;
  action:        string | false;
  parent_id:     [number, string] | false;
}

// ─── Screenshot helper ────────────────────────────────────────────────────────

async function screenshot(page: Page, name: string): Promise<void> {
  fs.mkdirSync(SS_DIR, { recursive: true });
  const safe = name.replace(/[^a-zA-Z0-9_-]/g, '_').substring(0, 80);
  await page.screenshot({ path: path.join(SS_DIR, `${safe}.png`), fullPage: false }).catch(() => {});
  console.log(`  [screenshot] ${safe}.png`);
}

// ─── RPC helpers (verbatim from payslip-technical-audit.spec.ts) ──────────────

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

// ─── Debug mode helpers (verbatim from payslip-technical-audit.spec.ts) ───────

async function activateDebugMode(page: Page): Promise<void> {
  console.log('\n[Debug] Activating debug mode via Ctrl+K command palette...');

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

// ─── DOM row extraction helper ────────────────────────────────────────────────

async function extractDomRows(page: Page): Promise<Record<string, string>[]> {
  return page.evaluate(() => {
    const headers = Array.from(document.querySelectorAll(
      '.o_list_view thead th, .o_list_table thead th, table thead th'
    )).map(th => (th as HTMLElement).innerText.trim()).filter(Boolean);

    const rows = Array.from(document.querySelectorAll(
      '.o_list_view tbody tr.o_data_row, .o_list_table tbody tr.o_data_row, table tbody tr.o_data_row'
    ));

    return rows.map(row => {
      const cells = Array.from(row.querySelectorAll('td.o_data_cell, td')).map(
        td => (td as HTMLElement).innerText.trim()
      );
      const obj: Record<string, string> = {};
      cells.forEach((val, i) => { obj[headers[i] || `col_${i}`] = val; });
      return obj;
    });
  });
}

// ─── Try RPC model field discovery ───────────────────────────────────────────

async function tryGetModelFields(page: Page, model: string): Promise<Record<string, unknown>[]> {
  try {
    const fields = await searchRead<Record<string, unknown>>(
      page,
      'ir.model.fields',
      [['model_id.model', '=', model], ['store', '=', true]],
      ['name', 'field_description', 'ttype', 'required', 'readonly'],
      'name asc'
    );
    console.log(`  Found ${fields.length} stored fields on model: ${model}`);
    return fields;
  } catch (e) {
    console.log(`  Could not fetch fields for model ${model}: ${(e as Error).message}`);
    return [];
  }
}

// ─── Parse model from URL ─────────────────────────────────────────────────────

function parseModelFromUrl(url: string): string | null {
  // Try ?model= or #...model=
  const modelMatch = url.match(/[?&#]model=([^&#&]+)/);
  if (modelMatch) return decodeURIComponent(modelMatch[1]);
  return null;
}

function parseActionFromUrl(url: string): string | null {
  // New-style /odoo/payroll/... or old-style #action=NNN
  const actionMatch = url.match(/[?&#]action=([^&#&]+)/);
  if (actionMatch) return decodeURIComponent(actionMatch[1]);
  // Also try path-based IDs like /odoo/action-payroll_report_...
  const pathMatch = url.match(/action-([^/?&#]+)/);
  if (pathMatch) return pathMatch[1];
  return null;
}

// ─── Main test ────────────────────────────────────────────────────────────────

test('Bank Data Report — Investigation & Extraction', async ({ page }) => {
  fs.mkdirSync(OUT,    { recursive: true });
  fs.mkdirSync(SS_DIR, { recursive: true });

  // ── Step 1: Login + Company Switch ──────────────────────────────────────────
  console.log('\n[Step 1] Login + company switch...');
  await login(page);
  await selectCompany(page);
  await screenshot(page, 'bd_01_after_login');

  // ── Activate debug mode ──────────────────────────────────────────────────────
  await activateDebugMode(page);
  await screenshot(page, 'bd_02_debug_active');

  // ── Step 2: Navigate Payroll → Reporting → Bank Data via menu clicks ─────────
  console.log('\n[Step 2] Navigating to Payroll app...');

  // Navigate directly to the Payroll app using menu_id=812 (the known Payroll root menu).
  // We skip /odoo/payroll because on this instance it resolves to #action=payroll (apps list).
  // menu_id=812 forces the Payroll module to load its own top nav correctly.
  await page.goto(
    `${BASE_URL}/web?debug=1&cids=2#menu_id=812`,
    { waitUntil: 'domcontentloaded', timeout: 30000 }
  );
  await sleep(3000);

  // Verify Payroll navbar is loaded
  const payrollLoaded = await page.locator('.o_main_navbar').isVisible({ timeout: 5000 }).catch(() => false);
  if (!payrollLoaded) {
    console.log('  Payroll navbar not found after menu_id=812 — retrying with action=1541');
    await page.goto(
      `${BASE_URL}/web?debug=1&cids=2#action=1541&menu_id=812`,
      { waitUntil: 'domcontentloaded', timeout: 30000 }
    );
    await sleep(3000);
  }

  // Verify we're in Payroll by checking navbar
  const navbarText = await page.locator('.o_main_navbar').textContent().catch(() => '');
  console.log(`  Navbar text: "${navbarText?.trim().substring(0, 80)}"`);
  await screenshot(page, 'bd_03_payroll_home');

  // Click "Reporting" in the top Payroll navbar
  console.log('\n[Step 2a] Clicking Reporting menu...');
  const reportingMenuSelectors = [
    '.o_menu_sections .o_nav_entry:has-text("Reporting")',
    '.o_menu_sections a:has-text("Reporting")',
    '.o_menu_sections span:has-text("Reporting")',
    '.o_main_navbar .o_menu_brand + div a:has-text("Reporting")',
    'nav .o_menu_sections a:has-text("Reporting")',
    '.o_main_navbar a:has-text("Reporting")',
    'button:has-text("Reporting")',
    '[data-menu-xmlid*="reporting"]:has-text("Reporting")',
    '.o_menu_sections .o_dropdown:has-text("Reporting")',
  ];

  let reportingClicked = false;
  for (const sel of reportingMenuSelectors) {
    const loc = page.locator(sel).first();
    if (await loc.isVisible({ timeout: 2000 }).catch(() => false)) {
      await loc.click();
      reportingClicked = true;
      console.log(`  Clicked Reporting via: ${sel}`);
      break;
    }
  }

  if (!reportingClicked) {
    // Log all top-level menu items for debugging
    const menuItems = await page.locator('.o_menu_sections a, .o_menu_sections button, .o_menu_sections .o_nav_entry').allTextContents().catch(() => []);
    console.log(`  Available menu items: [${menuItems.map(t => t.trim()).filter(Boolean).join(' | ')}]`);
    // Try broader text match
    const reportingAny = page.getByText(/^Reporting$/i).first();
    if (await reportingAny.isVisible({ timeout: 3000 }).catch(() => false)) {
      await reportingAny.click();
      reportingClicked = true;
      console.log('  Clicked Reporting via broad getByText match');
    } else {
      console.log('  WARNING: Could not find Reporting menu item');
    }
  }

  await sleep(1200);
  await screenshot(page, 'bd_04_reporting_dropdown');

  // Click "Bank Data" in the dropdown
  console.log('\n[Step 2b] Clicking Bank Data menu item...');
  const bankDataSelectors = [
    '.o-dropdown--menu a:has-text("Bank Data")',
    '.o_menu_sections .dropdown-menu a:has-text("Bank Data")',
    '.dropdown-item:has-text("Bank Data")',
    '[role="menuitem"]:has-text("Bank Data")',
    '.o_dropdown_menu a:has-text("Bank Data")',
    'a:has-text("Bank Data")',
    'li:has-text("Bank Data")',
  ];

  let bankDataClicked = false;
  for (const sel of bankDataSelectors) {
    const loc = page.locator(sel).first();
    if (await loc.isVisible({ timeout: 2000 }).catch(() => false)) {
      await loc.click();
      bankDataClicked = true;
      console.log(`  Clicked Bank Data via: ${sel}`);
      break;
    }
  }

  if (!bankDataClicked) {
    // Log all dropdown items for debugging
    const dropdownItems = await page.locator('.o-dropdown--menu, .dropdown-menu').allTextContents().catch(() => []);
    console.log(`  Dropdown contents: ${JSON.stringify(dropdownItems)}`);
    const bankAny = page.getByText(/^Bank Data$/i).first();
    if (await bankAny.isVisible({ timeout: 3000 }).catch(() => false)) {
      await bankAny.click();
      bankDataClicked = true;
      console.log('  Clicked Bank Data via broad getByText match');
    } else {
      console.log('  WARNING: Could not find Bank Data menu item');
    }
  }

  // Wait for the Bank Data view to load
  console.log('\n[Step 2c] Waiting for Bank Data page to load...');
  await sleep(3000);
  // Wait for either a list view, empty state, or any Odoo view to settle
  await Promise.race([
    page.waitForSelector('.o_list_view, .o_list_table', { timeout: 15000 }),
    page.waitForSelector('.o_view_controller',          { timeout: 15000 }),
    page.waitForSelector('.o_nocontent_help',           { timeout: 15000 }),
    page.waitForSelector('.o_kanban_view',              { timeout: 15000 }),
    sleep(10000),
  ]).catch(() => {});

  await sleep(1500);
  await screenshot(page, 'bd_05_bank_data_loaded');

  // ── Step 3: Capture URL + page metadata ──────────────────────────────────────
  console.log('\n[Step 3] Capturing URL and page metadata...');
  const bankDataUrl = page.url();
  console.log('  Bank Data URL:', bankDataUrl);

  // Parse model and action from URL
  const urlModel  = parseModelFromUrl(bankDataUrl);
  const urlAction = parseActionFromUrl(bankDataUrl);
  console.log('  Parsed model from URL: ', urlModel  ?? '(not found in URL)');
  console.log('  Parsed action from URL:', urlAction ?? '(not found in URL)');

  // Extract column headers with technical names (debug mode attributes)
  const columnHeaders: ColumnInfo[] = await page.evaluate(() => {
    return Array.from(document.querySelectorAll(
      'thead th[data-name], thead th[data-field], .o_list_view thead th, .o_list_table thead th, table thead th'
    )).map(th => ({
      label:     (th as HTMLElement).innerText.trim(),
      technical: (th as HTMLElement).dataset['name'] || (th as HTMLElement).dataset['field'] || '',
      title:     (th as HTMLElement).title || '',
    })).filter(c => c.label && c.label !== '');
  });
  console.log('  Column headers found:', columnHeaders.length);
  columnHeaders.forEach(c => console.log(`    "${c.label}" → technical="${c.technical}" title="${c.title}"`));

  // Try to get model from the view's DOM (debug mode adds data attributes)
  const domModel: string | null = await page.evaluate(() => {
    // Odoo 17 stores the model on the view root
    const viewEl = document.querySelector(
      '[data-model], .o_view_controller[data-model], .o_list_view[data-model], .o_kanban_view[data-model]'
    );
    if (viewEl) return (viewEl as HTMLElement).dataset['model'] || null;
    // Try the breadcrumb or debug info
    const debugEl = document.querySelector('.o_debug_manager, [data-original-title*="model"]');
    if (debugEl) return (debugEl as HTMLElement).dataset['originalTitle'] || null;
    return null;
  });
  if (domModel) console.log('  Model from DOM data attribute:', domModel);

  // Check page title / heading
  const pageTitle = await page.locator('.o_control_panel .o_breadcrumb, .o_control_panel_breadcrumbs').textContent().catch(() => '');
  console.log('  Page breadcrumb/title:', pageTitle?.trim());

  // ── Step 4: RPC investigation ────────────────────────────────────────────────
  console.log('\n[Step 4] RPC investigation — searching for bank-related actions and menus...');

  // 4a — Search ir.actions.act_window for anything bank-related
  let bankActions: ActionInfo[] = [];
  try {
    bankActions = await searchRead<ActionInfo>(
      page,
      'ir.actions.act_window',
      [['name', 'ilike', 'bank']],
      ['name', 'res_model', 'view_mode', 'domain', 'context', 'id'],
      'id asc'
    );
    console.log(`\n  Bank-related act_window actions (${bankActions.length}):`,
      JSON.stringify(bankActions, null, 2));
  } catch (e) {
    console.log('  RPC ir.actions.act_window failed:', (e as Error).message);
  }

  // 4b — Also search for payroll-related bank actions specifically
  let payrollBankActions: ActionInfo[] = [];
  try {
    payrollBankActions = await searchRead<ActionInfo>(
      page,
      'ir.actions.act_window',
      [['res_model', 'ilike', 'bank']],
      ['name', 'res_model', 'view_mode', 'domain', 'context', 'id'],
      'id asc'
    );
    console.log(`\n  Actions with bank in res_model (${payrollBankActions.length}):`,
      JSON.stringify(payrollBankActions, null, 2));
  } catch (e) {
    console.log('  RPC (bank model actions) failed:', (e as Error).message);
  }

  // 4c — Search ir.ui.menu for Bank Data menu
  let bankMenus: MenuInfo[] = [];
  try {
    bankMenus = await searchRead<MenuInfo>(
      page,
      'ir.ui.menu',
      [['name', 'ilike', 'bank']],
      ['name', 'complete_name', 'action', 'parent_id'],
      'id asc'
    );
    console.log(`\n  Bank-related menus (${bankMenus.length}):`,
      JSON.stringify(bankMenus, null, 2));
  } catch (e) {
    console.log('  RPC ir.ui.menu failed:', (e as Error).message);
  }

  // 4d — First priority: exact "Bank Data" named action from the bankActions list we already have.
  //      This is the most reliable — action id 2895 = "Bank Data" = account.move.line.
  //      Only fall back to URL parsing if we somehow got no results.
  let resolvedModel: string | null = urlModel ?? domModel ?? null;
  let resolvedActionRecord: ActionInfo | null = null;

  // Check bankActions we already fetched for the exact "Bank Data" entry
  const exactBankDataAction = bankActions.find(a => a.name === 'Bank Data');
  if (exactBankDataAction) {
    resolvedActionRecord = exactBankDataAction;
    resolvedModel = exactBankDataAction.res_model;
    console.log(`\n  Resolved model from bankActions "Bank Data" entry:`, JSON.stringify(exactBankDataAction, null, 2));
  }

  if (!resolvedModel && urlAction) {
    // Try looking up the action directly from URL
    try {
      const numericId = parseInt(urlAction, 10);
      if (!isNaN(numericId)) {
        const actions = await searchRead<ActionInfo>(
          page,
          'ir.actions.act_window',
          [['id', '=', numericId]],
          ['name', 'res_model', 'view_mode', 'domain', 'context', 'id']
        );
        if (actions.length > 0) {
          resolvedActionRecord = actions[0];
          resolvedModel = actions[0].res_model;
          console.log(`\n  Resolved action ${numericId}:`, JSON.stringify(actions[0], null, 2));
        }
      }
    } catch (e) {
      console.log('  Could not resolve action from URL:', (e as Error).message);
    }
  }

  // 4e — Cross-reference: find menu "Bank Data" specifically (exact match)
  let bankDataMenu: MenuInfo | null = null;
  try {
    const exact = await searchRead<MenuInfo>(
      page,
      'ir.ui.menu',
      [['name', '=', 'Bank Data']],
      ['name', 'complete_name', 'action', 'parent_id']
    );
    if (exact.length > 0) {
      bankDataMenu = exact[0];
      console.log(`\n  Exact "Bank Data" menu record:`, JSON.stringify(bankDataMenu, null, 2));
      // Extract model from action string e.g. "ir.actions.act_window,1234"
      if (bankDataMenu.action && !resolvedModel) {
        const actionIdMatch = String(bankDataMenu.action).match(/,(\d+)$/);
        if (actionIdMatch) {
          const aid = parseInt(actionIdMatch[1], 10);
          const actions = await searchRead<ActionInfo>(
            page,
            'ir.actions.act_window',
            [['id', '=', aid]],
            ['name', 'res_model', 'view_mode', 'domain', 'context', 'id']
          );
          if (actions.length > 0) {
            resolvedActionRecord = actions[0];
            resolvedModel = actions[0].res_model;
            console.log(`\n  Bank Data menu action resolved:`, JSON.stringify(actions[0], null, 2));
          }
        }
      }
    } else {
      console.log('  No exact "Bank Data" menu found');
    }
  } catch (e) {
    console.log('  Exact Bank Data menu lookup failed:', (e as Error).message);
  }

  // 4f — Build candidate model list.
  // We already know from action 2895 that the model is account.move.line.
  // List additional candidates only as a safety net in case the RPC action lookup fails.
  const fallbackModels = [
    'account.move.line',
    'hr.payslip.payment',
    'hr.payment',
    'account.payment',
    'res.partner.bank',
    'hr.employee.bank.account',
    'hr.employee',
  ];

  // Put resolved model first, then append fallbacks (deduped, never ir.module.module)
  const candidateBase = resolvedModel
    ? [resolvedModel, ...fallbackModels.filter(m => m !== resolvedModel)]
    : fallbackModels;

  // Deduplicate
  const uniqueModels = [...new Set(candidateBase)];
  console.log('\n  Candidate models to probe:', uniqueModels);

  // Check which models actually exist in this database
  const existingModels: string[] = [];
  for (const m of uniqueModels) {
    try {
      const count = await rpc<number>(page, m, 'search_count', [[]], { context: { lang: 'en_US' } });
      console.log(`  Model ${m}: exists, record count = ${count}`);
      existingModels.push(m);
    } catch {
      console.log(`  Model ${m}: does NOT exist or access denied`);
    }
  }

  console.log('\n  Existing/accessible models:', existingModels);

  // ── Step 5: Fetch all records ──────────────────────────────────────────────
  console.log('\n[Step 5] Fetching all records...');

  // Determine which model to use for data extraction.
  // Prefer the explicitly resolved model (from Bank Data action 2895) over anything else.
  // existingModels is sorted in candidate order so existingModels[0] is the best fallback.
  const primaryModel = resolvedModel
    ?? (existingModels.length > 0 ? existingModels[0] : null);
  let rpcRecords: Record<string, unknown>[] = [];
  let modelFields: Record<string, unknown>[] = [];
  let usedModel = '';

  if (primaryModel) {
    console.log(`  Primary model determined: ${primaryModel}`);
    usedModel = primaryModel;

    // Get fields for this model
    modelFields = await tryGetModelFields(page, primaryModel);

    // Build fields list: prefer columns we saw in the UI, fall back to all stored fields
    let fieldsToFetch: string[] = columnHeaders
      .map(c => c.technical)
      .filter(Boolean);

    if (fieldsToFetch.length === 0 && modelFields.length > 0) {
      // Use stored fields (max 30 to avoid overloading)
      fieldsToFetch = modelFields
        .map((f: Record<string, unknown>) => f['name'] as string)
        .filter(Boolean)
        .slice(0, 30);
    }

    if (fieldsToFetch.length === 0) {
      // Model-specific fallbacks
      if (primaryModel === 'account.move.line') {
        fieldsToFetch = [
          'id', 'name', 'move_name', 'date', 'partner_id', 'account_id',
          'journal_id', 'debit', 'credit', 'balance', 'amount_currency',
          'currency_id', 'ref', 'company_id', 'parent_state', 'move_id',
        ];
      } else {
        // Generic fallback for unknown models
        fieldsToFetch = ['id', 'name', 'employee_id', 'acc_number', 'bank_id', 'partner_id', 'company_id'];
      }
    }

    // Always ensure 'id' is in the list
    if (!fieldsToFetch.includes('id')) fieldsToFetch.unshift('id');

    console.log('  Fields to fetch:', fieldsToFetch);

    // For account.move.line (Bank Data), filter by company_id=2 (Jinasena Agricultural Machinery)
    // and journal_type=bank to match what the Payroll Bank Data view shows.
    // The action context has journal_type:'bank' not set, so we start with no domain restriction
    // to see everything the action would show, then we can narrow later.
    const fetchDomain: unknown[] = primaryModel === 'account.move.line'
      ? [['company_id', '=', 2]]
      : [];

    try {
      rpcRecords = await searchRead<Record<string, unknown>>(
        page,
        primaryModel,
        fetchDomain,
        fieldsToFetch,
        'id asc'
      );
      console.log(`  RPC returned ${rpcRecords.length} records from ${primaryModel}`);
      if (rpcRecords.length > 0) {
        console.log('  Sample record (first):', JSON.stringify(rpcRecords[0], null, 2));
      }
    } catch (e) {
      console.log(`  RPC search_read on ${primaryModel} failed: ${(e as Error).message}`);
      console.log('  Will fall back to DOM extraction');
    }
  } else {
    console.log('  No model resolved — skipping RPC record fetch, using DOM fallback');
  }

  // ── DOM fallback: extract visible rows (clears filters + handles pagination) ──
  console.log('\n[Step 5b] DOM extraction (fallback / cross-check)...');

  // Clear any active search filters
  console.log('  Clearing active filters...');
  for (let i = 0; i < 8; i++) {
    const del = page.locator('.o_searchview_facet .o_delete, .o_facet_remove').first();
    if (!await del.isVisible({ timeout: 800 }).catch(() => false)) break;
    await del.click();
    await sleep(600);
  }
  await sleep(800);

  // Expand any collapsed groups
  const groups = page.locator('.o_group_header');
  const gc = await groups.count();
  if (gc > 0) {
    console.log(`  Expanding ${gc} groups...`);
    for (let i = 0; i < gc; i++) {
      await groups.nth(i).locator('td').first().click({ force: true }).catch(() => {});
      await sleep(300);
    }
    await sleep(800);
  }

  // DOM extraction — first page only for a quick sanity check.
  // With 8,000+ records, paginating the DOM would take 100+ page clicks and
  // crash the browser. All record data comes from RPC (Step 5) instead.
  const domRows = await extractDomRows(page);
  console.log(`  DOM rows (first page sample): ${domRows.length}`);
  if (domRows.length > 0) {
    console.log('  Sample DOM row:', JSON.stringify(domRows[0], null, 2));
  }
  const allDomRows: Record<string, string>[] = domRows;

  console.log(`  Total DOM rows across all pages: ${allDomRows.length}`);
  await screenshot(page, 'bd_06_final_state');

  // ── Step 7: Save investigation output + generate HTML report ──────────────
  console.log('\n[Step 6] Saving raw investigation JSON...');

  const investigationData = {
    generatedAt:          new Date().toISOString(),
    bankDataUrl,
    urlModel,
    urlAction,
    domModel,
    resolvedModel:        primaryModel,
    usedModel,
    columnHeaders,
    pageTitle:            pageTitle?.trim(),
    bankActions,
    payrollBankActions,
    bankMenus,
    bankDataMenu,
    resolvedActionRecord,
    existingModels,
    modelFields,
    rpcRecords,
    domRows:              allDomRows,
    totalRpcRecords:      rpcRecords.length,
    totalDomRows:         allDomRows.length,
  };

  fs.writeFileSync(DATA, JSON.stringify(investigationData, null, 2));
  console.log(`  Saved: ${DATA}`);

  // ── Generate HTML report ───────────────────────────────────────────────────
  console.log('\n[Step 7] Generating HTML report...');

  const primaryRecords = rpcRecords.length > 0 ? rpcRecords : allDomRows;
  const recordCount    = primaryRecords.length;
  const dataSource     = rpcRecords.length > 0 ? 'RPC (server-side)' : 'DOM (browser-side)';

  // Build column headers for the data table
  let tableHeaders: string[] = [];
  if (rpcRecords.length > 0 && rpcRecords[0]) {
    tableHeaders = Object.keys(rpcRecords[0]);
  } else if (allDomRows.length > 0 && allDomRows[0]) {
    tableHeaders = Object.keys(allDomRows[0]);
  } else {
    tableHeaders = columnHeaders.map(c => c.label || c.technical);
  }

  const colHeaderHtml = columnHeaders.map(c => `
    <tr>
      <td style="padding:6px 12px;color:#f1f5f9">${escapeHtml(c.label)}</td>
      <td style="padding:6px 12px;color:#60a5fa;font-family:monospace">${escapeHtml(c.technical)}</td>
      <td style="padding:6px 12px;color:#94a3b8">${escapeHtml(c.title)}</td>
    </tr>`).join('');

  const actionRowHtml = bankActions.map(a => `
    <tr>
      <td style="padding:6px 12px;color:#fbbf24">${a.id}</td>
      <td style="padding:6px 12px;color:#f1f5f9">${escapeHtml(a.name)}</td>
      <td style="padding:6px 12px;color:#60a5fa;font-family:monospace">${escapeHtml(a.res_model)}</td>
      <td style="padding:6px 12px;color:#94a3b8">${escapeHtml(a.view_mode)}</td>
    </tr>`).join('');

  const menuRowHtml = bankMenus.map(m => `
    <tr>
      <td style="padding:6px 12px;color:#fbbf24">${m.id}</td>
      <td style="padding:6px 12px;color:#f1f5f9">${escapeHtml(m.name)}</td>
      <td style="padding:6px 12px;color:#94a3b8">${escapeHtml(m.complete_name)}</td>
      <td style="padding:6px 12px;color:#60a5fa;font-family:monospace">${escapeHtml(String(m.action))}</td>
    </tr>`).join('');

  // Data table — show up to 500 rows to keep HTML manageable
  const MAX_ROWS = 500;
  const displayRows = primaryRecords.slice(0, MAX_ROWS);
  const thHtml = tableHeaders.map(h => `<th style="background:#1e293b;padding:8px 12px;text-align:left;color:#94a3b8;white-space:nowrap">${escapeHtml(h)}</th>`).join('');
  const tdHtml = displayRows.map((row, idx) => {
    const bg = idx % 2 === 0 ? '#0f172a' : '#111827';
    const cells = tableHeaders.map(h => {
      const val = (row as Record<string, unknown>)[h];
      return `<td style="padding:5px 10px;border-bottom:1px solid #1e293b;max-width:300px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${escapeHtml(String(val ?? ''))}">${escapeHtml(String(val ?? ''))}</td>`;
    }).join('');
    return `<tr style="background:${bg}">${cells}</tr>`;
  }).join('');

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Bank Data Report — Jinasena Agricultural Machinery</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: 'Segoe UI', system-ui, sans-serif; background: #0f172a; color: #e2e8f0; padding: 32px; }
    h1 { color: #38bdf8; margin-bottom: 8px; font-size: 24px; }
    h2 { color: #7dd3fc; margin: 28px 0 12px; font-size: 16px; border-bottom: 1px solid #1e293b; padding-bottom: 6px; }
    p.subtitle { color: #64748b; font-size: 12px; margin-bottom: 20px; }
    .meta-grid { display: grid; grid-template-columns: 180px 1fr; gap: 4px 12px; margin: 16px 0; font-size: 13px; }
    .meta-grid .key { color: #94a3b8; }
    .meta-grid .val { color: #e2e8f0; font-family: monospace; word-break: break-all; }
    .summary { display: flex; gap: 16px; margin: 16px 0 24px; flex-wrap: wrap; }
    .badge { padding: 8px 20px; border-radius: 6px; font-weight: 700; font-size: 13px; }
    .blue  { background: #0c2340; color: #38bdf8; }
    .green { background: #052e16; color: #4ade80; }
    .amber { background: #1c1407; color: #fbbf24; }
    table { width: 100%; border-collapse: collapse; font-size: 12px; }
    thead th { position: sticky; top: 0; z-index: 1; }
    .scroll-wrap { overflow-x: auto; margin-bottom: 24px; border: 1px solid #1e293b; border-radius: 6px; }
    .warn { color: #fbbf24; font-size: 12px; margin-top: 6px; }
    code { background: #1e293b; padding: 2px 6px; border-radius: 3px; font-family: monospace; font-size: 11px; color: #60a5fa; }
  </style>
</head>
<body>
  <h1>Bank Data Report</h1>
  <p class="subtitle">Generated ${new Date().toLocaleString()} &middot; Odoo Payroll &middot; Jinasena Agricultural Machinery (Pvt) Ltd &middot; cids=2</p>

  <div class="summary">
    <div class="badge blue">Records: ${recordCount}</div>
    <div class="badge green">Source: ${dataSource}</div>
    <div class="badge amber">Model: ${escapeHtml(primaryModel ?? 'Unknown')}</div>
  </div>

  <h2>Discovery Metadata</h2>
  <div class="meta-grid">
    <span class="key">Bank Data URL</span>   <span class="val">${escapeHtml(bankDataUrl)}</span>
    <span class="key">URL Model</span>        <span class="val">${escapeHtml(urlModel ?? '—')}</span>
    <span class="key">URL Action</span>       <span class="val">${escapeHtml(urlAction ?? '—')}</span>
    <span class="key">DOM Model</span>        <span class="val">${escapeHtml(domModel ?? '—')}</span>
    <span class="key">Resolved Model</span>   <span class="val">${escapeHtml(primaryModel ?? '—')}</span>
    <span class="key">Existing Models</span>  <span class="val">${existingModels.map(m => `<code>${escapeHtml(m)}</code>`).join(' ')}</span>
    <span class="key">RPC Records</span>      <span class="val">${rpcRecords.length}</span>
    <span class="key">DOM Rows</span>         <span class="val">${allDomRows.length}</span>
  </div>

  <h2>Column Headers (UI)</h2>
  ${columnHeaders.length > 0 ? `
  <div class="scroll-wrap">
    <table>
      <thead><tr>
        <th style="background:#1e293b;padding:8px 12px;text-align:left;color:#94a3b8">Label</th>
        <th style="background:#1e293b;padding:8px 12px;text-align:left;color:#94a3b8">Technical Name</th>
        <th style="background:#1e293b;padding:8px 12px;text-align:left;color:#94a3b8">Title</th>
      </tr></thead>
      <tbody>${colHeaderHtml}</tbody>
    </table>
  </div>` : '<p style="color:#64748b;font-size:13px;margin-bottom:16px">No column headers extracted from the UI.</p>'}

  <h2>Bank-related Actions (ir.actions.act_window) — ${bankActions.length} found</h2>
  ${bankActions.length > 0 ? `
  <div class="scroll-wrap">
    <table>
      <thead><tr>
        <th style="background:#1e293b;padding:8px 12px;text-align:left;color:#94a3b8">ID</th>
        <th style="background:#1e293b;padding:8px 12px;text-align:left;color:#94a3b8">Name</th>
        <th style="background:#1e293b;padding:8px 12px;text-align:left;color:#94a3b8">Model</th>
        <th style="background:#1e293b;padding:8px 12px;text-align:left;color:#94a3b8">View Mode</th>
      </tr></thead>
      <tbody>${actionRowHtml}</tbody>
    </table>
  </div>` : '<p style="color:#64748b;font-size:13px;margin-bottom:16px">No bank-related actions found.</p>'}

  <h2>Bank-related Menus (ir.ui.menu) — ${bankMenus.length} found</h2>
  ${bankMenus.length > 0 ? `
  <div class="scroll-wrap">
    <table>
      <thead><tr>
        <th style="background:#1e293b;padding:8px 12px;text-align:left;color:#94a3b8">ID</th>
        <th style="background:#1e293b;padding:8px 12px;text-align:left;color:#94a3b8">Name</th>
        <th style="background:#1e293b;padding:8px 12px;text-align:left;color:#94a3b8">Complete Name</th>
        <th style="background:#1e293b;padding:8px 12px;text-align:left;color:#94a3b8">Action</th>
      </tr></thead>
      <tbody>${menuRowHtml}</tbody>
    </table>
  </div>` : '<p style="color:#64748b;font-size:13px;margin-bottom:16px">No bank-related menus found.</p>'}

  <h2>Data — ${primaryModel ?? 'Unknown Model'} (${recordCount} records, source: ${dataSource})</h2>
  ${recordCount > MAX_ROWS ? `<p class="warn">Showing first ${MAX_ROWS} of ${recordCount} records. See JSON file for full dataset.</p>` : ''}
  ${tableHeaders.length > 0 && displayRows.length > 0 ? `
  <div class="scroll-wrap">
    <table>
      <thead><tr>${thHtml}</tr></thead>
      <tbody>${tdHtml}</tbody>
    </table>
  </div>` : '<p style="color:#64748b;font-size:13px;margin-bottom:16px">No data rows to display.</p>'}

  <p style="color:#334155;font-size:11px;margin-top:32px">Full data saved to bank-data-investigation.json</p>
</body>
</html>`;

  fs.writeFileSync(REPORT, html);
  console.log(`  HTML report saved: ${REPORT}`);

  // ── Summary ────────────────────────────────────────────────────────────────
  console.log('\n========================================');
  console.log('INVESTIGATION SUMMARY');
  console.log('========================================');
  console.log(`  Bank Data URL   : ${bankDataUrl}`);
  console.log(`  Resolved model  : ${primaryModel ?? 'UNKNOWN'}`);
  console.log(`  RPC records     : ${rpcRecords.length}`);
  console.log(`  DOM rows        : ${allDomRows.length}`);
  console.log(`  Column headers  : ${columnHeaders.length}`);
  console.log(`  Bank actions    : ${bankActions.length}`);
  console.log(`  Bank menus      : ${bankMenus.length}`);
  console.log(`  JSON output     : ${DATA}`);
  console.log(`  HTML report     : ${REPORT}`);
  console.log('========================================\n');
});

// ─── Utility ──────────────────────────────────────────────────────────────────

function escapeHtml(s: string): string {
  return s
    .replace(/&/g,  '&amp;')
    .replace(/</g,  '&lt;')
    .replace(/>/g,  '&gt;')
    .replace(/"/g,  '&quot;')
    .replace(/'/g,  '&#039;');
}

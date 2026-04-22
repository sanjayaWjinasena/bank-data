/**
 * Bank Technical Audit — Playwright Script
 * Activates debug mode, navigates Technical menu, extracts all bank-related
 * models/fields/actions/views via RPC, generates a rich HTML report.
 *
 * Sections covered:
 *   Step 1 — Login + company switch (shared helpers)
 *   Step 2 — Activate debug mode via Ctrl+K command palette
 *   Step 3 — Navigate to Settings → Technical (verify it appears in debug mode)
 *   Step 4 — (UI verification only — data comes from RPC)
 *   Step 5 — RPC calls for models / fields / actions / views / server actions
 *   Step 6 — Generate rich dark-theme HTML report + raw JSON
 *
 * Output:
 *   bank-audit-output/bank-technical-audit-report.html
 *   bank-audit-output/bank-technical-audit-data.json
 *   bank-audit-output/screenshots/
 */

import { test, Page } from '@playwright/test';
import * as dotenv from 'dotenv';
import * as fs from 'fs';
import * as path from 'path';
import { login, selectCompany, BASE_URL, sleep } from '../helpers/payroll-helpers';

dotenv.config({ path: path.resolve(__dirname, '../..', '.env') });

// ─── Output paths ─────────────────────────────────────────────────────────────

const OUT     = path.join(__dirname, 'results');
const SS_DIR  = path.join(__dirname, 'screenshots');
const REPORT  = path.join(OUT, 'bank-technical-audit-report.html');
const DATA    = path.join(OUT, 'bank-technical-audit-data.json');

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

interface AuditData {
  generatedAt:   string;
  models:        IrModel[];
  fields:        IrField[];
  actions:       IrActionWindow[];
  views:         IrView[];
  serverActions: IrActionServer[];
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
          method: 'call',
          id: 1,
          params: { model, method, args, kwargs },
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

// ─── Step 2: Activate debug mode ─────────────────────────────────────────────

async function activateDebugMode(page: Page): Promise<void> {
  console.log('\n[Step 2] Activating debug mode via Ctrl+K command palette...');

  // Press Ctrl+K to open the Odoo command palette
  await page.keyboard.press('Control+k');
  await sleep(1200);

  // Wait for the command palette overlay to appear
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

  // Type "debug" into the palette search input
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
    // Palette may already have focus — type directly
    await page.keyboard.type('debug');
    console.log('  Typed "debug" via keyboard (no specific input found)');
  }

  await sleep(1000);

  // Look for the "Activate developer mode" result and click it
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
    // Try a broader text match
    const anyDebugItem = page.locator('text=/activate.*developer/i, text=/enable.*debug/i, text=/debug mode/i').first();
    if (await anyDebugItem.isVisible({ timeout: 2000 }).catch(() => false)) {
      await anyDebugItem.click();
      debugClicked = true;
      console.log('  Clicked debug item via broad text match');
    }
  }

  if (!debugClicked) {
    // Escape palette and fall back to direct URL
    await page.keyboard.press('Escape');
    await sleep(500);
    console.log('  Debug item not found in palette — falling back to direct URL navigation');
    await page.goto(`${BASE_URL}/web?debug=1`, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await sleep(2000);
  } else {
    // Wait for page to reload with debug=1 in URL
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
  // Check for debug manager (bug icon) in the navbar
  const debugIcon = page.locator('.o_debug_manager, [title*="debug"], [title*="Debug"]').first();
  if (await debugIcon.isVisible({ timeout: 3000 }).catch(() => false)) {
    console.log('  Debug mode confirmed via navbar bug icon');
    return;
  }
  console.log(`  Warning: debug mode unconfirmed — URL: ${url}`);
}

// ─── Step 3: Navigate to Settings → Technical ─────────────────────────────────

async function navigateToSettingsTechnical(page: Page): Promise<void> {
  console.log('\n[Step 3] Navigating to Settings → Technical...');

  // Navigate to Settings with debug mode active
  await page.goto(`${BASE_URL}/odoo/settings?debug=1`, {
    waitUntil: 'domcontentloaded',
    timeout: 30000,
  });
  await sleep(2000);

  // Try to click "Technical" in the top settings navbar
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
    console.log('  Technical menu not found in Settings — this is OK, RPC data collection continues');
  } else {
    await sleep(1000);
    // Take screenshot of Technical dropdown open
    await screenshot(page, '03_settings_technical_menu');
    // Close dropdown by pressing Escape so we don't accidentally navigate away
    await page.keyboard.press('Escape');
    await sleep(500);
  }

  await screenshot(page, '02_settings_page_debug');
}

// ─── Step 5: RPC data collection ──────────────────────────────────────────────

async function collectAllBankData(page: Page): Promise<AuditData> {
  console.log('\n[Step 5] Collecting bank-related data via RPC...');

  // 5-1: Models where technical name contains "bank"
  console.log('  Fetching ir.model (bank models)...');
  const models = await searchRead<IrModel>(
    page,
    'ir.model',
    [['model', 'ilike', 'bank']],
    ['name', 'model', 'modules', 'info', 'transient']
  );
  console.log(`  Found ${models.length} models`);

  // 5-2: Fields on bank-related models
  console.log('  Fetching ir.model.fields (fields on bank models)...');
  const fieldsByModel = await searchRead<IrField>(
    page,
    'ir.model.fields',
    [['model_id.model', 'ilike', 'bank']],
    ['name', 'field_description', 'ttype', 'model_id', 'required', 'readonly',
     'store', 'help', 'related', 'compute', 'depends', 'index', 'groups']
  );
  console.log(`  Found ${fieldsByModel.length} fields from bank models`);

  // 5-3: Fields with "bank" in the field name (across ALL models)
  console.log('  Fetching ir.model.fields (fields named *bank*)...');
  const fieldsByName = await searchRead<IrField>(
    page,
    'ir.model.fields',
    [['name', 'ilike', 'bank']],
    ['name', 'field_description', 'ttype', 'model_id', 'required', 'readonly',
     'store', 'help', 'related', 'compute', 'depends', 'index', 'groups']
  );
  console.log(`  Found ${fieldsByName.length} fields named *bank*`);

  // Merge and deduplicate by id
  const fieldMap = new Map<number, IrField>();
  for (const f of [...fieldsByModel, ...fieldsByName]) {
    fieldMap.set(f.id, f);
  }
  const fields = Array.from(fieldMap.values()).sort((a, b) => {
    const ma = typeof a.model_id === 'object' ? a.model_id[1] : '';
    const mb = typeof b.model_id === 'object' ? b.model_id[1] : '';
    return ma.localeCompare(mb) || a.name.localeCompare(b.name);
  });
  console.log(`  Deduplicated: ${fields.length} unique fields`);

  // 5-4: Window actions on bank models
  console.log('  Fetching ir.actions.act_window (bank actions)...');
  const actions = await searchRead<IrActionWindow>(
    page,
    'ir.actions.act_window',
    [['res_model', 'ilike', 'bank']],
    ['name', 'res_model', 'view_mode', 'domain', 'context', 'help',
     'binding_model_id', 'groups_id']
  );
  console.log(`  Found ${actions.length} window actions`);

  // 5-5: Views on bank models
  console.log('  Fetching ir.ui.view (bank views)...');
  const views = await searchRead<IrView>(
    page,
    'ir.ui.view',
    [['model', 'ilike', 'bank']],
    ['name', 'type', 'model', 'priority', 'inherit_id', 'arch', 'active']
  );
  console.log(`  Found ${views.length} views`);

  // 5-6: Server actions on bank models
  console.log('  Fetching ir.actions.server (bank server actions)...');
  const serverActions = await searchRead<IrActionServer>(
    page,
    'ir.actions.server',
    [['model_name', 'ilike', 'bank']],
    ['name', 'model_id', 'model_name', 'state', 'code', 'binding_model_id']
  ).catch(async () => {
    // Fallback: model_name field may not exist in all Odoo versions
    console.log('  Retrying server actions with model_id.model domain...');
    return searchRead<IrActionServer>(
      page,
      'ir.actions.server',
      [['model_id.model', 'ilike', 'bank']],
      ['name', 'model_id', 'model_name', 'state', 'code', 'binding_model_id']
    );
  });
  console.log(`  Found ${serverActions.length} server actions`);

  return {
    generatedAt:   new Date().toISOString(),
    models,
    fields,
    actions,
    views,
    serverActions,
  };
}

// ─── Step 6: HTML report builder ──────────────────────────────────────────────

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
    char:       '#3b82f6',  // blue
    text:       '#eab308',  // yellow
    html:       '#ca8a04',  // yellow-dark
    many2one:   '#8b5cf6',  // purple
    one2many:   '#f97316',  // orange
    many2many:  '#ef4444',  // red
    boolean:    '#22c55e',  // green
    integer:    '#14b8a6',  // teal
    float:      '#0d9488',  // teal-dark
    monetary:   '#06b6d4',  // cyan
    date:       '#6366f1',  // indigo
    datetime:   '#4f46e5',  // indigo-dark
    binary:     '#6b7280',  // grey
    selection:  '#d97706',  // amber
    reference:  '#c026d3',  // fuchsia
    serialized: '#78716c',  // stone
    json:       '#78716c',  // stone
  };
  const bg = colours[ttype] ?? '#475569';
  return `<span style="background:${bg};color:#fff;padding:2px 7px;border-radius:4px;font-size:11px;font-weight:600;white-space:nowrap">${esc(ttype)}</span>`;
}

/** Small badge for boolean flags (required, readonly, etc.) */
function boolBadge(val: boolean, trueLabel: string, trueColor: string): string {
  if (!val) return '';
  return `<span style="background:${trueColor};color:#fff;padding:1px 6px;border-radius:4px;font-size:10px;font-weight:600">${trueLabel}</span>`;
}

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

function buildFieldsTable(fields: IrField[]): string {
  if (!fields.length) return '<p style="color:#64748b">No fields found.</p>';
  const rows = fields.map(f => {
    const modelLabel = Array.isArray(f.model_id) ? f.model_id[1] : String(f.model_id);
    const flags = [
      boolBadge(f.required, 'required', '#dc2626'),
      boolBadge(f.readonly, 'readonly', '#0369a1'),
      boolBadge(!f.store,   'non-stored', '#78716c'),
      boolBadge(f.index,    'indexed',  '#065f46'),
    ].filter(Boolean).join(' ');
    const compute = f.compute ? `<code style="color:#a78bfa;font-size:11px">${esc(f.compute)}</code>` : '';
    const related = f.related ? `<span style="color:#94a3b8;font-size:11px">→ ${esc(f.related)}</span>` : '';
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
    const stateBg = stateColors[sa.state] ?? '#334155';
    const stateBadge = `<span style="background:${stateBg};color:#fff;padding:2px 7px;border-radius:4px;font-size:11px;font-weight:600">${esc(sa.state)}</span>`;
    const codeBlock = sa.code
      ? `<pre style="margin:0;background:#0d1117;color:#a5f3fc;font-size:11px;padding:8px;border-radius:4px;white-space:pre-wrap;max-width:500px;overflow:auto;max-height:200px">${esc(sa.code)}</pre>`
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

function buildHtmlReport(data: AuditData): string {
  const ts = new Date(data.generatedAt).toLocaleString('en-US', {
    dateStyle: 'full', timeStyle: 'medium',
  });

  const summary = [
    { label: 'Models',         count: data.models.length,        color: '#3b82f6' },
    { label: 'Fields',         count: data.fields.length,        color: '#8b5cf6' },
    { label: 'Window Actions', count: data.actions.length,       color: '#22c55e' },
    { label: 'Views',          count: data.views.length,         color: '#f97316' },
    { label: 'Server Actions', count: data.serverActions.length, color: '#ef4444' },
  ];

  const summaryHtml = summary
    .map(s => `<div class="summary-badge" style="border-color:${s.color}">
      <span class="summary-count" style="color:${s.color}">${s.count}</span>
      <span class="summary-label">${s.label}</span>
    </div>`)
    .join('');

  const tabs = [
    { id: 'models',        label: `Models (${data.models.length})`,               content: buildModelsTable(data.models) },
    { id: 'fields',        label: `Fields (${data.fields.length})`,               content: buildFieldsTable(data.fields) },
    { id: 'actions',       label: `Window Actions (${data.actions.length})`,      content: buildActionsTable(data.actions) },
    { id: 'views',         label: `Views (${data.views.length})`,                 content: buildViewsTable(data.views) },
    { id: 'serveractions', label: `Server Actions (${data.serverActions.length})`, content: buildServerActionsTable(data.serverActions) },
  ];

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
  <title>Bank Technical Audit — Odoo 17</title>
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
    <h1>Bank Technical Audit</h1>
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

test('Bank Technical Audit — Models, Fields, Actions, Views', async ({ page }) => {
  // Create output directories
  fs.mkdirSync(OUT, { recursive: true });
  fs.mkdirSync(SS_DIR, { recursive: true });

  // ── Step 1: Login + Company Switch ─────────────────────────────────────────
  console.log('\n[Step 1] Logging in and switching company...');
  await login(page);
  await screenshot(page, '01a_after_login');

  await selectCompany(page);
  await screenshot(page, '01b_after_company_switch');
  console.log('  Login and company switch complete');

  // ── Step 2: Activate debug mode ────────────────────────────────────────────
  await activateDebugMode(page);
  await screenshot(page, '02_debug_active');

  // ── Step 3: Navigate to Settings → Technical (verification + screenshot) ──
  await navigateToSettingsTechnical(page);

  // ── Step 5: Collect data via RPC ───────────────────────────────────────────
  // Navigate to a stable page that has an active session before making RPC calls
  await page.goto(`${BASE_URL}/web?debug=1`, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await sleep(2000);

  const auditData = await collectAllBankData(page);

  // ── Save raw JSON ───────────────────────────────────────────────────────────
  fs.writeFileSync(DATA, JSON.stringify(auditData, null, 2));
  console.log(`\n[Output] Raw JSON saved to: ${DATA}`);

  // ── Step 6: Generate HTML report ───────────────────────────────────────────
  console.log('\n[Step 6] Generating HTML report...');
  const html = buildHtmlReport(auditData);
  fs.writeFileSync(REPORT, html);
  console.log(`[Output] HTML report saved to: ${REPORT}`);

  // Final summary
  console.log('\n=== AUDIT COMPLETE ===');
  console.log(`  Models:         ${auditData.models.length}`);
  console.log(`  Fields:         ${auditData.fields.length}`);
  console.log(`  Window Actions: ${auditData.actions.length}`);
  console.log(`  Views:          ${auditData.views.length}`);
  console.log(`  Server Actions: ${auditData.serverActions.length}`);
  console.log('======================\n');
});

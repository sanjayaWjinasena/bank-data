/**
 * Repair Module Audit — Playwright Script
 * Checks what is already in place for the Jinasena Repair Module customization.
 *
 * Checks:
 *   1. Custom models (x_ models from ER diagram)
 *   2. Fields on helpdesk.ticket (all x_studio_ fields)
 *   3. Fields on stock.picking (Transfer)
 *   4. Fields on project.task
 *   5. Fields on sale.order
 *   6. Fields on account.payment
 *   7. Fields on account.move
 *   8. Server actions (repair buttons)
 *   9. Helpdesk ticket stages
 *  10. Inherited views (helpdesk.ticket.form + project.task.form)
 *
 * Output:
 *   bank-audit-output/repair-audit-report.html
 *   bank-audit-output/repair-audit-data.json
 */

import { test, Page } from '@playwright/test';
import * as dotenv from 'dotenv';
import * as fs from 'fs';
import * as path from 'path';
import { login, selectCompany, BASE_URL, sleep } from '../helpers/payroll-helpers';

dotenv.config({ path: path.resolve(__dirname, '../..', '.env') });

// ─── Output paths ─────────────────────────────────────────────────────────────

const OUT    = path.join(__dirname, 'results');
const REPORT = path.join(OUT, 'repair-audit-report.html');
const DATA   = path.join(OUT, 'repair-audit-data.json');

// ─── RPC helpers ──────────────────────────────────────────────────────────────

async function rpc<T = unknown>(
  page: Page,
  model: string,
  method: string,
  args: unknown[],
  kwargs: Record<string, unknown> = {}
): Promise<T> {
  return page.evaluate(
    async ({ base, model, method, args, kwargs }) => {
      const res = await fetch(`${base}/web/dataset/call_kw`, {
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
    { base: BASE_URL, model, method, args, kwargs }
  ) as T;
}

async function searchRead<T>(
  page: Page,
  model: string,
  domain: unknown[],
  fields: string[],
  limit = 0
): Promise<T[]> {
  return rpc<T[]>(page, model, 'search_read', [domain], {
    fields, limit, order: 'id asc', context: { lang: 'en_US' },
  });
}

// ─── Expected definitions (from spec PDF) ────────────────────────────────────

const EXPECTED_CUSTOM_MODELS = [
  { technical: 'x_task_diagnosis',     label: 'Task Diagnosis' },
  { technical: 'x_conditions',         label: 'Conditions' },
  { technical: 'x_diagnosis_areas',    label: 'Diagnosis Areas' },
  { technical: 'x_diagnosis_codes',    label: 'Diagnosis Codes' },
  { technical: 'x_repair_reason',      label: 'Repair Reason' },
  { technical: 'x_repair_stages',      label: 'Repair Stage' },
  { technical: 'x_resolutions',        label: 'Resolution' },
  { technical: 'x_repair_sub_reason',  label: 'Repair Sub Reason' },
  { technical: 'x_symptom_areas',      label: 'Symptom Areas' },
  { technical: 'x_symptom_codes',      label: 'Symptom Codes' },
];

const EXPECTED_FIELDS: Record<string, string[]> = {
  'helpdesk.ticket': [
    // Stage + flow booleans
    'x_studio_cancelled',
    'x_studio_repair_complete_stage_updated',
    'x_studio_estimation_sent_stage_updated',
    'x_studio_estimation_approved_stage_updated',
    'x_studio_repair_started_stage_updated',
    'x_studio_invoice_stage_updated',
    'x_studio_handed_over',
    'x_studio_rug_approved',
    'x_studio_send_to_factory',
    'x_studio_receive_at_factory',
    'x_studio_send_to_centre',
    'x_studio_receive_at_centre',
    'x_studio_sn_updated',
    'x_studio_repair_serial_created',
    'x_studio_normal_repair_without_serial_no',
    'x_studio_normal_repair_with_serial_no',
    'x_studio_rug_repair',
    'x_studio_warranty_card',
    // Relations
    'x_studio_pick_id',
    'x_studio_virtual_location_id',
    'x_studio_repair_reason',
    'x_studio_return_receipt_location',
    'x_studio_serial_no',
    'x_studio_source_location',
    // Selection
    'x_studio_job_location',
    'x_studio_quick_repair_status',
    'x_studio_cancel_status',
    'x_studio_repair_status',
    // Audit trail
    'x_studio_stage_date',
    'x_studio_created_by_1',
    'x_studio_created_by_4',
    'x_studio_created_by_5',
    'x_studio_created_by_6',
    'x_studio_created_by_7',
    'x_studio_created_by_8',
    'x_studio_created_on_1',
    'x_studio_created_on_4',
    'x_studio_created_on_5',
    'x_studio_created_on_6',
    'x_studio_created_on_7',
    'x_studio_created_on_8',
    // Computed
    'x_studio_fsm_task_done',
    'x_studio_fully_paid_so',
    'x_studio_handed_over',
    'x_studio_re_estimate_count',
    'x_studio_sale_order',
    'x_studio_task_status',
    'x_studio_valid_confirm_return',
    'x_studio_valid_confirmed2_so',
    'x_studio_valid_confirmed_so',
    'x_studio_valid_delivered_so',
    'x_studio_valid_invoiced_so',
    'x_studio_valid_return',
    // Extra
    'x_studio_receive_at_centre',
    'x_studio_minimals_availability',
    'x_studio_invoice_price',
    'x_studio_unit_price',
    'x_studio_valid_confirmed_so',
    'x_studio_estimation_approved_stage_updated',
    'x_studio_pick_id',
    'x_studio_picking_count',
    'x_studio_repair_location',
    'x_studio_repair_serial_no',
  ],

  'stock.picking': [
    'x_studio_cancelled',
    'x_studio_cash_full_payment_mode',
    'x_studio_helpdesk_ticket_id',
    'x_studio_created_from_help_ticket',
    'x_studio_ticket_sales_order',
    'x_studio_form_task_items',
    'x_studio_removed_at_centre',
    'x_studio_repair_return_location',
    'x_studio_factory_repair',
    'x_studio_received_at_centre',
    'x_studio_picking_count',
    'x_studio_valid_factory_repair',
    // Computed
    'x_studio_cash_full_payment_made',
    'x_studio_fsm_task_done',
    'x_studio_fully_paid_so',
    'x_studio_repair_payment_made',
    'x_studio_valid_factory_repair',
  ],

  'project.task': [
    'x_studio_diagnosis_ids',
    'x_studio_repair_image_01',
    'x_studio_quick_repair_status',
    'x_studio_end_quick_repair',
    'x_studio_cancelled',
    'x_studio_repair_reason',
    'x_studio_repair_stage',
    'x_studio_repair_information',
    'x_studio_quotation_type',
    'x_studio_payment_type',
    'x_studio_warranty_card',
    // Computed
    'x_studio_valid_confirm_so',
    'x_studio_valid_confirm2_so',
    'x_studio_valid_delivered_so',
    'x_studio_valid_delivered_so2',
    'x_studio_valid_invoiced_so',
    'x_studio_fully_invoiced_so',
    'x_studio_incomplete_delivery_available',
    'x_studio_valid_diagnosis',
  ],

  'sale.order': [
    'x_studio_quotation_type',
    'x_studio_order_payment_method',
    'x_studio_rug_approved',
    'x_studio_re_estimate_count',
    'x_studio_cancelled',
    'x_studio_tag_approved',
    'x_studio_tag_confirmed',
    'x_studio_tag_rejected',
    'x_studio_tag_request_sent',
    'x_studio_customer_payment_method',
    // Computed
    'x_studio_fully_paid',
    'x_studio_fsm_done',
  ],

  'account.payment': [
    'x_studio_quotation_type',
    'x_studio_sales_order',
    'x_studio_acc_updated',
    'x_studio_tag_updated',
    'x_studio_tag_rejected',
    // Computed
    'x_studio_payment_validation',
  ],

  'account.move': [
    'x_studio_sale_id',
    'x_studio_acc_updated',
    'x_studio_tag_updated',
    'x_studio_tag_rejected',
  ],
};

// Server actions referenced by name/string in the view XML
const EXPECTED_SERVER_ACTIONS = [
  'Change Repair Type To RUG',
  'Update Serial',
  'Create Repair Serial',
  'Create Repair Route',
  'Send to Factory',
  'Receive at Factory',
  'Send to Sales Centre',
  'Receive at Sales Centre',
  'Cancel',
  'Reopen',
  'View Repair Diagnosis Validation',
  'View Repair Image Validation',
  'Tested OK',
];

// Inherited view names added by Studio for the repair module
const EXPECTED_VIEWS = [
  { model: 'helpdesk.ticket', keyword: 'helpdesk.ticket.form' },
  { model: 'project.task',    keyword: 'project.task.form' },
  { model: 'project.task',    keyword: 'view.task.form2' },
  { model: 'project.task',    keyword: 'task.form.inherit' },
  { model: 'project.task',    keyword: 'view.form.fsm.inherit.quotation' },
];

// Helpdesk stages referenced in computed field side-effects
const EXPECTED_STAGES = [
  { id: 3,  hint: 'Invoice / Invoiced' },
  { id: 9,  hint: 'Repair Complete' },
  { id: 10, hint: 'Estimation Sent' },
  { id: 11, hint: 'Repair Started' },
  { id: 12, hint: 'Estimation Approved' },
  { id: 13, hint: 'Handed Over' },
];

// ─── Types ────────────────────────────────────────────────────────────────────

interface FieldRecord {
  id: number;
  name: string;
  field_description: string;
  ttype: string;
  store: boolean;
  compute: string | false;
}

interface ModelRecord {
  id: number;
  name: string;
  model: string;
}

interface ServerActionRecord {
  id: number;
  name: string;
  model_name: string;
  state: string;
}

interface ViewRecord {
  id: number;
  name: string;
  model: string;
  type: string;
  inherit_id: [number, string] | false;
}

interface StageRecord {
  id: number;
  name: string;
}

interface CheckResult {
  label: string;
  found: boolean;
  detail?: string;
}

interface ModelFieldAudit {
  model: string;
  expected: string[];
  found: FieldRecord[];
  present: CheckResult[];
}

interface AuditReport {
  generatedAt:    string;
  customModels:   CheckResult[];
  fieldsByModel:  ModelFieldAudit[];
  serverActions:  CheckResult[];
  views:          CheckResult[];
  stages:         CheckResult[];
}

// ─── Main Test ────────────────────────────────────────────────────────────────

test('Repair Module — What is Already in Place', async ({ page }) => {
  test.setTimeout(0);
  fs.mkdirSync(OUT, { recursive: true });

  // ── Login ──────────────────────────────────────────────────────────────────
  console.log('\n[Step 1] Login + company switch...');
  await login(page);
  await selectCompany(page);
  await sleep(1500);

  // ── 1. Custom Models ───────────────────────────────────────────────────────
  console.log('\n[Step 1] Checking custom models...');
  const allModels = await searchRead<ModelRecord>(
    page, 'ir.model',
    [['model', 'like', 'x_']],
    ['id', 'name', 'model']
  );
  const existingModelNames = new Set(allModels.map(m => m.model));

  const customModelResults: CheckResult[] = EXPECTED_CUSTOM_MODELS.map(m => ({
    label: `${m.label} (${m.technical})`,
    found: existingModelNames.has(m.technical),
    detail: existingModelNames.has(m.technical)
      ? allModels.find(r => r.model === m.technical)?.name
      : undefined,
  }));

  // ── 2. Fields per model ────────────────────────────────────────────────────
  console.log('\n[Step 2] Checking fields on existing models...');
  const fieldsByModel: ModelFieldAudit[] = [];

  for (const [modelName, expectedFields] of Object.entries(EXPECTED_FIELDS)) {
    console.log(`  → ${modelName} (${expectedFields.length} expected fields)`);

    const foundFields = await searchRead<FieldRecord>(
      page, 'ir.model.fields',
      [['model_id.model', '=', modelName], ['name', 'like', 'x_studio_']],
      ['id', 'name', 'field_description', 'ttype', 'store', 'compute']
    );

    const foundNames = new Set(foundFields.map(f => f.name));

    const present: CheckResult[] = expectedFields.map(fname => {
      const rec = foundFields.find(f => f.name === fname);
      return {
        label: fname,
        found: foundNames.has(fname),
        detail: rec ? `${rec.ttype}${rec.compute ? ' [computed]' : ''}${rec.store ? ' [stored]' : ''}` : undefined,
      };
    });

    fieldsByModel.push({ model: modelName, expected: expectedFields, found: foundFields, present });
  }

  // ── 3. Server Actions ──────────────────────────────────────────────────────
  console.log('\n[Step 3] Checking server actions...');
  const allServerActions = await searchRead<ServerActionRecord>(
    page, 'ir.actions.server',
    [['model_name', 'in', ['helpdesk.ticket', 'project.task', 'stock.picking']]],
    ['id', 'name', 'model_name', 'state']
  );
  const serverActionNames = allServerActions.map(a => a.name.toLowerCase());

  const serverActionResults: CheckResult[] = EXPECTED_SERVER_ACTIONS.map(name => {
    const match = allServerActions.find(a =>
      a.name.toLowerCase().includes(name.toLowerCase())
    );
    return {
      label: name,
      found: !!match,
      detail: match ? `ID:${match.id} on ${match.model_name}` : undefined,
    };
  });

  // ── 4. Views ───────────────────────────────────────────────────────────────
  console.log('\n[Step 4] Checking inherited views...');
  const allViews = await searchRead<ViewRecord>(
    page, 'ir.ui.view',
    [['model', 'in', ['helpdesk.ticket', 'project.task']], ['inherit_id', '!=', false]],
    ['id', 'name', 'model', 'type', 'inherit_id']
  );

  const viewResults: CheckResult[] = EXPECTED_VIEWS.map(v => {
    const matches = allViews.filter(
      r => r.model === v.model && r.name.toLowerCase().includes(v.keyword.toLowerCase())
    );
    return {
      label: `${v.model} — ${v.keyword}`,
      found: matches.length > 0,
      detail: matches.length > 0
        ? matches.map(m => `${m.name} (ID:${m.id})`).join(', ')
        : undefined,
    };
  });

  // ── 5. Helpdesk Stages ─────────────────────────────────────────────────────
  console.log('\n[Step 5] Checking helpdesk stages...');
  const allStages = await searchRead<StageRecord>(
    page, 'helpdesk.stage',
    [],
    ['id', 'name']
  );
  const stageIds = new Set(allStages.map(s => s.id));

  const stageResults: CheckResult[] = EXPECTED_STAGES.map(s => {
    const rec = allStages.find(r => r.id === s.id);
    return {
      label: `Stage ID ${s.id} — expected: "${s.hint}"`,
      found: stageIds.has(s.id),
      detail: rec ? `"${rec.name}"` : undefined,
    };
  });

  // ── Compile report ─────────────────────────────────────────────────────────
  const report: AuditReport = {
    generatedAt:   new Date().toISOString(),
    customModels:  customModelResults,
    fieldsByModel,
    serverActions: serverActionResults,
    views:         viewResults,
    stages:        stageResults,
  };

  fs.writeFileSync(DATA, JSON.stringify(report, null, 2));
  console.log(`\n[Data] Saved → ${DATA}`);

  // ── Generate HTML Report ───────────────────────────────────────────────────
  const html = generateHtml(report);
  fs.writeFileSync(REPORT, html);
  console.log(`[Report] Saved → ${REPORT}`);

  // ── Console summary ────────────────────────────────────────────────────────
  console.log('\n════════════════════════════════════════');
  console.log(' REPAIR MODULE AUDIT — SUMMARY');
  console.log('════════════════════════════════════════');

  const customFound    = customModelResults.filter(r => r.found).length;
  const customTotal    = customModelResults.length;
  const stagesFound    = stageResults.filter(r => r.found).length;
  const stagesTotal    = stageResults.length;
  const actionsFound   = serverActionResults.filter(r => r.found).length;
  const actionsTotal   = serverActionResults.length;
  const viewsFound     = viewResults.filter(r => r.found).length;
  const viewsTotal     = viewResults.length;

  let totalFields = 0, foundFields = 0;
  for (const audit of fieldsByModel) {
    totalFields += audit.expected.length;
    foundFields += audit.present.filter(r => r.found).length;
  }

  console.log(`  Custom Models : ${customFound}/${customTotal}`);
  console.log(`  Fields        : ${foundFields}/${totalFields}`);
  console.log(`  Server Actions: ${actionsFound}/${actionsTotal}`);
  console.log(`  Views         : ${viewsFound}/${viewsTotal}`);
  console.log(`  Stages        : ${stagesFound}/${stagesTotal}`);
  console.log('════════════════════════════════════════\n');
});

// ─── HTML Report Generator ────────────────────────────────────────────────────

function generateHtml(report: AuditReport): string {
  function badge(found: boolean): string {
    return found
      ? `<span class="badge found">✓ Found</span>`
      : `<span class="badge missing">✗ Missing</span>`;
  }

  function checkTable(items: CheckResult[], showDetail = true): string {
    const rows = items.map(r => `
      <tr class="${r.found ? 'row-found' : 'row-missing'}">
        <td>${badge(r.found)}</td>
        <td><code>${r.label}</code></td>
        ${showDetail ? `<td class="detail">${r.detail ?? '—'}</td>` : ''}
      </tr>`).join('');
    return `<table>
      <thead><tr>
        <th>Status</th><th>Name</th>${showDetail ? '<th>Detail</th>' : ''}
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
  }

  function progressBar(found: number, total: number): string {
    const pct = total > 0 ? Math.round((found / total) * 100) : 0;
    const color = pct === 100 ? '#22c55e' : pct >= 50 ? '#f59e0b' : '#ef4444';
    return `<div class="progress-wrap">
      <div class="progress-bar" style="width:${pct}%;background:${color}"></div>
    </div>
    <span class="progress-label">${found}/${total} (${pct}%)</span>`;
  }

  // Per-model field sections
  const modelSections = report.fieldsByModel.map(audit => {
    const found  = audit.present.filter(r => r.found).length;
    const total  = audit.expected.length;
    const extra  = audit.found.filter(f => !audit.expected.includes(f.name));
    return `
    <section>
      <h3>${audit.model}</h3>
      ${progressBar(found, total)}
      ${checkTable(audit.present)}
      ${extra.length > 0 ? `
        <details>
          <summary>Extra x_studio_ fields found on this model (${extra.length})</summary>
          <table>
            <thead><tr><th>Field</th><th>Type</th><th>Label</th></tr></thead>
            <tbody>${extra.map(f => `<tr>
              <td><code>${f.name}</code></td>
              <td>${f.ttype}</td>
              <td>${f.field_description}</td>
            </tr>`).join('')}</tbody>
          </table>
        </details>` : ''}
    </section>`;
  }).join('');

  // Summary stats
  const customFound  = report.customModels.filter(r => r.found).length;
  const actionsFound = report.serverActions.filter(r => r.found).length;
  const viewsFound   = report.views.filter(r => r.found).length;
  const stagesFound  = report.stages.filter(r => r.found).length;
  let totalF = 0, foundF = 0;
  for (const a of report.fieldsByModel) { totalF += a.expected.length; foundF += a.present.filter(r => r.found).length; }

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<title>Repair Module Audit</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: 'Segoe UI', sans-serif; background: #0f172a; color: #e2e8f0; padding: 2rem; }
  h1 { color: #38bdf8; font-size: 2rem; margin-bottom: 0.25rem; }
  .subtitle { color: #94a3b8; margin-bottom: 2rem; font-size: 0.9rem; }
  h2 { color: #7dd3fc; font-size: 1.3rem; margin: 2rem 0 1rem; border-bottom: 1px solid #1e3a5f; padding-bottom: 0.5rem; }
  h3 { color: #93c5fd; font-size: 1.05rem; margin: 1.5rem 0 0.5rem; }
  section { background: #1e293b; border-radius: 8px; padding: 1.25rem; margin-bottom: 1rem; }
  table { width: 100%; border-collapse: collapse; font-size: 0.85rem; margin: 0.75rem 0; }
  th { background: #0f172a; color: #94a3b8; padding: 0.5rem 0.75rem; text-align: left; }
  td { padding: 0.4rem 0.75rem; border-bottom: 1px solid #1e3a5f; }
  tr.row-found  td { background: #0f2a1a; }
  tr.row-missing td { background: #2a0f0f; }
  code { font-family: monospace; font-size: 0.82rem; color: #a5f3fc; }
  .badge { padding: 2px 8px; border-radius: 12px; font-size: 0.75rem; font-weight: bold; white-space: nowrap; }
  .badge.found   { background: #166534; color: #86efac; }
  .badge.missing { background: #7f1d1d; color: #fca5a5; }
  .detail { color: #94a3b8; font-size: 0.8rem; }
  .summary-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 1rem; margin-bottom: 2rem; }
  .stat-card { background: #1e293b; border-radius: 8px; padding: 1.25rem; text-align: center; }
  .stat-num { font-size: 2rem; font-weight: bold; color: #38bdf8; }
  .stat-label { color: #94a3b8; font-size: 0.85rem; margin-top: 0.25rem; }
  .progress-wrap { background: #0f172a; border-radius: 4px; height: 8px; margin: 0.5rem 0 0.25rem; overflow: hidden; }
  .progress-bar  { height: 100%; border-radius: 4px; transition: width 0.3s; }
  .progress-label { font-size: 0.8rem; color: #94a3b8; }
  details { margin-top: 0.75rem; }
  details summary { cursor: pointer; color: #7dd3fc; font-size: 0.85rem; padding: 0.3rem 0; }
  details summary:hover { color: #38bdf8; }
</style>
</head>
<body>
<h1>Repair Module — Audit Report</h1>
<p class="subtitle">Generated: ${report.generatedAt}</p>

<div class="summary-grid">
  <div class="stat-card">
    <div class="stat-num">${customFound}/${report.customModels.length}</div>
    <div class="stat-label">Custom Models</div>
  </div>
  <div class="stat-card">
    <div class="stat-num">${foundF}/${totalF}</div>
    <div class="stat-label">Expected Fields</div>
  </div>
  <div class="stat-card">
    <div class="stat-num">${actionsFound}/${report.serverActions.length}</div>
    <div class="stat-label">Server Actions</div>
  </div>
  <div class="stat-card">
    <div class="stat-num">${viewsFound}/${report.views.length}</div>
    <div class="stat-label">Inherited Views</div>
  </div>
  <div class="stat-card">
    <div class="stat-num">${stagesFound}/${report.stages.length}</div>
    <div class="stat-label">Helpdesk Stages</div>
  </div>
</div>

<h2>1. Custom Models (x_ models)</h2>
<section>${checkTable(report.customModels)}</section>

<h2>2. Fields on Existing Models</h2>
${modelSections}

<h2>3. Server Actions</h2>
<section>${checkTable(report.serverActions)}</section>

<h2>4. Inherited Views</h2>
<section>${checkTable(report.views)}</section>

<h2>5. Helpdesk Stages</h2>
<section>${checkTable(report.stages)}</section>

</body>
</html>`;
}

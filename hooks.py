from odoo import api, SUPERUSER_ID


def post_migrate(cr, registry):
    env = api.Environment(cr, SUPERUSER_ID, {})

    # ── 1. Remove stale views that reference deleted branch_id fields ────
    stale = env['ir.ui.view'].search([
        ('model', 'in', ['res.partner.bank', 'res.bank']),
        '|',
        ('arch_db', 'like', 'branch_id'),
        ('arch_db', 'like', 'branch_ids'),
    ])
    if stale:
        stale.unlink()

    # ── 2. Ensure the singleton config record exists ──────────────────────
    config = env['jinasena.paymaster.config'].get_config()

    # ── 3. Point action_paymaster_config to the singleton record ─────────
    action = env.ref('bank_data.action_paymaster_config', raise_if_not_found=False)
    if action and config:
        action.write({'res_id': config.id})

    # ── 4. Switch action 2895 (Bank Data) to hr.payslip + new view ───────
    payslip_view = env.ref(
        'bank_data.view_hr_payslip_bank_data_tree', raise_if_not_found=False
    )
    bank_action = env['ir.actions.act_window'].browse(2895)
    if payslip_view and bank_action.exists():
        bank_action.write({
            'res_model': 'hr.payslip',
            'view_id':   payslip_view.id,
            'view_mode': 'tree,form',
            'domain':    "[('net_wage', '>', 0)]",
            'context':   "{'search_default_my_payslip': 0}",
        })

    # ── 5. Add "Paymaster Config" menu item under Bank Data (menu 1477) ──
    if action:
        parent_menu = env['ir.ui.menu'].browse(1477)
        if parent_menu.exists():
            existing = env['ir.ui.menu'].search([
                ('parent_id', '=', parent_menu.id),
                ('name', '=', 'Paymaster Config'),
            ], limit=1)
            if not existing:
                env['ir.ui.menu'].create({
                    'name':      'Paymaster Config',
                    'parent_id': parent_menu.id,
                    'action':    f'ir.actions.act_window,{action.id}',
                    'sequence':  20,
                })

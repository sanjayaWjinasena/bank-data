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

    # ── 4. Add "Paymaster Config" menu item under Bank Data (menu 1477) ──
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

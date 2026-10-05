{
    'name': 'Jinasena : SubModule : Payroll : Bank Data',
    'version': '17.0.1.0.9',
    'category': 'Payroll',
    'summary': 'Generate CBC Paymaster file for bulk salary bank transfers (SLIPS)',
    'description': """
        Adds a "Generate Paymaster File" button to Payroll Batches.
        Produces a fixed-width .dat file in Commercial Bank of Sri Lanka
        Paymaster format (151 chars/record) for SLIPS bulk salary transfers.

        Custom fields added:
        - res.bank: x_micr_code (4-digit SLIPS bank MICR code)
        - res.partner.bank: x_branch_code (3-digit CBC branch code)
    """,
    'author': 'Jinasena',
    'depends': ['account', 'hr', 'hr_payroll', 'base', 'base_automation'],
    'data': [
        'security/ir.model.access.csv',
        'views/res_bank_views.xml',
        'views/res_partner_bank_views.xml',
        'views/paymaster_config_views.xml',
        'views/account_move_line_views.xml',
        'views/hr_payslip_bank_data_views.xml',
        'wizard/paymaster_wizard.xml',
        'views/hr_payslip_run_views.xml',
        'data/gap_automations.xml',
        'data/window_actions_gap.xml',
        'views/res_bank_e_views.xml',
        'views/res_partner_bank_e_views.xml',
        # menus_f6.xml references act_window_2895_bank_data defined in
        # window_actions_gap.xml — must load AFTER it.
        'data/menus_f6.xml',
    ],
    # Staging_Migration: repo-own existing Studio models before data loads.
    'pre_init_hook': 'pre_init_hook',
    'installable': True,
    'application': False,
    'license': 'LGPL-3',
    'post_migrate': 'odoo.addons.bank_data.hooks.post_migrate',
}

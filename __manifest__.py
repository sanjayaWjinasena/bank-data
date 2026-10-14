{
    "name": "Jinasena : SubModule : Payroll : Bank Data",
    "version": "17.0.1.0.10",
    "category": "Payroll",
    "summary": "Generate CBC Paymaster file for bulk salary bank transfers (SLIPS)",
    "author": "Jinasena Agricultural Machinery (Pvt) Ltd.",
    "depends": ["account", "hr", "hr_payroll", "base", "base_automation"],
    "data": [
        "security/ir.model.access.csv",
        "views/res_bank_views.xml",
        "views/res_partner_bank_views.xml",
        "views/paymaster_config_views.xml",
        "views/account_move_line_views.xml",
        "views/hr_payslip_bank_data_views.xml",
        "wizard/paymaster_wizard.xml",
        "views/hr_payslip_run_views.xml",
        "data/gap_automations.xml",
        "data/window_actions_gap.xml",
        "views/res_bank_e_views.xml",
        "views/res_partner_bank_e_views.xml",
        # menus_f6.xml references act_window_2895_bank_data defined in
        # window_actions_gap.xml — must load AFTER it.
        "data/menus_f6.xml",
    ],
    "application": False,
    "license": "LGPL-3",
    "post_migrate": "odoo.addons.bank_data.hooks.post_migrate",
}

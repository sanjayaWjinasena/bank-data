Jinasena : SubModule : Payroll : Bank Data
==========================================

Generate CBC Paymaster file for bulk salary bank transfers (SLIPS)

Adds a "Generate Paymaster File" button to Payroll Batches.
Produces a fixed-width .dat file in Commercial Bank of Sri Lanka
Paymaster format (151 chars/record) for SLIPS bulk salary transfers.

Custom fields added:

- res.bank: x_micr_code (4-digit SLIPS bank MICR code)
- res.partner.bank: x_branch_code (3-digit CBC branch code)

Information
-----------

* Technical name: ``bank-data``
* Version: ``17.0.1.0.10``
* Depends on: ``account``, ``hr``, ``hr_payroll``, ``base``, ``base_automation``
* Author: Jinasena Agricultural Machinery (Pvt) Ltd.
* License: LGPL-3

Further documentation
---------------------

* Functional documentation: ``Functional_Documentation.md``
* Change history: ``CHANGELOG.md``

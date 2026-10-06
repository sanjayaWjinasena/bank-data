# -*- coding: utf-8 -*-
"""Staging_Migration: on every upgrade, before this module's data reloads,
move ported xmlids off repo-created duplicates onto the Studio record they
were ported from (staging_adopt.rebind_duplicates). No-op once done and on
databases installed with staging_adopt v8. ORM only."""
import importlib.util
import os

from odoo import SUPERUSER_ID, api


def _staging_adopt():
    root = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    spec = importlib.util.spec_from_file_location(
        'staging_adopt_%s' % os.path.basename(root).replace('-', '_'), os.path.join(root, 'staging_adopt.py'))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def migrate(cr, version):
    if not version:
        return
    _staging_adopt().rebind_duplicates(api.Environment(cr, SUPERUSER_ID, {}))

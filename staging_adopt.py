# -*- coding: utf-8 -*-
"""Staging_Migration: repo-own the models this module defines (pre_init_hook).

On a database that still carries the Studio customizations (an Odoo.sh
staging copy of production), the custom models this module defines in
Python already exist as Studio models. Two things then break on install:
  * ir.model pin records try to CREATE the model again
    (ir_model_obj_name_uniq), and
  * Odoo does not create this module's `model_<name>` xmlids for them, so
    security/ir.model.access.csv fails with
    "No matching record found for external id '<module>.model_x_...'".
  * ir.model.fields records defined in XML (e.g. Studio fields on system
    tables) try to CREATE fields that already exist
    (ir_model_fields_name_unique);
  * likewise `<module>.field_<model>__<field>` is never created for fields
    that already exist as Studio fields, so data referencing them fails
    ("External ID not found: BugFix-HR.field_x_paye_tax__x_active").

pre_init_hook runs before this module's data loads. For every model this
module declares with `_name` (read from its Python files), plus every
ir.model pin in its data, it registers `<module>.model_<name>` on the
existing ir.model row; and for every field it declares in Python (on its
own models and on models it _inherit-s) it registers
`<module>.field_<model>__<field>` on the existing ir.model.fields row. The model then belongs to this repo (Python
reflection sets state=base); nothing else is written. Models that do not
exist yet are created as usual; on a fresh database nothing matches, so this
is a no-op there. Goal: nothing left owned by Studio.

Lives on the Staging_Migration branch only. ORM only.
"""
import ast
import glob
import logging
import os

from lxml import etree

_logger = logging.getLogger(__name__)

MODULE = os.path.basename(os.path.dirname(os.path.abspath(__file__)))
_HERE = os.path.dirname(os.path.abspath(__file__))


def _declared_models():
    """Model names this module declares with _name = '...' in its Python files."""
    names = set()
    for path in glob.glob(os.path.join(_HERE, '**', '*.py'), recursive=True):
        if os.sep + 'migrations' + os.sep in path or path.endswith('staging_adopt.py'):
            continue
        try:
            with open(path, encoding='utf-8') as f:
                tree = ast.parse(f.read())
        except (SyntaxError, UnicodeDecodeError):
            continue
        for cls in (n for n in ast.walk(tree) if isinstance(n, ast.ClassDef)):
            for st in cls.body:
                if (isinstance(st, ast.Assign) and len(st.targets) == 1
                        and getattr(st.targets[0], 'id', None) == '_name'
                        and isinstance(st.value, ast.Constant) and isinstance(st.value.value, str)):
                    names.add(st.value.value)
    return names


def _class_model(cls):
    """Model a class body applies to: _name, else a single _inherit."""
    name = inherit = None
    for st in cls.body:
        if isinstance(st, ast.Assign) and len(st.targets) == 1 and isinstance(st.targets[0], ast.Name):
            if st.targets[0].id == '_name' and isinstance(st.value, ast.Constant):
                name = st.value.value
            elif st.targets[0].id == '_inherit':
                if isinstance(st.value, ast.Constant):
                    inherit = st.value.value
                elif isinstance(st.value, (ast.List, ast.Tuple)) and len(st.value.elts) == 1                         and isinstance(st.value.elts[0], ast.Constant):
                    inherit = st.value.elts[0].value
    return name or inherit


def _declared_fields():
    """{(model, field)} for every fields.X(...) assignment in this module's Python."""
    out = set()
    for path in glob.glob(os.path.join(_HERE, '**', '*.py'), recursive=True):
        if os.sep + 'migrations' + os.sep in path or path.endswith('staging_adopt.py'):
            continue
        try:
            with open(path, encoding='utf-8') as f:
                tree = ast.parse(f.read())
        except (SyntaxError, UnicodeDecodeError):
            continue
        for cls in (n for n in ast.walk(tree) if isinstance(n, ast.ClassDef)):
            model = _class_model(cls)
            if not isinstance(model, str):
                continue
            for st in cls.body:
                if (isinstance(st, ast.Assign) and len(st.targets) == 1 and isinstance(st.targets[0], ast.Name)
                        and isinstance(st.value, ast.Call)
                        and getattr(getattr(st.value.func, 'value', None), 'id', None) == 'fields'):
                    out.add((model, st.targets[0].id))
    return out


def _xml_field_records():
    """{xmlid: (model, field)} for ir.model.fields records shipped in this module's XML."""
    out = {}
    for path in glob.glob(os.path.join(_HERE, '**', '*.xml'), recursive=True):
        try:
            tree = etree.parse(path)
        except etree.XMLSyntaxError:
            continue
        for rec in tree.iter('record'):
            if rec.get('model') != 'ir.model.fields' or not rec.get('id') or '.' in rec.get('id'):
                continue
            name = rec.find("field[@name='name']")
            model = rec.find("field[@name='model']")
            if name is not None and model is not None and name.text and model.text:
                out[rec.get('id')] = (model.text.strip(), name.text.strip())
    return out


def _pinned_models():
    """{xmlid: model name} for ir.model pin records shipped in this module's XML."""
    pins = {}
    for path in glob.glob(os.path.join(_HERE, '**', '*.xml'), recursive=True):
        try:
            tree = etree.parse(path)
        except etree.XMLSyntaxError:
            continue
        for rec in tree.iter('record'):
            if rec.get('model') == 'ir.model' and rec.get('id') and '.' not in rec.get('id'):
                f = rec.find("field[@name='model']")
                if f is not None and f.text:
                    pins[rec.get('id')] = f.text.strip()
    return pins


def pre_init_hook(env):
    IrModel = env['ir.model'].sudo()
    IMD = env['ir.model.data'].sudo()
    wanted = {'model_' + n.replace('.', '_'): n for n in _declared_models()}
    wanted.update(_pinned_models())
    adopted = 0
    for xmlid, model_name in sorted(wanted.items()):
        if IMD.search_count([('module', '=', MODULE), ('name', '=', xmlid)]):
            continue
        model = IrModel.search([('model', '=', model_name)], limit=1)
        if not model:
            continue
        IMD.create({'module': MODULE, 'name': xmlid, 'model': 'ir.model', 'res_id': model.id, 'noupdate': True})
        adopted += 1
    _logger.info("%s pre_init_hook: repo-owned %d existing models (%d declared/pinned)",
                 MODULE, adopted, len(wanted))

    Fields = env['ir.model.fields'].sudo()
    by_model = {}
    for model_name, fname in _declared_fields():
        by_model.setdefault(model_name, set()).add(fname)
    fadopted = 0
    for model_name, fnames in sorted(by_model.items()):
        existing = {f.name: f.id for f in Fields.search([('model', '=', model_name), ('name', 'in', sorted(fnames))])}
        for fname, fid in sorted(existing.items()):
            xmlid = 'field_%s__%s' % (model_name.replace('.', '_'), fname)
            if IMD.search_count([('module', '=', MODULE), ('name', '=', xmlid)]):
                continue
            IMD.create({'module': MODULE, 'name': xmlid, 'model': 'ir.model.fields', 'res_id': fid, 'noupdate': True})
            fadopted += 1
    for xmlid, (model_name, fname) in sorted(_xml_field_records().items()):
        if IMD.search_count([('module', '=', MODULE), ('name', '=', xmlid)]):
            continue
        field = Fields.search([('model', '=', model_name), ('name', '=', fname)], limit=1)
        if not field:
            continue
        IMD.create({'module': MODULE, 'name': xmlid, 'model': 'ir.model.fields', 'res_id': field.id, 'noupdate': True})
        fadopted += 1
    _logger.info("%s pre_init_hook: repo-owned %d existing fields", MODULE, fadopted)

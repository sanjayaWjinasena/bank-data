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
  * res.groups records try to CREATE groups that already exist
    (res_groups_name_uniq: same name in the same category);
  * likewise `<module>.field_<model>__<field>` is never created for fields
    that already exist as Studio fields, so data referencing them fails
    ("External ID not found: BugFix-HR.field_x_paye_tax__x_active").
  * every config record the module ports from Clear-DB (automations,
    server/window/report actions, views, menus, record rules, access
    rights, filters, mail templates, defaults, crons) is CREATED a second
    time next to the Studio record it was ported from, so both run
    (e.g. 250 automations firing twice on the first staging copy).

pre_init_hook runs before this module's data loads. For every model this
module declares with `_name` (read from its Python files), plus every
ir.model pin in its data, it registers `<module>.model_<name>` on the
existing ir.model row; and for every field it declares in Python (on its
own models and on models it _inherit-s) it registers
`<module>.field_<model>__<field>` on the existing ir.model.fields row. For
models it defines with _name, ALL their fields get the xmlid, as Odoo does
for a module's own models: that covers the automatic fields (id,
create_date, create_uid, write_date, write_uid) that never appear in the
Python. When several modules define the same model, each gets its own
xmlid on the same field, exactly as Odoo does on a fresh database. The model then belongs to this repo (Python
reflection sets state=base); nothing else is written. Models that do not
exist yet are created as usual; on a fresh database nothing matches, so this
is a no-op there. Goal: nothing left owned by Studio.

Config records (v8): the ported xmlids embed the Clear-DB record id
(server_action_2205_..., access_1680_..., ported_view_5422_...), and Clear-DB
and the staging copies are both copies of production, so record N on staging
is the Studio original. The xmlid is bound to it only when record N is still
Studio-owned (no xmlid, or only studio_customization / __export__) and its
key fields equal what the repo declares: model, plus name / state / parent /
inherit view / groups by type (access rights: same model AND same group, so
a wrong repo group never lands on production's row). The repo data then
loads onto that record (it is written, not duplicated), exactly as an
upgrade would. Records that do not match are created as before and listed
in the log. Menus without an id in their xmlid are matched on name + parent
when exactly one Studio menu fits.

Databases installed before v8 (copies already exist): migrations/0.0.0
runs rebind_duplicates before the module's data reloads on upgrade, with
the same matching, moving the xmlid from the copy onto record N, and
archive_rebound_copies after it; Jinasena_All's migrations/0.0.0 deletes
the copies once every repo has reloaded. Only copies (records left with no
xmlid) are archived or deleted; the Studio originals are kept and become
repo-owned.

Lives on the Staging_Migration branch only. ORM only.
"""
import ast
import csv
import json
import glob
import logging
import os
import re

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


def _xml_group_records():
    """[(xmlid, name, category_ref, category_search)] for res.groups records in this module's XML."""
    out = []
    for path in glob.glob(os.path.join(_HERE, '**', '*.xml'), recursive=True):
        try:
            tree = etree.parse(path)
        except etree.XMLSyntaxError:
            continue
        for rec in tree.iter('record'):
            if rec.get('model') != 'res.groups' or not rec.get('id') or '.' in rec.get('id'):
                continue
            name = rec.find("field[@name='name']")
            if name is None or not name.text:
                continue
            cat = rec.find("field[@name='category_id']")
            out.append((rec.get('id'), name.text.strip(),
                        cat.get('ref') if cat is not None else None,
                        cat.get('search') if cat is not None else None))
    return out


def _adopt_groups(env, IMD):
    """Bind this module's group xmlids to existing groups: same name in the
    same category, else a unique name match. Writes nothing to the group."""
    Groups = env['res.groups'].sudo().with_context(active_test=False)
    adopted = 0
    for xmlid, name, cat_ref, cat_search in _xml_group_records():
        if IMD.search_count([('module', '=', MODULE), ('name', '=', xmlid)]):
            continue
        domain = [('name', '=', name)]
        if cat_ref:
            ref = cat_ref if '.' in cat_ref else '%s.%s' % (MODULE, cat_ref)
            cat = env.ref(ref, raise_if_not_found=False)
            domain.append(('category_id', '=', cat.id if cat else False))
        elif cat_search:
            cats = env['ir.module.category'].sudo().search(ast.literal_eval(cat_search))
            domain.append(('category_id', 'in', cats.ids))
        else:
            domain.append(('category_id', '=', False))
        hit = Groups.search(domain)
        if not hit:
            hit = Groups.search([('name', '=', name)])
        if len(hit) != 1:
            continue
        IMD.create({'module': MODULE, 'name': xmlid, 'model': 'res.groups', 'res_id': hit.id, 'noupdate': True})
        adopted += 1
    return adopted


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
    # every field of the models this module defines (automatic fields included)
    own_models = sorted(_declared_models())
    for model_name in own_models:
        for field in Fields.search([('model', '=', model_name)]):
            xmlid = 'field_%s__%s' % (model_name.replace('.', '_'), field.name)
            if IMD.search_count([('module', '=', MODULE), ('name', '=', xmlid)]):
                continue
            IMD.create({'module': MODULE, 'name': xmlid, 'model': 'ir.model.fields', 'res_id': field.id, 'noupdate': True})
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
    _logger.info("%s pre_init_hook: adopted %d existing groups", MODULE, _adopt_groups(env, IMD))
    _logger.info("%s pre_init_hook: adopted %d existing config records", MODULE, _adopt_config(env, IMD))


# --- config records (v8) -----------------------------------------------------

_STUDIO_MODULES = {'studio_customization', '__export__', 'web_studio'}
_CDB_ID = re.compile(r'(?:^|_)(\d{1,6})(?:_|$)')
_COMODEL = {'model_id': 'ir.model', 'binding_model_id': 'ir.model', 'inherit_id': 'ir.ui.view',
            'parent_id': 'ir.ui.menu', 'field_id': 'ir.model.fields', 'company_id': 'res.company',
            'group_id': 'res.groups', 'groups': 'res.groups'}
# key fields compared with record N, per type: (field, kind, default when the repo omits it)
_KEYS = {
    'base.automation': [('name', 'text', None), ('model_id', 'm2o', None)],
    'ir.actions.server': [('model_id', 'm2o', None), ('state', 'text', None)],
    'ir.actions.act_window': [('res_model', 'text', None), ('name', 'text', None)],
    'ir.ui.view': [('model', 'text', None), ('type', 'text', None), ('inherit_id', 'm2o', False)],
    'ir.ui.menu': [('name', 'text', None), ('parent_id', 'm2o', False)],
    'ir.rule': [('model_id', 'm2o', None), ('groups', 'm2m', frozenset())],
    'ir.model.access': [('model_id', 'm2o', None), ('group_id', 'm2o', False)],
    'ir.filters': [('name', 'text', None), ('model_id', 'text', None)],
    'mail.template': [('name', 'text', None), ('model_id', 'm2o', None)],
    'ir.actions.report': [('report_name', 'text', None), ('model', 'text', None)],
    'ir.default': [('field_id', 'm2o', None), ('company_id', 'm2o', False)],
    'ir.cron': [('name', 'text', None), ('model_id', 'm2o', None)],
}
_REF = re.compile(r"""ref\(\s*['"]([^'"]+)['"]\s*\)""")
_UNRESOLVED = object()


def _manifest_data():
    with open(os.path.join(_HERE, '__manifest__.py'), encoding='utf-8') as f:
        src = f.read()
    return ast.literal_eval(src[src.index('{'):]).get('data', [])


def _config_candidates():
    """[(model, xmlid, noupdate, {field: (how, value)})] for the config records in the manifest data files."""
    out = []
    for rel in _manifest_data():
        path = os.path.join(_HERE, *rel.split('/'))
        if not os.path.exists(path):
            continue
        if rel.endswith('ir.model.access.csv'):
            with open(path, encoding='utf-8') as f:
                for row in csv.DictReader(f):
                    if row.get('id') and '.' not in row['id']:
                        out.append(('ir.model.access', row['id'], False, {
                            'model_id': ('ref', (row.get('model_id:id') or '').strip()),
                            'group_id': ('ref', (row.get('group_id:id') or '').strip()),
                        }))
            continue
        if not rel.endswith('.xml'):
            continue
        try:
            tree = etree.parse(path)
        except etree.XMLSyntaxError:
            continue
        for el in tree.iter('record', 'menuitem', 'template'):
            xmlid = el.get('id') or ''
            if not xmlid or ('.' in xmlid and not xmlid.startswith(MODULE + '.')):
                continue
            xmlid = xmlid.split('.', 1)[-1] if '.' in xmlid else xmlid
            holder = el.getparent()
            noupdate = False
            while holder is not None:
                if holder.get('noupdate') is not None:
                    noupdate = holder.get('noupdate') in ('1', 'True', 'true')
                    break
                holder = holder.getparent()
            if el.tag == 'menuitem':
                vals = {}
                if el.get('name'):
                    vals['name'] = ('text', el.get('name'))
                vals['parent_id'] = ('ref', el.get('parent')) if el.get('parent') else ('eval', 'False')
                out.append(('ir.ui.menu', xmlid, noupdate, vals))
            elif el.tag == 'template':
                vals = {'type': ('text', 'qweb')}
                if el.get('inherit_id'):
                    vals['inherit_id'] = ('ref', el.get('inherit_id'))
                out.append(('ir.ui.view', xmlid, noupdate, vals))
            elif el.get('model') in _KEYS:
                vals = {}
                for f in el.findall('field'):
                    name = f.get('name')
                    if f.get('ref'):
                        vals[name] = ('ref', f.get('ref'))
                    elif f.get('search'):
                        vals[name] = ('search', f.get('search'))
                    elif f.get('eval') is not None:
                        vals[name] = ('eval', f.get('eval'))
                    else:
                        vals[name] = ('text', (f.text or '').strip())
                out.append((el.get('model'), xmlid, noupdate, vals))
    return out


_SECURITY_KEYS = {'groups', 'group_id'}
_KEEP_ACTIVE_PARAM = 'staging_adopt.keep_active.%s'
_MAP_FILE = os.path.join(_HERE, 'staging_adopt_map.json')
_MAP = None


def _sources(model, xmlid):
    """{Clear-DB id: Clear-DB create_date} this xmlid was ported from
    (staging_adopt_map.json, built from the SHIPPED_ARTIFACTS report, else the
    id in the xmlid; only ids that exist on Clear-DB)."""
    global _MAP
    if _MAP is None:
        try:
            with open(_MAP_FILE, encoding='utf-8') as f:
                _MAP = json.load(f)
        except (OSError, ValueError):
            _MAP = {}
    return {n: created for n, created in _MAP.get(xmlid, {}).get(model, [])}


def _eval_bool(how_value):
    how, value = how_value
    return str(value).strip() not in ('False', 'false', '0', 'None', '')


def _adopt_config(env, IMD, rebind=False):
    """Bind ported config xmlids to the Studio record they were ported from (see module doc).

    rebind=True (upgrade of a database installed before v8): an xmlid that
    already points at a repo-created COPY of record N is moved onto N, and
    the copy is returned in the orphan list [(model, id)]."""
    planned = {}                        # 'module.name' -> res_id bound in this run
    bound = set()                       # (model, res_id) bound in this run

    def resolve(ref):
        full = ref if '.' in ref else '%s.%s' % (MODULE, ref)
        if full in planned:
            return planned[full]
        module, name = full.split('.', 1)
        hit = IMD.search_read([('module', '=', module), ('name', '=', name)], ['res_id'])
        return hit[0]['res_id'] if hit else _UNRESOLVED

    def declared(field, how, value, kind):
        if how == 'text':
            return value
        if how == 'ref':
            return resolve(value) if value else False
        if how == 'search':
            try:
                domain = ast.literal_eval(value)
            except (ValueError, SyntaxError):
                return _UNRESOLVED
            ids = env[_COMODEL[field]].sudo().with_context(active_test=False).search(domain).ids
            return ids[0] if len(ids) == 1 else _UNRESOLVED
        # eval
        refs = _REF.findall(value)
        if kind == 'm2m':
            ids = frozenset(resolve(r) for r in refs)
            return _UNRESOLVED if _UNRESOLVED in ids else ids
        if refs:
            return resolve(refs[0]) if len(refs) == 1 else _UNRESOLVED
        return False if value.strip() in ('False', 'None', '0', '') else _UNRESOLVED

    def is_studio(model, res_id):
        owners = {x['module'] for x in IMD.search_read([('model', '=', model), ('res_id', '=', res_id)], ['module'])}
        return owners <= _STUDIO_MODULES

    def matches(model, n, created, want):
        """Record n is the original: Studio-owned and created at the same instant as on
        Clear-DB (both are copies of production). The port changed names, parents,
        models where it had to, so those are not compared; access rights and record
        rules must also carry the same group(s), so a repo group never replaces
        production's."""
        if (model, n) in bound:
            return False
        rec = env[model].sudo().with_context(active_test=False, lang='en_US').browse(n).exists()
        if not rec or not is_studio(model, n):
            return False
        have = rec.read(list(want) + ['create_date'])[0]
        stamp = have['create_date']
        if not isinstance(stamp, str):
            stamp = stamp.strftime('%Y-%m-%d %H:%M:%S')
        if stamp != created:
            return False
        for field, kind, _default in _KEYS[model]:
            if field not in want or field not in _SECURITY_KEYS:
                continue
            v = have[field]
            if kind == 'm2o':
                v = (v[0] if isinstance(v, (list, tuple)) else v) or False
            elif kind == 'm2m':
                v = frozenset(v or [])
            elif isinstance(v, str):
                v = v.strip()
            if v != want[field]:
                return False
        return True

    todo = []
    claimants = {}                      # (model, n) -> xmlids that list n as a source
    latest = {}                         # a record defined in several files: the last one loads last
    for model, xmlid, noupdate, vals in _config_candidates():
        merged = dict(latest[(model, xmlid)][3]) if (model, xmlid) in latest else {}
        merged.update(vals)
        latest.pop((model, xmlid), None)
        latest[(model, xmlid)] = (model, xmlid, noupdate, merged)
    candidates = []
    for model, xmlid, noupdate, vals in latest.values():
        sources = _sources(model, xmlid)
        for n in sources:
            claimants.setdefault((model, n), set()).add(xmlid)
        candidates.append((model, xmlid, noupdate, vals, sources))

    def owns(model, xmlid, n):
        """n goes to the only xmlid listing it, else to the only one carrying n in its name."""
        names = claimants[(model, n)]
        if len(names) == 1:
            return True
        numbered = [x for x in names if _CDB_ID.search(x) and int(_CDB_ID.search(x).group(1)) == n]
        return numbered == [xmlid]

    rows = {}                           # xmlid -> existing ir.model.data row (rebind)
    for model, xmlid, noupdate, vals, sources in candidates:
        sources = {n: created for n, created in sources.items() if owns(model, xmlid, n)}
        row = IMD.search_read([('module', '=', MODULE), ('name', '=', xmlid)], ['res_id', 'model'])
        if row:
            if not rebind or row[0]['model'] != model or row[0]['res_id'] in sources:
                continue
            rows[xmlid] = row[0]
        if sources or (model == 'ir.ui.menu' and 'name' in vals):
            todo.append((model, xmlid, noupdate, vals, sources))
    orphans = []
    keep_active = []

    stats = {}
    progress = True
    while todo and progress:            # parents (inherit view, parent menu) bind first
        progress = False
        left = []
        for model, xmlid, noupdate, vals, sources in todo:
            Model = env[model].sudo().with_context(active_test=False, lang='en_US')
            want = {}
            for field, kind, default in _KEYS[model]:
                if sources and field not in _SECURITY_KEYS:
                    continue            # identity comes from id + create_date
                if field in vals:
                    want[field] = declared(field, vals[field][0], vals[field][1], kind)
                elif default is not None:
                    want[field] = default
            if _UNRESOLVED in want.values():
                left.append((model, xmlid, noupdate, vals, sources))
                continue
            if sources:
                hits = [n for n in sources if matches(model, n, sources[n], want)]
                if len(hits) > 1:       # Clear-DB duplicates merged into one repo record
                    m = _CDB_ID.search(xmlid)
                    hits = [int(m.group(1))] if m and int(m.group(1)) in hits else [min(hits)]
            else:
                domain = [('name', '=', want['name']), ('parent_id', '=', want.get('parent_id') or False)]
                hits = [h for h in Model.search(domain).ids
                        if (model, h) not in bound and is_studio(model, h)
                        and (xmlid not in rows or h != rows[xmlid]['res_id'])]
            if len(hits) != 1:
                left.append((model, xmlid, noupdate, vals, sources))
                continue
            res_id = hits[0]
            if 'active' in vals and 'active' in Model._fields:
                current = Model.browse(res_id).read(['active'])[0]['active']
                if current != _eval_bool(vals['active']):
                    keep_active.append([model, res_id, current])
            if xmlid in rows:
                IMD.browse(rows[xmlid]['id']).write({'res_id': res_id})
                orphans.append((model, rows[xmlid]['res_id']))
            else:
                IMD.create({'module': MODULE, 'name': xmlid, 'model': model, 'res_id': res_id, 'noupdate': noupdate})
            planned['%s.%s' % (MODULE, xmlid)] = res_id
            bound.add((model, res_id))
            stats[model] = stats.get(model, 0) + 1
            progress = True
        todo = left
    if keep_active:
        Param = env['ir.config_parameter'].sudo()
        known = json.loads(Param.get_param(_KEEP_ACTIVE_PARAM % MODULE) or '[]')
        known += [k for k in keep_active if k not in known]
        Param.set_param(_KEEP_ACTIVE_PARAM % MODULE, json.dumps(known))
    for model in sorted(_KEYS):
        missed = [x for (m, x, _u, _v, _s) in todo if m == model]
        if stats.get(model) or missed:
            _logger.info("%s staging_adopt: %s %s %d Studio records, %d not matched%s",
                         MODULE, model, 'moved onto' if rebind else 'adopted', stats.get(model, 0), len(missed),
                         (' (%s)' % ', '.join(missed[:40])) if missed else '')
    return orphans if rebind else sum(stats.values())

# --- databases installed before v8: move xmlids off the duplicates -----------

_ORPHAN_PARAM = 'staging_adopt.rebound_copies.%s'


def rebind_duplicates(env):
    """migrations/0.0.0/pre-migrate: before this module's data reloads, move
    each ported xmlid from the repo-created copy onto the Studio record N it
    duplicates (same rules as install). The reload then writes the repo
    version onto N. The copies are remembered for archive + delete."""
    IMD = env['ir.model.data'].sudo()
    orphans = _adopt_config(env, IMD, rebind=True)
    Param = env['ir.config_parameter'].sudo()
    known = json.loads(Param.get_param(_ORPHAN_PARAM % MODULE) or '[]')
    known += [list(o) for o in orphans if list(o) not in known]
    Param.set_param(_ORPHAN_PARAM % MODULE, json.dumps(known))
    _logger.info("%s staging_adopt: moved %d xmlids off repo-created duplicates", MODULE, len(orphans))


def archive_rebound_copies(env):
    """migrations/0.0.0/post-migrate: archive the copies (no double runs) until
    Jinasena_All deletes them. Only records with no xmlid left are touched."""
    IMD = env['ir.model.data'].sudo()
    known = json.loads(env['ir.config_parameter'].sudo().get_param(_ORPHAN_PARAM % MODULE) or '[]')
    archived = 0
    for model, res_id in known:
        rec = env[model].sudo().with_context(active_test=False).browse(res_id).exists()
        if not rec or IMD.search_count([('model', '=', model), ('res_id', '=', res_id)]):
            continue
        if 'active' in rec._fields and rec.active:
            rec.active = False
            archived += 1
    _logger.info("%s staging_adopt: archived %d repo-created duplicates", MODULE, archived)

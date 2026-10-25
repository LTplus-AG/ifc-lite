// SPDX-License-Identifier: MPL-2.0
// Production closure for Cut C. The complete model/publication projection stays test-only.
import { rustWire } from './rust-wire-generate.mjs';

export function inspectionProjection(schema, header, definition, check, semantics, wire, full, crate) {
  const names = new Set();
  const visit = (name) => {
    if (names.has(name)) return;
    names.add(name);
    const node = schema.types[name];
    if (node.kind === 'record') Object.values(node.fields).forEach(visit);
    if (node.kind === 'union') Object.values(node.variants).forEach(visit);
    if (node.kind === 'list') visit(node.item);
  };
  ['Options', 'Binding', 'InspectionReport'].forEach(visit);
  const entries = Object.entries(schema.types).filter(([name]) => names.has(name));
  const types = entries.map(([name, node]) => definition(name, node)
    .replace(/^(struct|enum|type) /gmu, 'pub(crate) $1 ')
    .replace(/\] ([a-z_][a-z_0-9]*):/gu, '] pub(crate) $1:')).join('');
  const checks = entries.map(([name, node]) => check(name, node)).join('');
  // These are generated from the same authoritative cause rules, not copied taxonomy.
  const rules = full.slice(full.indexOf('fn cause_family('), full.indexOf('\n' + semantics));
  const helpers = semantics.replace(/fn validate_model\([\s\S]*?(?=fn validate_inspection\()/u, '');
  const decoders = rustWire({ ...schema, types: Object.fromEntries(entries) }, crate === 'geometry' ? [] : ['Options', 'InspectionReport']);
  const consumed = crate === 'geometry' ? decoders : decoders.replace(/fn decode_binding\([\s\S]*?\n\}\n/gu, '');
  return (header + types + checks + rules + helpers + wire + consumed)
    .replace(/^(fn (?:decode_options|decode_binding|decode_inspection_report|validate_inspection|check_global_id|check_options|cause_family|text_format))\(/gmu, 'pub(crate) $1(');
}

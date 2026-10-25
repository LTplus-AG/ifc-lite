// SPDX-License-Identifier: MPL-2.0
import { schema, causes } from './schema.mjs';
import { parseWire } from './json.mjs';

const formats = {
  hash: /^[a-f0-9]{64}$/u, commit: /^[a-f0-9]{40}$/u,
  u64: /^(0|[1-9][0-9]{0,19})$/u, positive_u64: /^[1-9][0-9]{0,19}$/u,
  global_id: /^[0-3][0-9A-Za-z_$]{21}$/u,
};
export function demand(condition, rule) {
  if (!condition) throw new Error(`Retained contract: ${rule}`);
}
function object(value) {
  demand(value !== null && typeof value === 'object' && !Array.isArray(value), 'object');
  demand(Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null, 'plain object');
}
// Reconstruct from data properties only, then freeze. No getter, mutable alias,
// symbol, non-enumerable field or inherited payload can bypass validation.
export function validateShape(name, value, depth = 0) {
  demand(depth < schema.maxWireDepth, 'depth');
  const type = schema.types[name];
  demand(type, 'known type');
  const child = (ref, item) => validateShape(ref, item, depth + 1);
  switch (type.kind) {
    case 'literal': demand(value === type.value, name); return value;
    case 'bool': demand(typeof value === 'boolean', name); return value;
    case 'number':
      demand(typeof value === 'number' && Number.isFinite(value) && value > type.minExclusive && value <= type.max, name);
      return value;
    case 'text':
      demand(typeof value === 'string' && formats[type.format].test(value), name);
      if (type.format.endsWith('u64')) demand(BigInt(value) <= 18446744073709551615n, name);
      return value;
    case 'enum': demand(type.values.includes(value), name); return value;
    case 'list':
      demand(Array.isArray(value) && value.length >= type.min && value.length <= type.max, name);
      demand(Reflect.ownKeys(value).length === value.length + 1, 'dense unadorned array');
      return Object.freeze(Array.from({ length: value.length }, (_, index) => {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        demand(descriptor && 'value' in descriptor, 'array data property');
        return child(type.item, descriptor.value);
      }));
    case 'record': {
      object(value);
      const fields = Object.entries(type.fields);
      demand(Reflect.ownKeys(value).length === fields.length, `${name} fields`);
      const result = Object.freeze(Object.fromEntries(fields.map(([key, ref]) => {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        demand(descriptor && 'value' in descriptor && descriptor.enumerable, `${name}.${key}`);
        return [key, child(ref, descriptor.value)];
      })));
      if (name === 'Refusal') {
        demand(causes[result.family].includes(result.code), 'cause family');
        const rule = schema.refusalRules[result.code];
        demand(result.detail.reason === rule.reason, 'cause reason');
        demand(rule.contexts.some(([stage, requirement]) => stage === result.stage
          && requirement === result.requirement), 'cause context');
        if (result.source.kind === 'unbound') demand(result.family === 'configuration'
          && result.stage === 'configuration' && result.target.kind === 'model', 'unbound configuration only');
      }
      return result;
    }
    case 'union': {
      object(value);
      const descriptor = Object.getOwnPropertyDescriptor(value, type.tag);
      demand(descriptor && 'value' in descriptor && descriptor.enumerable, 'tag');
      const tag = descriptor.value;
      demand(typeof tag === 'string' && Object.hasOwn(type.variants, tag), `${name} variant`);
      const fields = Object.getOwnPropertyDescriptors(value);
      delete fields[type.tag];
      const rest = Object.create(null, fields);
      return Object.freeze({ [type.tag]: tag, ...child(type.variants[tag], rest) });
    }
    default: throw new Error('Unknown schema node');
  }
}
function equal(left, right) { return JSON.stringify(left) === JSON.stringify(right); }
function productMap(products) {
  const map = new Map();
  const globalIds = new Set();
  for (const product of products) {
    demand(!map.has(product.productId), 'duplicate product');
    if (product.GlobalId.kind === 'known') {
      demand(!globalIds.has(product.GlobalId.value), 'duplicate GlobalId');
      globalIds.add(product.GlobalId.value);
    }
    map.set(product.productId, product);
  }
  return map;
}
function member(product, map) {
  demand(equal(product, map.get(product.productId)), 'foreign product or GlobalId');
}
function bindingShape(input) {
  const binding = validateShape('Binding', input);
  productMap([...binding.requested, ...binding.nonGeometric]);
  return binding;
}
function refusalContext(refusal, binding, product) {
  demand(refusal.source.kind === 'known' && equal(refusal.source.value, binding.identity.source), 'refusal source');
  if (product) {
    demand(refusal.target.kind === 'product', 'product refusal target');
    demand(equal(refusal.target.product, product), 'refusal product');
  } else demand(refusal.target.kind === 'model', 'model refusal target');
}
function model(report, binding) {
  const p = report.partition;
  demand(equal(p.identity, binding.identity), 'report identity');
  demand(p.enumerationComplete === binding.enumerationComplete, 'enumeration binding');
  if (!p.enumerationComplete) demand(p.geometry.length === 0 && p.removed.length === 0, 'enumeration before products');
  const requested = productMap(binding.requested);
  const nonGeometric = productMap(binding.nonGeometric);
  const seen = new Set();
  const consume = (product, domain) => {
    member(product, domain);
    demand(!seen.has(product.productId), 'overlapping partition');
    seen.add(product.productId);
  };
  for (const product of [...p.geometry, ...p.removed]) consume(product, requested);
  for (const refusal of p.refused) {
    demand(refusal.target.kind === 'product', 'refused target');
    const product = refusal.target.product;
    refusalContext(refusal, binding, product);
    consume(product, requested);
  }
  for (const product of p.nonGeometric) consume(product, nonGeometric);
  demand(seen.size === requested.size + nonGeometric.size, 'exhaustive partition');
  if (report.status === 'complete' || report.status === 'incomplete') {
    demand(p.enumerationComplete, 'enumeration required');
    demand((p.refused.length === 0) === (report.status === 'complete'), 'complete/incomplete refusal partition');
  } else {
    refusalContext(report.error, binding);
    demand((report.error.code === 'CANCELLED') === (report.status === 'cancelled'), 'terminal cause');
  }
}
function inspection(report, binding) {
  demand(equal(report.identity, binding.identity), 'inspection identity');
  member(report.product, productMap(binding.requested));
  demand(new Set(report.unchecked).size === report.unchecked.length, 'duplicate obligation');
  for (const required of ['numerical_evaluation', 'final_geometry', 'protected_removal', 'publication']) {
    demand(report.unchecked.includes(required), 'diagnostic outstanding obligations');
  }
  if (report.outcome.kind === 'refused') refusalContext(report.outcome.refusal, binding, report.product);
}
// Shape validation is not authentication. The binding must come from the caller's
// authenticated source; this function can never grant geometry/removal authority.
export function validate(root, input, context) {
  demand(['Options', 'Refusal', 'ModelReport', 'InspectionReport'].includes(root), 'root');
  const value = validateShape(root, input);
  if (root === 'ModelReport' || root === 'InspectionReport') {
    const binding = bindingShape(context);
    if (root === 'ModelReport') model(value, binding);
    else inspection(value, binding);
  }
  return value;
}
export function decode(root, json, binding) {
  return validate(root, parseWire(json, schema.maxWireBytes, schema.maxWireDepth), binding);
}
export function counts(report, binding) {
  const { partition: p } = validate('ModelReport', report, binding);
  return Object.freeze({ geometry: p.geometry.length, removed: p.removed.length,
    refused: p.refused.length, nonGeometric: p.nonGeometric.length });
}

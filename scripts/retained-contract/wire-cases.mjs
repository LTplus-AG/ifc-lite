// SPDX-License-Identifier: MPL-2.0
// #7955 R1/R2 independent raw-wire expectations. Limits here are test oracles,
// intentionally not imported from the schema or inferred from validator output.
import { options, refusal, complete, binding, inspection } from './cases.mjs';
const json = JSON.stringify(options);
const encode = JSON.stringify;
export const wireCases = [
  { name: 'bytes_below', root: 'Options', valid: true, text: json, padBytes: 4194303 },
  { name: 'bytes_exact', root: 'Options', valid: true, text: json, padBytes: 4194304 },
  { name: 'bytes_above', root: 'Options', valid: false, text: json, padBytes: 4194305 },
  { name: 'oversized_whitespace_prefix', root: 'Options', valid: false, text: json, prefix: ' ', prefixCount: 4194305 },
  { name: 'utf8_bytes_exact', root: 'Envelope', valid: true, text: '"é"', padBytes: 4194304 },
  { name: 'utf8_bytes_above', root: 'Envelope', valid: false, text: '"é"', padBytes: 4194305 },
  { name: 'depth_below', root: 'Envelope', valid: true, text: '0', prefix: '[', suffix: ']', prefixCount: 31, suffixCount: 31 },
  { name: 'depth_exact', root: 'Envelope', valid: true, text: '0', prefix: '[', suffix: ']', prefixCount: 32, suffixCount: 32 },
  { name: 'depth_above', root: 'Envelope', valid: false, text: '0', prefix: '[', suffix: ']', prefixCount: 33, suffixCount: 33 },
  { name: 'empty_container_depth_exact', root: 'Envelope', valid: true, text: '', prefix: '{"x":', suffix: '}', prefixCount: 31, suffixCount: 31, middle: '{}' },
  { name: 'empty_container_depth_above', root: 'Envelope', valid: false, text: '', prefix: '{"x":', suffix: '}', prefixCount: 32, suffixCount: 32, middle: '{}' },
  { name: 'duplicate_root', root: 'Options', valid: false, text: json.replace('"schemaVersion":1', '"schemaVersion":2,"schemaVersion":1') },
  { name: 'escaped_duplicate_root', root: 'Options', valid: false, text: json.replace('"schemaVersion":1', '"schemaVersion":2,"\\u0073chemaVersion":1') },
  { name: 'duplicate_nested_source', root: 'Refusal', valid: false,
    text: encode(refusal).replace('"revision":', '"revision":"0","revision":') },
  { name: 'escaped_duplicate_nested_source', root: 'Refusal', valid: false,
    text: encode(refusal).replace('"revision":', '"revision":"0","\\u0072evision":') },
  { name: 'envelope_duplicate_before_construction', root: 'Envelope', valid: false, text: '{"x":1,"x":2}' },
  { name: 'envelope_escaped_nested_duplicate', root: 'Envelope', valid: false, text: '{"a":{"x":1,"\\u0078":2}}' },
  { name: 'envelope_same_keys_in_distinct_objects', root: 'Envelope', valid: true, text: '{"a":{"x":1},"b":{"x":2}}' },
  { name: 'duplicate_union_tag', root: 'ModelReport', valid: false, binding,
    text: encode(complete).replace('"status":"complete"', '"status":"complete","status":"complete"') },
  { name: 'escaped_duplicate_nested_union_tag', root: 'Refusal', valid: false,
    text: encode(refusal).replace('"kind":"known"', '"kind":"known","\\u006bind":"known"') },
  { name: 'tag_last', root: 'ModelReport', valid: true, binding,
    text: encode({ partition: complete.partition, status: 'complete' }) },
  { name: 'nested_tag_last', root: 'Refusal', valid: true,
    text: encode({ ...refusal, source: { value: refusal.source.value, kind: 'known' } }) },
  { name: 'decimal_version', root: 'Options', valid: true, text: json.replace('"schemaVersion":1', '"schemaVersion":1.0') },
  { name: 'two_documents', root: 'Options', valid: false, text: json + json },
  { name: 'non_json_whitespace', root: 'Options', valid: false, text: '\u00a0' + json },
  { name: 'truncated_string', root: 'Options', valid: false, text: '{"schemaVersion":"' },
];
// List maxima and the minimum-one requirement are tested before typed Rust Vec
// construction. Repetition recipes keep generated test artifacts small.
for (const [size, valid] of [[0, false], [1, true], [32, true], [33, false]]) {
  wireCases.push({ name: `requirements_shape_${size}`, root: 'Shape:Requirements', valid,
    text: encode(Array(size).fill('publication')) });
}
for (const [size, valid] of [[4095, true], [4096, true], [4097, false]]) {
  wireCases.push({ name: `products_shape_${size}`, root: 'Shape:Products', valid,
    text: '[]', listItem: encode(binding.requested[0]), listCount: size });
}
wireCases.push({ name: 'binding_duplicate', root: 'Binding', valid: false,
  text: encode(binding).replace('"enumerationComplete":true', '"enumerationComplete":false,"enumerationComplete":true') });
wireCases.push({ name: 'inspection_nested_object_enum', root: 'InspectionReport', valid: false, binding,
  text: encode({ ...inspection, column: { controller: null } }) });
export function wireText(item) {
  if (item.listItem) return '[' + Array(item.listCount).fill(item.listItem).join(',') + ']';
  const text = (item.prefix ?? '').repeat(item.prefixCount ?? 0) + (item.middle ?? item.text)
    + (item.suffix ?? '').repeat(item.suffixCount ?? 0);
  return item.padBytes === undefined ? text : ' '.repeat(item.padBytes - Buffer.byteLength(text)) + text;
}

// #7955 W1: authored raw tokens and exact IEEE-754 bits, never reserialized from
// parsed numbers or inferred from validator acceptance. These include decimals
// that default Serde parsing double-rounds, rejects as overflow, or rounds to zero.
for (const [name, token, expectedBits] of [
  ['ordinary_rounding', '0.12345678901234567', '3fbf9add3746f65e'],
  ['ordinary_tenth', '0.1', '3fb999999999999a'],
  ['finite_extreme_rounding', '1.7976931348623158e308', '7fefffffffffffff'],
  ['subnormal_rounding', '2.4703282292062328e-324', '0000000000000001'],
  ['smallest_normal_rounding', '2.2250738585072014e-308', '0010000000000000'],
  ['halfway_ties_to_even', '1.00000000000000011102230246251565404236316680908203125', '3ff0000000000000'],
]) wireCases.push({ name, root: 'Options', valid: true, expectedBits,
  text: json.replace('"chordToleranceMetres":0.0001', '"chordToleranceMetres":' + token) });
for (const [name, token] of [
  ['overflow_rounding', '1.7976931348623159e308'],
  ['underflow_rounding', '2.4703282292062327e-324'],
]) wireCases.push({ name, root: 'Options', valid: false,
  text: json.replace('"chordToleranceMetres":0.0001', '"chordToleranceMetres":' + token) });

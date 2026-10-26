// SPDX-License-Identifier: MPL-2.0
// #7955 independent data mutants. Expectations describe invariants, not schema output.
export const options = {
  schemaVersion: 1, chordToleranceMetres: 0.0001, angleToleranceRadians: 0.08,
  maxWork: '9007199254740993', maxBytes: '18446744073709551615', deadlineMs: '30000',
  typeGeometryMode: 'suppress_instanced', normalPolicy: 'source_analytic_v1', instancePolicy: 'uncut_mapped_v1',
  interfacePolicy: 'certified_internal_v1', openings: 'all', layers: 'preserve', skipSmallCuts: false, mergeLayers: false,
};
const source = { namespace: 'a'.repeat(64), revision: '9007199254740993', sha256: 'b'.repeat(64) };
const one = { productId: '9007199254740993', GlobalId: { kind: 'known', value: '0123456789ABCDEFGHIJK$' } };
const two = { productId: '2', GlobalId: { kind: 'absent' } };
const three = { productId: '3', GlobalId: { kind: 'absent' } };
const identity = { schemaVersion: 1, coverageVersion: 1, engine: 'retained', source, options, resultId: 'c'.repeat(64) };
export const binding = { identity, enumerationComplete: true, requested: [one, two], nonGeometric: [three] };
export const refusal = {
  schemaVersion: 1, family: 'geometry', code: 'OPERATION_UNSUPPORTED', stage: 'representation', source: { kind: 'known', value: source },
  target: { kind: 'product', product: two }, requirement: 'representation',
  detail: { reason: 'unsupported', observed: '0', limit: '0' }, exactRetry: 'explicit_new_exact_request',
};
const forProduct = (product) => ({ ...structuredClone(refusal), target: { kind: 'product', product } });
export const complete = { status: 'complete', partition: { identity, enumerationComplete: true,
  geometry: [one, two], removed: [], refused: [], nonGeometric: [three] } };
export const incomplete = { status: 'incomplete', partition: { ...complete.partition, geometry: [one], refused: [refusal] } };
export const inspection = {
  schemaVersion: 1, kind: 'source_inspection', authority: 'diagnostic_only', identity, column: 'controller',
  implementationCommit: 'd'.repeat(40), product: one,
  outcome: { kind: 'requires_numerical_evaluation', stage: 'numerical', requestOrdinal: '9007199254740993' },
  unchecked: ['numerical_evaluation', 'final_geometry', 'protected_removal', 'publication'],
};
const topError = { ...refusal, family: 'source', code: 'ENUMERATION_FAILED', stage: 'enumeration',
  requirement: 'enumeration', detail: { reason: 'invalid', observed: '0', limit: '0' }, target: { kind: 'model' } };
const cancelledError = { ...topError, family: 'runtime', code: 'CANCELLED',
  detail: { reason: 'cancelled', observed: '0', limit: '0' } };
const failed = { status: 'failed', partition: { ...incomplete.partition, enumerationComplete: false,
  geometry: [], refused: [one, two].map((product) => ({ ...topError, target: { kind: 'product', product } })) }, error: topError };
const interruptedBinding = { ...binding, enumerationComplete: false };
const accepted = [
  ['frozen_options', 'Options', options], ['typed_refusal', 'Refusal', refusal],
  ['complete_partition', 'ModelReport', complete, binding],
  ['mixed_partition', 'ModelReport', incomplete, binding],
  ['all_refused_incomplete', 'ModelReport', { ...incomplete, partition: { ...incomplete.partition, geometry: [], refused: [forProduct(one), refusal] } }, binding],
  ['described_removal_not_authority', 'ModelReport', { ...complete, partition: { ...complete.partition, geometry: [one], removed: [two] } }, binding],
  ['failed_enumeration', 'ModelReport', failed, interruptedBinding],
  ['cancelled_partial_enumeration', 'ModelReport', { ...failed, status: 'cancelled', error: cancelledError }, interruptedBinding],
  ['empty_authenticated_manifest', 'ModelReport', { ...complete, partition: { ...complete.partition, geometry: [], nonGeometric: [] } }, { ...binding, requested: [], nonGeometric: [] }],
  ['inspection_boundary', 'InspectionReport', inspection, binding],
  ['inspection_refusal', 'InspectionReport', { ...inspection, outcome: { kind: 'refused', refusal: forProduct(one) } }, binding],
  ['inspection_traversal_only', 'InspectionReport', { ...inspection, column: 'extractor', outcome: { kind: 'traversal_only' } }, binding],
];
export const cases = accepted.map(([name, root, input, context]) => ({ name, root, valid: true,
  input: JSON.parse(JSON.stringify(input)), ...(context ? { binding: JSON.parse(JSON.stringify(context)) } : {}) }));
function mutant(name, baseline, change) {
  const item = structuredClone(cases.find((entry) => entry.name === baseline));
  item.name = name; item.valid = false; change(item.input, item); cases.push(item);
}
for (const [name, field, value] of [
  ['unknown_version', 'schemaVersion', 2], ['zero_chord', 'chordToleranceMetres', 0],
  ['negative_angle', 'angleToleranceRadians', -1], ['excess_angle', 'angleToleranceRadians', 4],
  ['numeric_string', 'chordToleranceMetres', '0.001'], ['zero_limit', 'maxWork', '0'],
  ['unsafe_number', 'maxBytes', 9007199254740992], ['overflow_u64', 'maxBytes', '18446744073709551616'],
  ['noncanonical_integer', 'deadlineMs', '030'], ['negative_limit', 'maxWork', '-1'],
  ['unknown_mode', 'typeGeometryMode', 'fast'], ['unknown_policy', 'normalPolicy', 'smooth'],
  ['skip_small_cuts', 'skipSmallCuts', true], ['merge_layers', 'mergeLayers', true],
  ['exact_tier', 'geomTier', 'fast'], ['resource_retry', 'resourceRetry', true],
]) mutant(name, 'frozen_options', (input) => { input[field] = value; });
mutant('missing_option', 'frozen_options', (input) => { delete input.deadlineMs; });
for (const [name, field, value] of [
  ['unknown_code', 'code', 'SUCCESS'], ['unknown_stage', 'stage', 'done'],
  ['unknown_requirement', 'requirement', 'optional'], ['automatic_retry', 'exactRetry', 'automatic'],
]) mutant(name, 'typed_refusal', (input) => { input[field] = value; });
mutant('unsafe_detail', 'typed_refusal', (input) => { input.detail.message = '/private/source.ifc'; });
mutant('unknown_detail', 'typed_refusal', (input) => { input.detail.reason = 'secret'; });
mutant('numeric_revision', 'typed_refusal', (input) => { input.source.value.revision = 9007199254740992; });
mutant('malformed_global_id', 'typed_refusal', (input) => { input.target.product.GlobalId = { kind: 'known', value: 'invalid' }; });
mutant('unknown_engine', 'complete_partition', (input) => { input.partition.identity.engine = 'exact'; });
mutant('duplicate_product', 'complete_partition', (input) => { input.partition.geometry.push(input.partition.geometry[0]); });
mutant('foreign_product', 'complete_partition', (input) => { input.partition.geometry[1].productId = '4'; });
mutant('missing_product', 'complete_partition', (input) => { input.partition.geometry.pop(); });
mutant('overlap_geometry_removal', 'complete_partition', (input) => { input.partition.removed.push(input.partition.geometry[0]); });
mutant('non_geometric_laundering', 'complete_partition', (input) => { input.partition.nonGeometric.push(input.partition.geometry.pop()); });
mutant('forged_complete', 'mixed_partition', (input) => { input.status = 'complete'; });
mutant('empty_incomplete', 'complete_partition', (input) => { input.status = 'incomplete'; });
mutant('lost_global_id', 'complete_partition', (input) => { input.partition.geometry[0].GlobalId = { kind: 'absent' }; });
mutant('changed_global_id', 'complete_partition', (input) => { input.partition.geometry[0].GlobalId.value = '1123456789ABCDEFGHIJK$'; });
mutant('foreign_revision', 'complete_partition', (input) => { input.partition.identity.source.revision = '5'; });
mutant('changed_options', 'complete_partition', (input) => { input.partition.identity.options.maxWork = '4'; });
mutant('changed_result_identity', 'complete_partition', (input) => { input.partition.identity.resultId = 'e'.repeat(64); });
mutant('enumeration_laundering', 'empty_authenticated_manifest', (input, item) => { input.partition.enumerationComplete = false; item.binding.enumerationComplete = false; });
mutant('forged_enumeration_complete', 'complete_partition', (_, item) => { item.binding.enumerationComplete = false; });
mutant('duplicate_binding_id', 'complete_partition', (_, item) => { item.binding.requested.push(item.binding.requested[0]); });
mutant('binding_class_overlap', 'complete_partition', (_, item) => { item.binding.nonGeometric.push(item.binding.requested[0]); });
mutant('foreign_refusal_source', 'mixed_partition', (input) => { input.partition.refused[0].source.value.revision = '7'; });
mutant('model_refusal_in_partition', 'mixed_partition', (input) => { input.partition.refused[0].target = { kind: 'model' }; });
mutant('missing_failure', 'failed_enumeration', (input) => { delete input.error; });
mutant('cancelled_wrong_cause', 'failed_enumeration', (input) => { input.status = 'cancelled'; });
mutant('failed_cancel_cause', 'failed_enumeration', (input) => { input.error = structuredClone(cancelledError); });
mutant('product_top_error', 'failed_enumeration', (input) => { input.error.target = { kind: 'product', product: two }; });
mutant('inspection_complete', 'inspection_boundary', (input) => { input.status = 'complete'; });
mutant('inspection_geometry_success', 'inspection_boundary', (input) => { input.outcome = { kind: 'geometry_success' }; });
mutant('inspection_removal', 'inspection_boundary', (input) => { input.outcome = { kind: 'removed' }; });
mutant('inspection_authority', 'inspection_boundary', (input) => { input.authority = 'publication'; });
mutant('inspection_no_unchecked', 'inspection_boundary', (input) => { input.unchecked = []; });
for (const requirement of inspection.unchecked) mutant(`inspection_omits_${requirement}`, 'inspection_boundary', (input) => {
  input.unchecked = input.unchecked.filter((value) => value !== requirement);
});
mutant('inspection_foreign_target', 'inspection_boundary', (input) => { input.product = three; });
mutant('inspection_wrong_refusal', 'inspection_refusal', (input) => { input.outcome.refusal.target.product = two; });
mutant('inspection_as_model', 'inspection_boundary', (_, item) => { item.root = 'ModelReport'; });
mutant('model_as_inspection', 'complete_partition', (_, item) => { item.root = 'InspectionReport'; });

mutant('wrong_cause_family', 'typed_refusal', (input) => { input.family = 'source'; });
mutant('unknown_cause_family', 'typed_refusal', (input) => { input.family = 'success'; });
mutant('duplicate_global_id', 'complete_partition', (input, item) => {
  item.binding.requested[1].GlobalId = structuredClone(item.binding.requested[0].GlobalId);
  input.partition.geometry[1].GlobalId = structuredClone(input.partition.geometry[0].GlobalId);
});
mutant('cross_class_duplicate_global_id', 'complete_partition', (input, item) => {
  item.binding.nonGeometric[0].GlobalId = structuredClone(item.binding.requested[0].GlobalId);
  input.partition.nonGeometric[0].GlobalId = structuredClone(input.partition.geometry[0].GlobalId);
});
// Required staged causes are readable refusals, never success capabilities.
for (const [code, family, stage, requirement, reason] of [
  ['FEATURE_UNAVAILABLE', 'configuration', 'configuration', 'configuration', 'unavailable'],
  ['REMOVAL_POLICY_UNPROVEN', 'publication', 'publication', 'protected_removal', 'unproven'],
  ['INVALID_OPTIONS', 'configuration', 'configuration', 'configuration', 'invalid'],
  ['RUNTIME_FAILED', 'runtime', 'transport', 'numerical_evaluation', 'backend_failure'],
]) cases.push({ name: `staged_${code.toLowerCase()}`, root: 'Refusal', valid: true,
  input: { ...structuredClone(refusal), code, family, stage, requirement,
    detail: { reason, observed: '0', limit: '0' } } });

cases.push({ name: 'invalid_options_before_source_binding', root: 'Refusal', valid: true,
  input: { ...structuredClone(refusal), code: 'INVALID_OPTIONS', family: 'configuration', stage: 'configuration',
    source: { kind: 'unbound' }, target: { kind: 'model' }, requirement: 'configuration',
    detail: { reason: 'invalid', observed: '0', limit: '0' } } });
mutant('unbound_geometry_refusal', 'typed_refusal', (input) => { input.source = { kind: 'unbound' }; });
mutant('unbound_report_error', 'failed_enumeration', (input) => {
  input.error = { ...structuredClone(cases.find((item) => item.name === 'invalid_options_before_source_binding').input) };
});

// R1: these encodings are legal to ordinary Serde derives, but not this wire.
for (const baseline of ['frozen_options', 'typed_refusal', 'inspection_boundary']) {
  mutant(`positional_${baseline}`, baseline, (input, item) => { item.input = Object.values(input); });
}
mutant('nested_positional_options', 'complete_partition', (input) => {
  input.partition.identity.options = Object.values(input.partition.identity.options);
});
mutant('nested_positional_source', 'typed_refusal', (input) => { input.source.value = Object.values(input.source.value); });
mutant('nested_positional_detail', 'typed_refusal', (input) => { input.detail = Object.values(input.detail); });
mutant('nested_positional_product', 'complete_partition', (input) => { input.partition.geometry[0] = Object.values(input.partition.geometry[0]); });
mutant('object_enum_mode', 'frozen_options', (input) => { input.typeGeometryMode = { suppress_instanced: null }; });
mutant('object_enum_code', 'typed_refusal', (input) => { input.code = { OPERATION_UNSUPPORTED: null }; });
mutant('nested_object_enum_code', 'mixed_partition', (input) => { input.partition.refused[0].code = { OPERATION_UNSUPPORTED: null }; });
mutant('nested_object_enum_requirement', 'inspection_boundary', (input) => { input.unchecked[0] = { numerical_evaluation: null }; });

// R3: one-field contradictions; expectations are authored, never read from schema.
for (const [baseline, stage, requirement, reason] of [
  ['staged_invalid_options', 'numerical', 'textures', 'unsupported'],
  ['staged_removal_policy_unproven', 'configuration', 'textures', 'cancelled'],
]) {
  mutant(`${baseline}_wrong_stage`, baseline, (input) => { input.stage = stage; });
  mutant(`${baseline}_wrong_requirement`, baseline, (input) => { input.requirement = requirement; });
  mutant(`${baseline}_wrong_reason`, baseline, (input) => { input.detail.reason = reason; });
}
for (const [code, family, reason] of [
  ['CANCELLED', 'runtime', 'cancelled'], ['RESOURCE_EXHAUSTED', 'resource', 'exhausted'],
  ['DEADLINE_EXCEEDED', 'resource', 'deadline'], ['RUNTIME_FAILED', 'runtime', 'backend_failure'],
  ['WORKER_RETIRED', 'runtime', 'stale'], ['DEVICE_LOST', 'runtime', 'unavailable'],
]) for (const [stage, requirement] of [
  ['configuration', 'configuration'], ['source', 'source_authentication'], ['ownership', 'ownership'],
  ['enumeration', 'enumeration'], ['numerical', 'numerical_evaluation'], ['consumer', 'consumer'],
  ['appearance', 'textures'], ['publication', 'protected_removal'], ['transport', 'numerical_evaluation'],
]) {
  const name = `${code.toLowerCase()}_at_${stage}`;
  cases.push({ name, root: 'Refusal', valid: true, input: { ...structuredClone(refusal), code, family, stage,
    requirement, detail: { reason, observed: '0', limit: '0' } } });
  mutant(`${name}_wrong_reason`, name, (input) => { input.detail.reason = 'unsupported'; });
}
mutant('cancelled_wrong_requirement', 'cancelled_at_numerical', (input) => { input.requirement = 'textures'; });
mutant('cancelled_wrong_stage', 'cancelled_at_numerical', (input) => { input.stage = 'configuration'; });
mutant('runtime_wrong_context', 'runtime_failed_at_appearance', (input) => { input.requirement = 'numerical_evaluation'; });
mutant('resource_wrong_context', 'resource_exhausted_at_enumeration', (input) => { input.requirement = 'protected_removal'; });

// R4: settlement covers known entries without numerical success before enumeration.
// A post-enumeration interruption can retain an earlier geometry/removal product.
for (const status of ['failed', 'cancelled']) for (const outcome of ['geometry', 'removed']) {
  const error = { ...structuredClone(cancelledError), stage: 'publication', requirement: 'publication' };
  if (status === 'failed') { error.code = 'RUNTIME_FAILED'; error.detail.reason = 'backend_failure'; }
  const name = `${status}_after_enumeration_with_${outcome}`;
  cases.push({ name, root: 'ModelReport', valid: true, binding: structuredClone(binding),
    input: { status, error, partition: { ...structuredClone(incomplete.partition), geometry: [], [outcome]: [structuredClone(one)] } } });
  mutant(`${status}_${outcome}_before_enumeration`, name, (input, item) => {
    // Change the single logical enumeration fact in report and authenticated binding.
    input.partition.enumerationComplete = false; item.binding.enumerationComplete = false;
  });
}

// #7955 W2: isolate the cause/flag relation with ZERO geometry/removal successes.
mutant('enumeration_failed_claims_complete_without_successes', 'failed_enumeration', (input, item) => {
  input.partition.enumerationComplete = true; item.binding.enumerationComplete = true;
});
// Success-count contradictions change only the terminal cause, not the manifest.
for (const outcome of ['geometry', 'removed']) {
  mutant(`enumeration_failed_claims_complete_with_${outcome}`, `failed_after_enumeration_with_${outcome}`, (input) => {
    input.error = structuredClone(topError);
  });
}

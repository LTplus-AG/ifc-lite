// SPDX-License-Identifier: MPL-2.0
// #7955 A1s v1: private descriptive data, never publication authority.
// Change this schema's version before changing the wire contract after activation.
const record = (fields) => ({ kind: 'record', fields });
const enumeration = (...values) => ({ kind: 'enum', values });
const literal = (value) => ({ kind: 'literal', value });
const list = (item, min = 0, max = 4096) => ({ kind: 'list', item, min, max });
const union = (tag, variants) => ({ kind: 'union', tag, variants });

// Staged names only. No mapping from runtime strings and no capability activation.
export const causes = {
  configuration: ['FEATURE_UNAVAILABLE', 'RETAINED_DISABLED', 'INVALID_OPTIONS', 'CAPABILITY_MISSING'],
  source: ['SOURCE_INVALID', 'SOURCE_MISSING', 'SOURCE_MISMATCH', 'SOURCE_STALE', 'ENUMERATION_FAILED'],
  ownership: ['OWNER_MISMATCH', 'OWNER_RETIRED', 'RECEIPT_INVALID'],
  geometry: ['OPERATION_UNSUPPORTED', 'GEOMETRY_INVALID', 'OPENING_INVALID', 'LAYER_CUT_FAILED', 'INTERFACE_UNPROVEN'],
  appearance: ['APPEARANCE_INVALID', 'TEXTURE_UNAVAILABLE', 'PALETTE_INVALID', 'NORMAL_UNPROVEN', 'IDENTITY_UNPROVEN'],
  publication: ['REMOVAL_POLICY_UNPROVEN', 'PUBLICATION_FAILED'],
  resource: ['RESOURCE_EXHAUSTED', 'DEADLINE_EXCEEDED'],
  runtime: ['RUNTIME_FAILED', 'WORKER_RETIRED', 'DEVICE_LOST', 'CANCELLED'],
  consumer: ['CONSUMER_UNSUPPORTED', 'MIXED_ENGINE_EXPORT_UNSUPPORTED', 'EXPORT_FAILED'],
};

export const schema = {
  version: 1,
  maxWireBytes: 4 * 1024 * 1024,
  types: {
    Version: literal(1), Retained: literal('retained'), False: literal(false), Bool: { kind: 'bool' },
    Hash: { kind: 'text', format: 'hash' }, Commit: { kind: 'text', format: 'commit' },
    U64: { kind: 'text', format: 'u64' }, ProductId: { kind: 'text', format: 'positive_u64' },
    GlobalId: { kind: 'text', format: 'global_id' },
    Positive: { kind: 'number', minExclusive: 0, max: Number.MAX_VALUE },
    Angle: { kind: 'number', minExclusive: 0, max: Math.PI },
    PositiveLimit: { kind: 'text', format: 'positive_u64' },
    Source: record({ namespace: 'Hash', revision: 'U64', sha256: 'Hash' }),
    KnownGlobalId: record({ value: 'GlobalId' }), AbsentGlobalId: record({}),
    GlobalIdentity: union('kind', { known: 'KnownGlobalId', absent: 'AbsentGlobalId' }),
    ProductKey: record({ productId: 'ProductId', GlobalId: 'GlobalIdentity' }),
    Products: list('ProductKey'),
    KnownSource: record({ value: 'Source' }), UnboundSource: record({}),
    RefusalSource: union('kind', { known: 'KnownSource', unbound: 'UnboundSource' }),
    Family: enumeration(...Object.keys(causes)), Code: enumeration(...Object.values(causes).flat()),
    Stage: enumeration('configuration', 'enumeration', 'source', 'representation', 'ownership', 'numerical',
      'opening', 'layer', 'appearance', 'identity', 'publication', 'transport', 'consumer'),
    Requirement: enumeration('configuration', 'source_authentication', 'enumeration', 'ownership',
      'representation', 'numerical_evaluation', 'openings', 'layers', 'interfaces', 'textures', 'palettes',
      'normals', 'face_identity', 'instancing', 'final_geometry', 'protected_removal', 'publication', 'consumer'),
    Requirements: list('Requirement', 1, 32),
    // No free-form source/backend prose, paths, pointers or secrets enter safe detail.
    DetailReason: enumeration('unavailable', 'invalid', 'unsupported', 'mismatch', 'stale', 'unproven',
      'exhausted', 'deadline', 'cancelled', 'backend_failure'),
    Detail: record({ reason: 'DetailReason', observed: 'U64', limit: 'U64' }),
    Retry: literal('explicit_new_exact_request'),
    ModelTarget: record({}), ProductTarget: record({ product: 'ProductKey' }),
    Target: union('kind', { model: 'ModelTarget', product: 'ProductTarget' }),
    Refusal: record({ schemaVersion: 'Version', family: 'Family', code: 'Code', stage: 'Stage', source: 'RefusalSource',
      target: 'Target', requirement: 'Requirement', detail: 'Detail', exactRetry: 'Retry' }),
    TypeGeometryMode: enumeration('suppress_instanced', 'emit_tagged'),
    NormalPolicy: literal('source_analytic_v1'), InstancePolicy: literal('uncut_mapped_v1'),
    InterfacePolicy: literal('certified_internal_v1'), Openings: literal('all'), Layers: literal('preserve'),
    Options: record({ schemaVersion: 'Version', chordToleranceMetres: 'Positive', angleToleranceRadians: 'Angle',
      maxWork: 'PositiveLimit', maxBytes: 'PositiveLimit', deadlineMs: 'PositiveLimit',
      typeGeometryMode: 'TypeGeometryMode', normalPolicy: 'NormalPolicy', instancePolicy: 'InstancePolicy',
      interfacePolicy: 'InterfacePolicy', openings: 'Openings', layers: 'Layers', skipSmallCuts: 'False', mergeLayers: 'False' }),
    Identity: record({ schemaVersion: 'Version', coverageVersion: 'Version', engine: 'Retained',
      source: 'Source', options: 'Options', resultId: 'Hash' }),
    // Supplied separately by the authenticated enumerator, never inferred from a report.
    Binding: record({ identity: 'Identity', enumerationComplete: 'Bool', requested: 'Products', nonGeometric: 'Products' }),
    Refusals: list('Refusal'),
    Partition: record({ identity: 'Identity', enumerationComplete: 'Bool', geometry: 'Products',
      removed: 'Products', refused: 'Refusals', nonGeometric: 'Products' }),
    Completed: record({ partition: 'Partition' }), Interrupted: record({ partition: 'Partition', error: 'Refusal' }),
    ModelReport: union('status', { complete: 'Completed', incomplete: 'Completed', failed: 'Interrupted', cancelled: 'Interrupted' }),
    Column: enumeration('extractor', 'controller'), NumericalStage: literal('numerical'),
    NumericalBoundary: record({ stage: 'NumericalStage', requestOrdinal: 'U64' }),
    RefusedInspection: record({ refusal: 'Refusal' }), TraversalOnly: record({}),
    InspectionOutcome: union('kind', { requires_numerical_evaluation: 'NumericalBoundary', refused: 'RefusedInspection', traversal_only: 'TraversalOnly' }),
    DiagnosticKind: literal('source_inspection'), DiagnosticAuthority: literal('diagnostic_only'),
    InspectionReport: record({ schemaVersion: 'Version', kind: 'DiagnosticKind', authority: 'DiagnosticAuthority',
      identity: 'Identity', column: 'Column', implementationCommit: 'Commit', product: 'ProductKey',
      outcome: 'InspectionOutcome', unchecked: 'Requirements' }),
  },
};

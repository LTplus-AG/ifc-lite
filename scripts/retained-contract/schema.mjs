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
  ownership: ['OWNER_BUSY', 'OWNER_MISMATCH', 'OWNER_RETIRED', 'RECEIPT_INVALID'],
  geometry: ['OPERATION_UNSUPPORTED', 'GEOMETRY_INVALID', 'OPENING_INVALID', 'LAYER_CUT_FAILED', 'INTERFACE_UNPROVEN'],
  appearance: ['APPEARANCE_INVALID', 'TEXTURE_UNAVAILABLE', 'PALETTE_INVALID', 'NORMAL_UNPROVEN', 'IDENTITY_UNPROVEN'],
  publication: ['REMOVAL_POLICY_UNPROVEN', 'PUBLICATION_FAILED'],
  resource: ['RESOURCE_EXHAUSTED', 'DEADLINE_EXCEEDED'],
  runtime: ['RUNTIME_FAILED', 'WORKER_RETIRED', 'DEVICE_LOST', 'CANCELLED'],
  consumer: ['CONSUMER_UNSUPPORTED', 'MIXED_ENGINE_EXPORT_UNSUPPORTED', 'EXPORT_FAILED'],
};

// Context pairs, not independent stage/requirement sets: a transport failure may
// interrupt numerical work, but a numerical stage cannot claim a texture check.
const contexts = {
  configuration: ['configuration'], enumeration: ['enumeration'], source: ['source_authentication'],
  representation: ['representation', 'instancing'], ownership: ['ownership'],
  numerical: ['numerical_evaluation'], opening: ['openings'], layer: ['layers', 'interfaces'],
  appearance: ['textures', 'palettes', 'normals'], identity: ['face_identity'],
  publication: ['final_geometry', 'protected_removal', 'publication'],
  transport: ['source_authentication', 'enumeration', 'ownership', 'representation', 'numerical_evaluation',
    'openings', 'layers', 'interfaces', 'textures', 'palettes', 'normals', 'face_identity', 'instancing',
    'final_geometry', 'protected_removal', 'publication', 'consumer'],
  consumer: ['consumer'],
};
const pairs = (...stages) => stages.flatMap((stage) => contexts[stage].map((requirement) => [stage, requirement]));
const rule = (reason, allowed, measurement = 'not_applicable') => ({ reason, contexts: allowed, measurement });
const allContexts = pairs(...Object.keys(contexts));
// Private staged semantics, not an origin mapping or a resource-accounting grant.
const refusalRules = {
  FEATURE_UNAVAILABLE: rule('unavailable', allContexts),
  RETAINED_DISABLED: rule('unavailable', pairs('configuration')),
  INVALID_OPTIONS: rule('invalid', pairs('configuration')),
  CAPABILITY_MISSING: rule('unavailable', allContexts),
  SOURCE_INVALID: rule('invalid', pairs('source', 'enumeration', 'representation')),
  SOURCE_MISSING: rule('unavailable', pairs('source', 'enumeration', 'representation')),
  SOURCE_MISMATCH: rule('mismatch', allContexts), SOURCE_STALE: rule('stale', allContexts),
  ENUMERATION_FAILED: rule('invalid', pairs('enumeration')),
  OWNER_BUSY: rule('busy', pairs('ownership')),
  OWNER_MISMATCH: rule('mismatch', pairs('ownership')),
  OWNER_RETIRED: rule('stale', pairs('ownership')),
  RECEIPT_INVALID: rule('invalid', pairs('ownership', 'numerical', 'publication')),
  OPERATION_UNSUPPORTED: rule('unsupported', pairs('representation', 'numerical', 'opening', 'layer')),
  GEOMETRY_INVALID: rule('invalid', [['numerical', 'numerical_evaluation'], ['publication', 'final_geometry']]),
  OPENING_INVALID: rule('invalid', pairs('opening')),
  LAYER_CUT_FAILED: rule('invalid', [['layer', 'layers']]),
  INTERFACE_UNPROVEN: rule('unproven', [['layer', 'interfaces']]),
  APPEARANCE_INVALID: rule('invalid', pairs('appearance')),
  TEXTURE_UNAVAILABLE: rule('unavailable', [['appearance', 'textures']]),
  PALETTE_INVALID: rule('invalid', [['appearance', 'palettes']]),
  NORMAL_UNPROVEN: rule('unproven', [['appearance', 'normals']]),
  IDENTITY_UNPROVEN: rule('unproven', pairs('identity')),
  REMOVAL_POLICY_UNPROVEN: rule('unproven', [['publication', 'protected_removal']]),
  PUBLICATION_FAILED: rule('backend_failure', pairs('publication')),
  RESOURCE_EXHAUSTED: rule('exhausted', allContexts, 'exceeds'), DEADLINE_EXCEEDED: rule('deadline', allContexts, 'at_least'),
  RUNTIME_FAILED: rule('backend_failure', allContexts), WORKER_RETIRED: rule('stale', allContexts),
  DEVICE_LOST: rule('unavailable', allContexts), CANCELLED: rule('cancelled', allContexts),
  CONSUMER_UNSUPPORTED: rule('unsupported', pairs('consumer')),
  MIXED_ENGINE_EXPORT_UNSUPPORTED: rule('unsupported', pairs('consumer')),
  EXPORT_FAILED: rule('backend_failure', pairs('consumer')),
};

export const schema = {
  version: 1,
  maxWireBytes: 4 * 1024 * 1024,
  maxWireDepth: 32,
  refusalRules,
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
      'exhausted', 'deadline', 'cancelled', 'backend_failure', 'busy'),
    // Measured values describe an observed quantity and its configured bound.
    // Requested/remaining account payloads are not this measurement contract.
    Measured: record({ observed: 'U64', limit: 'U64' }), NotApplicable: record({}),
    Measurement: union('kind', { measured: 'Measured', not_applicable: 'NotApplicable' }),
    Detail: record({ reason: 'DetailReason', measurement: 'Measurement' }),
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

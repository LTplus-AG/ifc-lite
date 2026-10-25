// SPDX-License-Identifier: MPL-2.0
// Cut D private native extension. The shared taxonomy/options remain single-sourced.
import { schema as common } from '../retained-contract/schema.mjs';
const record = (fields) => ({ kind: 'record', fields });
const enumeration = (...values) => ({ kind: 'enum', values });
const union = (tag, variants) => ({ kind: 'union', tag, variants });
export const schema = {
  ...common,
  types: { ...common.types,
    NativeKind: { kind: 'literal', value: 'native_transaction_diagnostic' },
    NativeObligation: enumeration('opening_closure', 'material_layers', 'ifc_appearance', 'persistent_faces',
      'product_placement', 'numerical_evaluation', 'final_geometry', 'protected_removal', 'publication'),
    NativeObligations: { kind: 'list', item: 'NativeObligation', min: 1, max: 9 },
    ResourceDimension: enumeration('work', 'copy_bytes', 'output_bytes', 'occurrences', 'live_bytes', 'representation', 'coverage'),
    ResourceReason: enumeration('limit', 'overflow', 'allocation', 'unsupported_coverage'),
    OriginalResourceStop: record({ dimension: 'ResourceDimension', requested: 'U64', remaining: 'U64', reason: 'ResourceReason' }),
    NativeNoPayload: record({}),
    NativeOrigin: union('kind', { transaction: 'NativeNoPayload', resource_stop: 'OriginalResourceStop',
      cancelled: 'NativeNoPayload', deadline: 'NativeNoPayload', runtime_limit: 'NativeNoPayload' }),
    // Raw requested/remaining stops are deliberately not A1s observed/limit measurements.
    // Identity and target are bound by the enclosing native report and external Binding.
    NativeFailure: record({ family: 'Family', code: 'Code', stage: 'Stage', requirement: 'Requirement',
      reason: 'DetailReason', origin: 'NativeOrigin', exactRetry: 'Retry' }),
    NativeIntermediate: record({ dischargedOperations: 'U64', logicalValues: 'U64', sourceBindingCount: 'U64' }),
    NativeRefused: record({ refusal: 'NativeFailure' }),
    NativeOutcome: union('kind', { intermediate: 'NativeIntermediate', refused: 'NativeRefused' }),
    NativeReport: record({ schemaVersion: 'Version', kind: 'NativeKind', authority: 'DiagnosticAuthority',
      identity: 'Identity', implementationCommit: 'Commit', product: 'ProductKey', outcome: 'NativeOutcome',
      unchecked: 'NativeObligations', finalProductAvailable: 'False' }),
  },
};

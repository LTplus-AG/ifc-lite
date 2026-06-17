/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * IFC string encoding/decoding utilities and property value parsing.
 *
 * Core logic lives in @ifc-lite/encoding; this file re-exports it and adds
 * viewer-specific types (PropertySet/QuantitySet with mutation tracking).
 */

// Re-export core encoding functions from the package
export { decodeIfcString, parsePropertyValue } from '@ifc-lite/encoding';
export type { ParsedPropertyValue } from '@ifc-lite/encoding';

// ============================================================================
// Viewer-specific Types (with mutation tracking for property editing UI)
// ============================================================================

export interface PropertySet {
  name: string;
  /** `type` is the PropertyValueType (numeric enum) carried from the mutation
   *  view so the inline editor knows e.g. an *unset* Boolean is still a Boolean
   *  (it can't infer that from a null value alone). Optional — base/loaded
   *  properties may omit it and fall back to value inference. */
  properties: Array<{ name: string; value: unknown; isMutated?: boolean; type?: number }>;
  isNewPset?: boolean;
  /** Where this property set originates from: 'instance' (occurrence) or 'type' (inherited from IfcTypeObject) */
  source?: 'instance' | 'type';
}

export interface QuantitySet {
  name: string;
  quantities: Array<{ name: string; value: number; type: number }>;
}

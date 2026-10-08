/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Grounding gate result shapes (§5, ADR-003). Gate output is DATA: it is
 * returned verbatim to an agent and rendered by the UI, never thrown.
 */

import type { IFCVersion } from '@ifc-lite/ids';
import type { FacetFieldName } from '../document/fields.js';
import type { Uuid } from '../uuid.js';

export type GateCode =
  // Op shape and template expansion
  | 'GATE-OP-001'
  | 'GATE-OP-002'
  // Grounding against the IFC schema tables
  | 'GATE-ENT-001'
  | 'GATE-PDT-001'
  | 'GATE-ATT-001'
  | 'GATE-PSET-001'
  | 'GATE-PROP-001'
  | 'GATE-ENUM-001'
  | 'GATE-DT-001'
  // Custom (non-standard) property sets
  | 'GATE-CUST-001'
  | 'GATE-CUST-002'
  | 'GATE-CUST-003'
  | 'GATE-CUST-004'
  // Structural rules of the IDS XSD and the node model
  | 'GATE-STR-001'
  | 'GATE-STR-002'
  | 'GATE-STR-003'
  | 'GATE-STR-004'
  | 'GATE-STR-005'
  | 'GATE-STR-006'
  | 'GATE-STR-007'
  | 'GATE-STR-008'
  | 'GATE-STR-009'
  // Value well-formedness
  | 'GATE-VAL-001'
  | 'GATE-VAL-002'
  | 'GATE-VAL-003'
  | 'GATE-VAL-004'
  | 'GATE-VAL-005'
  | 'GATE-VAL-006'
  | 'GATE-VAL-007'
  | 'GATE-VAL-008'
  | 'GATE-VAL-009'
  // bSDD references (resolved through the bSDD cache)
  | 'GATE-BSDD-001';

/** A ranked "did you mean" suggestion. */
export interface GateCandidate {
  value: string;
  /** 0..1, higher is better. */
  score: number;
  /** Why it is suggested, e.g. "applicable to IfcWall" or "in Pset_DoorCommon". */
  reason?: string;
}

export interface GateIssue {
  ok: false;
  code: GateCode;
  /** Where in the submitted batch: `ops[2].payload.facet.baseName`. */
  path: string;
  message: string;
  candidates: GateCandidate[];
  /** Index of the offending op in the submitted batch. */
  opIndex: number;
  opId?: Uuid;
  /** The facet and field the issue is about, when there is one. */
  facetId?: Uuid;
  field?: FacetFieldName;
  /** The offending literal, when there is one. */
  value?: string;
  /** IFC versions of the spec in which the literal does not resolve. */
  versions?: IFCVersion[];
}

export interface GateResult {
  /** True when every op passed and the batch may be applied. */
  ok: boolean;
  issues: GateIssue[];
}

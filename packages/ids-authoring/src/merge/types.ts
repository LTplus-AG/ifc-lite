/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Three-way merge data model (02-document-model-and-ops.md §6). */

import type { DiffEntry } from '../diff/types.js';
import type { StudioDocument } from '../document/types.js';
import type { GateContext } from '../gate/context.js';
import type { GateIssue } from '../gate/types.js';
import type { PrimitiveOp } from '../ops/types.js';
import type { Uuid } from '../uuid.js';

export type MergeSide = 'ours' | 'theirs';

export interface MergeConflict {
  /** Stable id: the conflicting key (`facet:<id>:property.value`, …). */
  id: string;
  /**
   * `field`: both sides set one field differently.
   * `deleteEdit`: one side removed a node the other changed.
   */
  kind: 'field' | 'deleteEdit';
  /** The node the conflict is about. */
  specId?: Uuid;
  facetId?: Uuid;
  ours: DiffEntry[];
  theirs: DiffEntry[];
  /** The side applied, or `undefined` when unresolved (base kept). */
  resolution?: MergeSide;
}

export interface MergeDiagnostic {
  code: 'MERGE-ORDER-001' | 'MERGE-GATE-001';
  message: string;
  /** For MERGE-ORDER-001: the specification whose order was decided (absent = specification order). */
  specId?: Uuid;
  /** For MERGE-GATE-001: the gate's issue on the merged ops. */
  issue?: GateIssue;
}

export interface MergeOptions {
  /** Conflict id → the side to apply. Unresolved conflicts keep the base value. */
  resolutions?: Readonly<Record<string, MergeSide>>;
  /** Re-check the merged ops with the grounding gate. */
  gate?: GateContext;
  /** Seed for deterministic op ids. */
  seed?: string;
}

export interface MergeResult {
  doc: StudioDocument;
  /** Primitive ops that turn `base` into `doc`. */
  ops: PrimitiveOp[];
  conflicts: MergeConflict[];
  diagnostics: MergeDiagnostic[];
  /** No unresolved conflict and no gate issue. */
  clean: boolean;
}

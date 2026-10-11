/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Reducers for `meta.suppress` / `meta.unsuppress`: the writable side of
 * `meta.suppressions`, which the linter reads (`lint/suppress.ts`). Each
 * returns its exact inverse.
 *
 * Suppressions are sidecar annotations; they change no IDS content, so the
 * ops touch no node. The linter applies suppressions after its cache, so
 * writing one never forces a re-lint.
 *
 * Whether the node exists, the rule is a lint code and the reason is not
 * blank is checked by the gate (`checkSuppressionOp`), not here: undo must be able to restore a
 * suppression exactly as it was, even one on a node that has since been
 * removed or one imported without a reason.
 */

import type { StudioDocument, Suppression } from '../document/types.js';
import type { MetaSuppressOp, MetaUnsuppressOp } from '../ops/types.js';
import type { Uuid } from '../uuid.js';
import { insertAt, OpApplyError, removeAt, replaceAt } from './edit.js';
import { inv, type StepResult } from './spec-ops.js';

function withSuppressions(doc: StudioDocument, nodeId: Uuid, list: Suppression[] | undefined): StudioDocument {
  const suppressions = { ...doc.meta.suppressions };
  if (list === undefined) delete suppressions[nodeId];
  else suppressions[nodeId] = list;
  return { ...doc, meta: { ...doc.meta, suppressions } };
}

export function applySuppress(doc: StudioDocument, op: MetaSuppressOp): StepResult {
  const { nodeId, suppression, index } = op.payload;
  const had = Object.prototype.hasOwnProperty.call(doc.meta.suppressions, nodeId);
  const list = doc.meta.suppressions[nodeId] ?? [];
  const existing = list.findIndex((s) => s.rule === suppression.rule);
  if (existing >= 0) {
    return {
      doc: withSuppressions(doc, nodeId, replaceAt(list, existing, suppression)),
      inverse: [inv(op, 0, 'meta.suppress', { nodeId, suppression: list[existing] })],
      touched: [],
    };
  }
  const at = index ?? list.length;
  if (!Number.isInteger(at) || at < 0 || at > list.length) {
    throw new OpApplyError('GATE-STR-006', `suppression index ${at} is out of range 0..${list.length}`);
  }
  const payload: MetaUnsuppressOp['payload'] = { nodeId, rule: suppression.rule };
  if (had && list.length === 0) payload.keepEmpty = true;
  return {
    doc: withSuppressions(doc, nodeId, insertAt(list, at, suppression)),
    inverse: [inv(op, 0, 'meta.unsuppress', payload)],
    touched: [],
  };
}

export function applyUnsuppress(doc: StudioDocument, op: MetaUnsuppressOp): StepResult {
  const { nodeId, rule, keepEmpty } = op.payload;
  const list = doc.meta.suppressions[nodeId] ?? [];
  const index = list.findIndex((s) => s.rule === rule);
  if (index < 0) throw new OpApplyError('GATE-SUP-003', `node ${nodeId} has no suppression of ${rule}`);
  const next = removeAt(list, index);
  return {
    doc: withSuppressions(doc, nodeId, next.length === 0 && !keepEmpty ? undefined : next),
    inverse: [inv(op, 0, 'meta.suppress', { nodeId, suppression: list[index], index })],
    touched: [],
  };
}

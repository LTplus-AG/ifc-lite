/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { StudioDocument } from '../document/types.js';
import type { CompoundOp, PrimitiveOp } from '../ops/types.js';
import { OpApplyError } from '../reducer/edit.js';

/** Expand a compound op into primitives against `doc`. */
export function expandCompound(doc: StudioDocument, op: CompoundOp): PrimitiveOp[] {
  void doc;
  throw new OpApplyError('GATE-OP-001', `${op.kind} is not supported yet`);
}

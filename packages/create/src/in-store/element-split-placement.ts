/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { AnchorEntityReader } from './resolve-anchor.js';
import { axis3d, refId, type Frame3 } from './host-geometry-frame.js';
import { readAttributes, resolvePlacementChain } from './edit/placement-core.js';
import type { SplitEnvironment } from './element-split.js';

interface SplitPlacement {
  readonly parent: number | null;
  readonly frame: Frame3;
}

/** Read the effective section basis before emitting a piece. The source may
 * have a tilted axis, section roll, or placement parent below the storey. */
export function readSplitPlacement(env: SplitEnvironment, id: number): SplitPlacement {
  const chain = resolvePlacementChain(env.dataStore, env.view, env.editor, id);
  const reader = new AnchorEntityReader(env.dataStore, env.view);
  const placement = chain ? reader.entity(chain.localPlacementId) : null;
  const frame = chain ? axis3d(reader, chain.axisPlacementId) : null;
  if (!placement || !frame) throw new Error('Split requires a readable placement basis');
  const rawParent = placement.attributes[0];
  const parent = refId(rawParent);
  if (rawParent != null && parent === null) throw new Error('Split requires a readable placement parent');
  return { parent, frame };
}

/** Builder defaults choose a section orientation. Retain the source basis on
 * the new private placement instead: these direction leaves were just emitted
 * for this piece, so no existing occurrence or shared source leaf is changed. */
export function preserveSplitPlacement(env: SplitEnvironment, addedId: number, source: SplitPlacement): void {
  const chain = resolvePlacementChain(env.dataStore, env.view, env.editor, addedId);
  const attrs = chain ? readAttributes(env.dataStore, env.view, env.editor, chain.axisPlacementId) : null;
  const axis = attrs ? refId(attrs[1]) : null;
  const refDirection = attrs ? refId(attrs[2]) : null;
  if (!chain || axis === null || refDirection === null
    || !env.view.getNewEntity(axis) || !env.view.getNewEntity(refDirection)) {
    throw new Error('The new split piece has no private writable placement basis');
  }
  env.editor.setPositionalAttribute(chain.localPlacementId, 0, source.parent === null ? null : `#${source.parent}`);
  env.editor.setPositionalAttribute(axis, 0, source.frame.z);
  env.editor.setPositionalAttribute(refDirection, 0, source.frame.x);
}

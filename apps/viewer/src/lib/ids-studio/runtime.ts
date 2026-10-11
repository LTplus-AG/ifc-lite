/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The `@ifc-lite/ids-authoring` runtime the Studio store slice drives: state
 * creation, the gated write path, undo/redo and node lookup.
 *
 * Loaded ONLY through `runtime-loader.ts` (dynamic `import()`), so the root
 * store keeps the authoring reducer, gate and op schemas out of the viewer's
 * eager bundle. The slice imports this module's TYPE only.
 */

import { canRedo, canUndo, createStudioState, locateNode, redo, undo } from '@ifc-lite/ids-authoring';
import { dispatchStudioOps } from './session';

export const idsStudioRuntime = {
  createStudioState,
  dispatchStudioOps,
  canUndo,
  canRedo,
  undo,
  redo,
  locateNode,
};

export type IdsStudioRuntime = typeof idsStudioRuntime;

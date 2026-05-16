/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Barrel re-export for the split placement-edit modules. Kept so
 * existing call sites can continue to `import { … } from '@/lib/placement-edit'`
 * while the actual code lives in:
 *
 *   - `placement-core.ts` — attribute reader, chain walker,
 *     generic IfcProduct translate / rotate helpers
 *   - `wall-edit.ts` — rectangle-profile wall resize
 *
 * The split keeps each module under the ~400-line per-file limit
 * documented in AGENTS.md §7 and isolates the wall-specific
 * representation walk from the generic placement path.
 */

export {
  setSourceAttrsReader,
  readAttributes,
  asExpressIdRef,
  asCoordinateTriple,
  asDirectionRatios,
  resolvePlacementChain,
  translateProduct,
  setProductPosition,
  resolveRotationState,
  rotateProductYaw,
  type SourceAttrsReader,
  type PlacementChain,
  type TranslateResult,
  type RotationState,
  type RotateResult,
} from './placement-core.js';

export {
  resolveWallEditChain,
  resizeRectangleWall,
  type WallEditChain,
  type WallResizeResult,
} from './wall-edit.js';

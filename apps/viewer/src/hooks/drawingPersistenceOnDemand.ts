/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The part of the 2D-drawing persistence bridge that is imported on demand
 * (#7035), through `dxfUnderlaySave.ts`'s `drawingPersistenceOnDemand`: the
 * key resolver with its legacy-key move, and the IndexedDB underlay store.
 * Everything here runs after a model has become active and is asynchronous
 * already, so none of it has to be in the viewer's eager bundle.
 *
 * It is ONE dynamic entry on purpose. The bundler groups modules by the set
 * of entries that reach them, so a second on-demand entry that reached only
 * part of an eager chunk (the underlay store alone reaches `dxfReferencePlane`
 * but not the rest of the store chunk) split that chunk in two and cost more
 * eager bytes than the move saved.
 */

export { migrateLegacyDxfUnderlays, resolveDrawingPersistenceKey, unionById } from './drawingPersistenceKey.js';
export {
  loadDxfUnderlaysEntry,
  mergeDxfUnderlays,
  saveDxfUnderlaysEntry,
} from '@/store/slices/drawing2DSlice.dxfPersistence.js';

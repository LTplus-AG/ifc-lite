/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { PickOptions } from './types.js';
export type ReferencePoint = readonly [number, number, number];
/** Renderer Y-up coordinates, ordered top-left, top-right, bottom-right, bottom-left. */
export type ReferenceCorners = readonly [ReferencePoint, ReferencePoint, ReferencePoint, ReferencePoint];
export interface ReferenceImageInput {
  /** Separate namespace: never an IFC Express ID or federation global ID. */
  id: string;
  bitmap: ImageBitmap;
  corners: ReferenceCorners;
  visible: boolean;
  locked: boolean;
  opacity: number;
}
export interface ReferenceImageHit {
  referenceId: string;
  point: ReferencePoint;
  distance: number;
}
export interface ReferenceImages {
  /** Borrows the bitmap for upload; the caller retains ownership of the source. */
  set(input: ReferenceImageInput, signal?: AbortSignal): Promise<void>;
  remove(id: string): void;
  clear(): void;
  /** CSS canvas coordinates; hidden, locked and scene-occluded references do not hit. */
  pick(x: number, y: number, options?: PickOptions): Promise<ReferenceImageHit | null>;
}

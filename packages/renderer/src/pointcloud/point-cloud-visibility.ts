/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { isEntityVisible } from '../entity-visibility.js';
import type { PickOptions } from '../pick-types.js';

/** Tracks resident-asset visibility independently of GPU resource lifetime. */
export class PointCloudVisibility {
  private readonly values = new Map<number, boolean>();
  add(id: number): void { this.values.set(id, true); }
  remove(id: number): void { this.values.delete(id); }
  clear(): void { this.values.clear(); }
  visible(id: number): boolean { return this.values.get(id) !== false; }
  set(id: number, visible: boolean, exists: boolean): boolean {
    if (!exists || this.visible(id) === visible) return false;
    this.values.set(id, visible);
    return true;
  }
}

/** Per-entity hide/isolate sets (federated ids). They apply to inline clouds, never to streamed scans (#10215). */
export type PointCloudEntityFilter = Pick<PickOptions, 'hiddenIds' | 'isolatedIds'>;

/** True when `filter` lets entity `expressId` draw; no filter shows everything. */
export function entityShown(filter: PointCloudEntityFilter | undefined, expressId: number): boolean {
  return !filter || isEntityVisible(expressId, filter.hiddenIds, filter.isolatedIds);
}

/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

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

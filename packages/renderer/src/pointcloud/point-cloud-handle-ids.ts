/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Hands out point-cloud handle ids from a counter that must never restart
 * across a device-loss teardown. `PointCloudRenderer` is replaced wholesale
 * on recovery, and a fresh instance's own counter would otherwise restart at
 * 1 — reissuing an id that a still-in-flight stream's stale, closure-
 * captured handle still refers to, so a late `removePointCloudAsset` call
 * against that stale handle finds and deletes a live asset that happens to
 * have been allocated the same id.
 *
 * `Renderer.teardown()` reads `current()` from the outgoing
 * `PointCloudRenderer` and passes it as the replacement's `startHandleId`,
 * so ids are never reused.
 */
export class PointCloudHandleIds {
  private next: number;

  constructor(start = 1) {
    this.next = start;
  }

  /** Hand out the next id and advance the counter. */
  allocate(): number {
    return this.next++;
  }

  /** The id the next `allocate()` call will hand out. */
  current(): number {
    return this.next;
  }
}

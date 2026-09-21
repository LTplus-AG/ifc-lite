/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The CLI's tracking sidecar: `<graph>.tracking.json` beside the graph,
 * holding every tracked node's element set (see `@ifc-lite/flow` tracking).
 *
 * The sidecar records which model state it was written against. Headless
 * runs usually chain files (`run → out.ifc → run again on out.ifc`), so a
 * differing pin is expected and only warned about; the tracked create node
 * refuses to overwrite a foreign element with the same GlobalId regardless,
 * and a tracked element that is gone is re-created with a warning. The
 * viewer, which keeps one model loaded, applies the strict pin check.
 */

import { readFile, writeFile } from 'node:fs/promises';
import { TRACKING_SIDECAR_VERSION, type TrackedSet, type TrackingSidecar, type TrackingStore } from '@ifc-lite/flow';

export class FileTrackingStore implements TrackingStore {
  private sets: Record<string, TrackedSet> = {};
  private dirty = false;
  /** Pin recorded in the file that was loaded, when any. */
  loadedPin: string | undefined;

  constructor(readonly path: string, readonly pinnedTo: string) {}

  static async open(path: string, pinnedTo: string): Promise<FileTrackingStore> {
    const store = new FileTrackingStore(path, pinnedTo);
    let text: string | undefined;
    try {
      text = await readFile(path, 'utf-8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
    if (text !== undefined) {
      const parsed = JSON.parse(text) as Partial<TrackingSidecar>;
      if (parsed.version !== TRACKING_SIDECAR_VERSION) throw new Error(`${path}: unsupported tracking sidecar version ${String(parsed.version)}`);
      if (!parsed.sets || typeof parsed.sets !== 'object') throw new Error(`${path}: tracking sidecar has no "sets"`);
      store.sets = { ...parsed.sets };
      store.loadedPin = parsed.pinnedTo;
    }
    return store;
  }

  load(trackingKey: string): TrackedSet | undefined {
    return this.sets[trackingKey];
  }

  save(set: TrackedSet): void {
    this.sets[set.trackingKey] = set;
    this.dirty = true;
  }

  /** Write the sidecar if any set changed; returns whether it was written. */
  async flush(): Promise<boolean> {
    if (!this.dirty) return false;
    const sidecar: TrackingSidecar = { version: TRACKING_SIDECAR_VERSION, pinnedTo: this.pinnedTo, sets: this.sets };
    await writeFile(this.path, `${JSON.stringify(sidecar, null, 2)}\n`, 'utf-8');
    this.dirty = false;
    return true;
  }
}

/** Sidecar path for a graph: `audit.flow.json` → `audit.tracking.json`. */
export function defaultTrackingPath(graphPath: string): string {
  return graphPath.replace(/(\.flow)?\.json$/i, '') + '.tracking.json';
}

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

import { readFile, writeFile, realpath } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { digest, TRACKING_SIDECAR_VERSION, trackedSetsFrom, type TrackedSet, type TrackingSidecar, type TrackingStore } from '@ifc-lite/flow';

export class FileTrackingStore implements TrackingStore {
  private sets: Record<string, TrackedSet> = {};
  private dirty = false;
  private exists = false;
  private writePath: string;
  /** Pin recorded in the file that was loaded, when any. */
  loadedPin: string | undefined;

  constructor(readonly path: string, readonly pinnedTo: string) { this.writePath = resolve(path); }

  static async open(path: string, pinnedTo: string): Promise<FileTrackingStore> {
    const store = new FileTrackingStore(path, pinnedTo);
    try { store.writePath = await realpath(store.writePath); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      store.writePath = join(await realpath(dirname(store.writePath)), basename(store.writePath));
    }
    let text: string | undefined;
    try {
      text = await readFile(store.writePath, 'utf-8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
    if (text !== undefined) {
      store.exists = true;
      const parsed = JSON.parse(text) as Partial<TrackingSidecar>;
      if (parsed.version !== TRACKING_SIDECAR_VERSION) throw new Error(`${path}: unsupported tracking sidecar version ${String(parsed.version)}`);
      // Every set is shape-checked: `[]` is an object too, and a hand-edited
      // entry would otherwise reach the scheduler as a `TrackedSet` in name only.
      const sets = trackedSetsFrom(parsed.sets);
      if (!sets) throw new Error(`${path}: tracking sidecar has no valid "sets"`);
      // A sidecar without a pin cannot be checked against the model, and
      // adopting it silently would skip the very warning the pin exists for.
      if (typeof parsed.pinnedTo !== 'string') throw new Error(`${path}: tracking sidecar has no "pinnedTo"`);
      store.sets = sets;
      store.loadedPin = parsed.pinnedTo;
    }
    return store;
  }

  /** Bind review to the effective sidecar and its canonical destination, including planned writes. */
  fingerprint(): string {
    const sidecar = !this.exists && !this.dirty ? null : { version: TRACKING_SIDECAR_VERSION,
      pinnedTo: this.dirty ? this.pinnedTo : this.loadedPin ?? this.pinnedTo, sets: this.sets };
    return digest({ path: this.writePath, sidecar });
  }

  load(trackingKey: string): TrackedSet | undefined {
    return this.sets[trackingKey];
  }

  save(set: TrackedSet): void {
    this.sets[set.trackingKey] = set;
    this.dirty = true;
  }

  keys(): readonly string[] {
    return Object.keys(this.sets);
  }

  delete(trackingKey: string): void {
    if (!(trackingKey in this.sets)) return;
    delete this.sets[trackingKey];
    this.dirty = true;
  }

  /** Write the sidecar if any set changed; returns whether it was written. */
  async flush(): Promise<boolean> {
    if (!this.dirty) return false;
    const sidecar: TrackingSidecar = { version: TRACKING_SIDECAR_VERSION, pinnedTo: this.pinnedTo, sets: this.sets };
    await writeFile(this.writePath, `${JSON.stringify(sidecar, null, 2)}\n`, 'utf-8');
    this.dirty = false;
    this.exists = true;
    this.loadedPin = this.pinnedTo;
    return true;
  }
}

/** Sidecar path for a graph: `audit.flow.json` → `audit.tracking.json`. */
export function defaultTrackingPath(graphPath: string): string {
  return graphPath.replace(/(\.flow)?\.json$/i, '') + '.tracking.json';
}

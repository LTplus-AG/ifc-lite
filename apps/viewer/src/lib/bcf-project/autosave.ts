/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { BCFProject } from '@ifc-lite/bcf';
import type { ContentFailure } from '../storage/content-database.js';
import { decodeBcfProject, encodeBcfProject } from './project-codec.js';
import { readBcfSlot, writeBcfSlot } from './project-storage.js';

export type BcfAutosaveStatus = 'idle' | 'pending' | 'saved' | 'too-large' | 'unreadable' | ContentFailure;
const SAVE_DELAY_MS = 500;

export function createBcfAutosave(
  current: () => BCFProject | null,
  restore: (project: BCFProject) => void,
  publish: (status: BcfAutosaveStatus) => void,
) {
  let started = false;
  let loaded = false;
  let unreadable = false;
  let revision: string | null = null;
  let opening: Promise<boolean> | undefined;
  let generation = 0;
  let committed = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let queue = Promise.resolve(true);
  let queuedGeneration: number | undefined;

  function load(): Promise<boolean> {
    if (loaded) return Promise.resolve(!unreadable);
    return opening ??= (async () => {
      try {
        const slot = await readBcfSlot();
        const project = slot && slot !== 'unreadable' && slot.data !== null ? decodeBcfProject(slot.data) : null;
        loaded = true;
        if (slot === 'unreadable' || (slot?.data != null && !project)) {
          unreadable = true;
          publish('unreadable');
          return false;
        }
        revision = slot?.revision ?? null;
        if (generation === 0 && !current()) {
          if (project) restore(project);
          publish(project ? 'saved' : 'idle');
        }
        return true;
      } catch (error) {
        console.warn('[BCF autosave] Could not read current project', error);
        publish('unavailable');
        return false;
      } finally { opening = undefined; }
    })();
  }

  function enqueue(project: BCFProject | null, version: number): Promise<boolean> {
    if (queuedGeneration === version) return queue;
    queuedGeneration = version;
    queue = queue.then(async () => {
      if (version <= committed) return true;
      // A close still runs ahead of a later replacement. Stale non-null saves can be skipped.
      if (project && version !== generation) return false;
      if (!await load()) return false;
      if (project && version !== generation) return false;
      const encoded = project ? encodeBcfProject(project) : { ok: true as const, data: null };
      if (!encoded.ok) {
        publish(encoded.reason);
        return false;
      }
      const result = await writeBcfSlot(encoded.data, revision);
      if (result.ok) {
        revision = result.revision;
        committed = version;
      }
      if (version === generation) publish(result.ok ? (project ? 'saved' : 'idle') : result.reason);
      return result.ok;
    }).finally(() => { if (queuedGeneration === version) queuedGeneration = undefined; });
    return queue;
  }

  function flush(): Promise<boolean> {
    clearTimeout(timer);
    timer = undefined;
    if (!started) return Promise.resolve(true);
    if (generation === 0) return load();
    return enqueue(current(), generation);
  }

  function schedule(immediate = false): void {
    if (!started) return;
    clearTimeout(timer);
    if (unreadable) { publish('unreadable'); return; }
    publish('pending');
    if (immediate) void flush();
    else timer = setTimeout(() => void flush(), SAVE_DELAY_MS);
  }

  return {
    initialize: (): Promise<boolean> => {
      if (!started) {
        started = true;
        const result = load();
        if (generation > 0) schedule(current() === null);
        return result;
      }
      return load();
    },
    changed: (immediate = false): void => {
      generation++;
      schedule(immediate);
    },
    flush,
  };
}

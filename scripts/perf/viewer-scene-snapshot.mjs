/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Whether a warm reopen should wait for the viewer's scene-snapshot write,
 * decided by the viewer's own rule instead of a guess about the default.
 *
 * `apps/viewer/src/hooks/sceneSnapshotLoad.ts` `snapshotsEnabled()`: on when
 * `readPerfFlag('sceneSnapshot')` is undefined, null, `1` or `true`, so any
 * other value (`0`, `false`, `off`, `2`) turns it off. The URL value is parsed
 * by `@ifc-lite/data`'s `parsePerfFlagUrlValue`, imported here rather than
 * copied. The `__IFC_LITE_SCENE_SNAPSHOT` global, which takes precedence in the
 * product, is never set by these harnesses. Snapshots are written only on a
 * primary single-file cache hit, so an uncached tier never writes one.
 */

import { parsePerfFlagUrlValue } from '../../packages/data/src/perf-flag-reader.ts';

/** The viewer's `snapshotsEnabled()` for a page URL query (with or without the leading `?`). */
export function sceneSnapshotsEnabled(query = '') {
  const raw = new URLSearchParams(query.startsWith('?') ? query.slice(1) : query).get('perf.sceneSnapshot');
  const value = raw === null ? undefined : parsePerfFlagUrlValue(raw);
  return value === undefined || value === null || value === 1 || value === true;
}

/** Whether a reopen of this source will find a scene snapshot to wait for. */
export function expectSceneSnapshot({ query, files, cached }) {
  return cached && files === 1 && sceneSnapshotsEnabled(query);
}

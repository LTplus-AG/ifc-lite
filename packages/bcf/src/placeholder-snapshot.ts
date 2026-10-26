/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Placeholder snapshots for viewpoints that have no rendered image.
 *
 * BCF 2.1/3.0 make `<Snapshot>` optional, but BIMcollab Zoom (Windows 9.x)
 * treats a viewpoint without one as absent: activating the topic reports "This
 * issue has no viewpoint to zoom to" even when the camera and components are
 * valid. The reporter in #7974 saw the same in Revit, Navisworks and Dalux. A
 * headless export has no renderer to capture from, so it ships this neutral
 * image instead and the viewpoint stays usable.
 */

import type { BCFProject, BCFViewpoint } from './types.js';

/** 160x90 solid PNG in the viewer's snapshot background colour. */
const PLACEHOLDER_SNAPSHOT_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAKAAAABaCAIAAACwpMoFAAAAoklEQVR42u3RQQ0AAAjEsNMBf/xLxAc0mYI11aPDxQLAAizAAizAAizAgAVYgAVYgAVYgAELsAALsAALsAALMGABFmABFmABFmDAAizAAizAAizAgAVYgAVYgAVYgAUYsAALsAALsAALMGABFmABFmABFmDALgAWYAEWYAEWYAEGLMACLMACLMACDFiABViABViABViAAQuwAAuwAAuwAP9qAWqP/97F8o0yAAAAAElFTkSuQmCC';

/** Fresh copy of the placeholder PNG bytes. */
export function placeholderSnapshotPng(): Uint8Array {
  const binary = atob(PLACEHOLDER_SNAPSHOT_BASE64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function hasSnapshot(viewpoint: BCFViewpoint): boolean {
  return viewpoint.snapshotData !== undefined || !!viewpoint.snapshot?.startsWith('data:');
}

/**
 * Give every viewpoint in `project` that has no snapshot the placeholder
 * image, so consumers that require one can activate it. Returns how many
 * viewpoints were filled.
 */
export function fillMissingSnapshots(project: BCFProject): number {
  let filled = 0;
  for (const topic of project.topics.values()) {
    for (const viewpoint of topic.viewpoints) {
      if (hasSnapshot(viewpoint)) continue;
      viewpoint.snapshotData = placeholderSnapshotPng();
      filled++;
    }
  }
  return filled;
}

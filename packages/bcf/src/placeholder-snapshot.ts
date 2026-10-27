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

/**
 * Whether a viewpoint's image is the placeholder, from either a fresh
 * project (`snapshotData`) or a re-read archive (`snapshot` data URL). Use it
 * to keep the blank image out of previews and reports.
 */
export function isPlaceholderSnapshot(viewpoint: Pick<BCFViewpoint, 'snapshot' | 'snapshotData'>): boolean {
  if (viewpoint.snapshotData) {
    const placeholder = placeholderSnapshotPng();
    return viewpoint.snapshotData.length === placeholder.length
      && viewpoint.snapshotData.every((byte, i) => byte === placeholder[i]);
  }
  return viewpoint.snapshot?.split(',')[1] === PLACEHOLDER_SNAPSHOT_BASE64;
}

/** Whether writeBCF would emit a non-empty image for this viewpoint. */
function hasSnapshot(viewpoint: BCFViewpoint): boolean {
  // writeBCF prefers snapshotData even when empty, so an empty array is no image.
  if (viewpoint.snapshotData) return viewpoint.snapshotData.length > 0;
  const base64 = viewpoint.snapshot?.startsWith('data:') ? viewpoint.snapshot.split(',')[1] : undefined;
  if (!base64) return false;
  try {
    return atob(base64).length > 0;
  } catch {
    return false; // writeBCF drops a malformed data URL
  }
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

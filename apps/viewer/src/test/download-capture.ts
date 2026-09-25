/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Records the filename of every download the viewer starts, at the real seam:
 * the `<a download>` anchor that `lib/export/download.ts` clicks. No module
 * mocks, so a surface that bypassed the shared helpers would still be seen.
 *
 * Import after `@/test/setup-dom.js`. Call `downloadedNames()` for the names so
 * far and `clearDownloads()` between tests.
 */

const names: string[] = [];

document.addEventListener('click', (event: Event) => {
  const target = event.target;
  if (target instanceof HTMLAnchorElement && target.download) {
    // A real browser would start the download; happy-dom would navigate instead.
    event.preventDefault();
    names.push(target.download);
  }
});

let blobCount = 0;
URL.createObjectURL = (): string => `blob:ifc-lite-test-${++blobCount}`;
// `downloadBlob` revokes on a timer; these URLs were never real.
URL.revokeObjectURL = (): void => {};

export function downloadedNames(): readonly string[] {
  return names;
}

export function clearDownloads(): void {
  names.length = 0;
}

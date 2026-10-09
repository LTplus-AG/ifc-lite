/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// #7221: exact native domains, never a wildcard exclusion from the Linux observer.
const JOB = 'scripts/perf/frame-gpu-job.test.mjs';
const CONTROLLER = 'scripts/perf/frame-gpu-job-controller.test.mjs';
export function partitionTestPlatforms(entries) {
  const platforms = { linux: [], windows: [], posix: [] };
  for (const entry of entries) {
    if (entry.path === JOB || entry.path === CONTROLLER) {
      platforms.windows.push(entry);
      if (entry.path === CONTROLLER) platforms.posix.push(entry);
    } else platforms.linux.push(entry);
  }
  const covered = new Set(Object.values(platforms).flat().map(entry => entry.path));
  if (entries.some(entry => !covered.has(entry.path))) throw new Error('Changed test has no supported platform observer');
  return platforms;
}
export function selectPlatformTests(entries, stage) {
  if (stage === null) return entries;
  const platforms = partitionTestPlatforms(entries);
  if (!Object.hasOwn(platforms, stage)) throw new Error('Unknown platform observer stage: ' + stage);
  return platforms[stage];
}

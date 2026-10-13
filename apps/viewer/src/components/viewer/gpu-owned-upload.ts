/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { runGpuUpload } from './gpu-upload-guard.js';

/** Keep sibling effects mounted and clear partial GPU ownership after refusal. */
export function uploadGuarded(label: string, upload: () => void, clear: () => void): boolean {
  const uploaded = runGpuUpload(label, () => { upload(); return true; }) ?? false;
  if (!uploaded) runGpuUpload(`${label}:clear`, clear);
  return uploaded;
}

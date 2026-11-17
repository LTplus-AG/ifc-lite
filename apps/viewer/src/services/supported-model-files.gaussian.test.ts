/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #8568: pickers and drop offer `.splat` exactly when the loader admits
 * captures. The extension lists are build-time constants, so this process sets
 * the build's `VITE_GAUSSIAN_SPLATS` before importing them. The kill-switch build is `./supported-model-files.killswitch.test.ts`.
 */
import '../test/setup-dom.js';
import { it } from 'node:test';
import assert from 'node:assert/strict';
import { setGaussianBuild } from '@/test/gaussian-loader-harness';

/** The extensions the real File System Access picker is asked to accept. */
async function fileSystemPickerExtensions(): Promise<string[]> {
  const { openIfcFilesWithHandles } = await import('./file-system-access.js');
  let accepted: string[] = [];
  (window as unknown as Record<string, unknown>).showOpenFilePicker = async (options: { types: Array<{ accept: Record<string, string[]> }> }) => {
    accepted = options.types.flatMap((type) => Object.values(type.accept).flat());
    return [];
  };
  await openIfcFilesWithHandles();
  return accepted;
}

it('the default build offers .splat in the file inputs, the File System Access picker and the drop guard (#8568)', async () => {
  setGaussianBuild(undefined);
  const files = await import('./supported-model-files.js');
  assert.ok(files.FILE_ACCEPT.split(',').includes('.splat'), 'file input accept');
  assert.ok(files.FILE_ACCEPT.split(',').includes('.ply'), 'Gaussian PLY shares the point-cloud extension');
  assert.ok((await fileSystemPickerExtensions()).includes('.splat'), 'File System Access picker');
  assert.equal(files.isSupportedModelFile(new File([], 'Scan.SPLAT')), true, 'the drop and picker guard admit a capture');
  assert.equal(files.isSupportedModelFile(new File([], 'scan.ply')), true);
});

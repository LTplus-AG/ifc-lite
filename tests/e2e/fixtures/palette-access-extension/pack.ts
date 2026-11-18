/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

/** Runtime only: root pnpm/Turbo must build these canonical modules first.
 * Dynamic imports keep Playwright --list free of builds and pack execution.
 * Return real upload bytes, avoiding Linux/Windows CDP file-path ambiguity.
 */
export async function packWitness() {
  const { loadBundleFromDirectory } = await import('../../../../packages/extensions/dist/node.js');
  const { packBundle } = await import('../../../../packages/extensions/dist/bundle/iflx.js');
  const loaded = await loadBundleFromDirectory(fileURLToPath(new URL('./bundle/', import.meta.url)));
  if (!loaded.ok) throw new Error(`Witness bundle rejected: ${JSON.stringify(loaded.errors)}`);
  const bytes = packBundle(loaded.value);
  const again = packBundle(loaded.value);
  if (!Buffer.from(bytes).equals(Buffer.from(again))) throw new Error('Non-deterministic canonical pack');
  return {
    upload: { name: 'palette-access-witness.iflx', mimeType: 'application/octet-stream', buffer: Buffer.from(bytes) },
    sha256: createHash('sha256').update(bytes).digest('hex'),
    bytes: bytes.byteLength,
  };
}

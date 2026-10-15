/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { IfcParser } from '@ifc-lite/parser';
import { HeadlessLikeBackend } from './headless-backend.js';

it('an unsupported legacy backend call reports a structured refusal (DX3)', async () => {
  const bytes = readFileSync(new URL('../../../apps/viewer/public/samples/hello-wall.ifc', import.meta.url));
  const store = await new IfcParser().parseColumnar(Uint8Array.from(bytes).buffer, { disableWorkerScan: true });
  const backend = new HeadlessLikeBackend(store, 'sample.ifc', 'sample');
  let refusal: unknown;
  try {
    backend.store.addDoor('sample', 1, { Position: [0, 0, 0], Width: 1, Height: 2 });
  } catch (error) { refusal = error; }
  finally { backend.dispose(); }
  expect(backend.getMutationView()).toBeNull();
  expect(refusal).toBeInstanceOf(Error);
  expect(refusal).toMatchObject({ code: 'UNSUPPORTED_OPERATION', operation: 'store.addDoor' });
});

/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Proves `ModelMetadataPanel` (and the tree beneath it — `GeoreferencingPanel`
 * -> `useIfc` -> `useIfcLoader`/`useIfcServer` -> `utils/ifcConfig.ts`) is
 * importable under the plain `tsx --test` runner, which does not populate
 * `import.meta.env` (Vite-only). Before the guard in `ifcConfig.ts`, this
 * import throws at module-evaluation time and no test in this tree can run.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ModelMetadataPanel } from './ModelMetadataPanel.js';

describe('ModelMetadataPanel import', () => {
  it('is importable and is a function component', () => {
    assert.equal(typeof ModelMetadataPanel, 'function');
  });
});

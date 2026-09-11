/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it, expect, vi } from 'vitest';

// `assertRootDerivationIsLive()` (#4204) has no test exercising its throw
// path anywhere else in the suite: a guard whose failure path never runs is
// unproven. Stub `getInheritanceChain` — the only thing
// `columnar-entity-preparation.ts` imports from `ifc-schema.js` — to return
// a chain that never reaches IFCROOT, simulating a broken/empty schema
// registry, and prove the guard actually throws.
//
// This test file gets its own isolated module graph (vitest's default
// per-file isolation), so the guard's module-level `rootDerivationVerified`
// latch starts false here regardless of what other test files already ran.
vi.mock('../src/ifc-schema.js', () => ({
  getInheritanceChain: () => ['IfcWall', 'IfcBuildingElement'],
}));

import { assertRootDerivationIsLive } from '../src/columnar-entity-preparation.js';

describe('#4204 — assertRootDerivationIsLive throws when the registry cannot derive IfcRoot', () => {
  it('throws when getInheritanceChain(IFCWALL) never reaches IFCROOT', () => {
    expect(() => assertRootDerivationIsLive()).toThrow(/did not reach IFCROOT/);
  });
});

/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #5167 S.1: the structural authoring surface must be REACHABLE, not merely
 * declared.
 *
 * `StoreBackendMethods` is a structural type, so adding the nine
 * `addStructural*` / `connectStructural*` / `assignToStructuralGroup` methods
 * to the interface without wiring a backend does not make them callable — it
 * only breaks every host's typecheck. That is exactly the state this package
 * was in before `createStructuralStoreBackend` was spread into the CLI
 * backend, and no round-trip test in `@ifc-lite/create` or `@ifc-lite/sdk`
 * would have noticed, because they reach the builders directly.
 *
 * These assertions read the resolved backend store surface as a VALUE rather
 * than invoking it. That is deliberate: it keeps the failure an ordinary
 * assertion ("expected 'undefined' to be 'function'") instead of a
 * `TypeError: … is not a function`, which the revert oracle must treat as a
 * load failure and therefore cannot score.
 */

import { describe, expect, it } from 'vitest';
import { IfcParser } from '@ifc-lite/parser';
import { HeadlessBackend } from './headless-backend.js';

/** Smallest IFC4 file the parser accepts; no structural entities needed — the
 *  subject here is which methods the backend exposes, not what they author. */
const STEP = `ISO-10303-21;
HEADER;
FILE_DESCRIPTION((''),'2;1');
FILE_NAME('','2026-09-22T00:00:00',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPROJECT('0structuralreach00001',$,'Reachability',$,$,$,$,$,$);
ENDSEC;
END-ISO-10303-21;
`;

const STRUCTURAL_STORE_METHODS = [
  'addStructuralAnalysisModel',
  'addStructuralCurveMember',
  'addStructuralPointConnection',
  'addStructuralLoadGroup',
  'addStructuralPointAction',
  'addStructuralLinearAction',
  'connectStructuralMemberToConnection',
  'connectStructuralActivityToItem',
  'assignToStructuralGroup',
] as const;

async function headlessStore() {
  const bytes = new TextEncoder().encode(STEP);
  const store = await new IfcParser().parseColumnar(
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
    { disableWorkerScan: true },
  );
  // Deliberately the BACKEND's own store surface, not `createBimContext(...).store`.
  // The SDK's StoreNamespace declares these methods as class members, so they are
  // present there whether or not any backend implements them — asserting on the
  // wrapper passes even with the backend un-wired, which is the tautology this
  // test exists to avoid. `StoreBackendMethods` is where the wiring actually shows.
  return new HeadlessBackend(store, 'structural.ifc').store as unknown as Record<string, unknown>;
}

describe('#5167 CLI structural store surface', () => {
  it('exposes every structural authoring method on the backend store surface', async () => {
    const bimStore = await headlessStore();
    const missing = STRUCTURAL_STORE_METHODS.filter((name) => typeof bimStore[name] !== 'function');
    expect(missing, `bim.store is missing structural authoring methods: ${missing.join(', ')}`).toEqual([]);
  });

  it('keeps the cost authoring surface alongside it', async () => {
    // Both come from the same shared per-call resolution; losing one while
    // keeping the other would mean the two surfaces resolve different editors.
    const bimStore = await headlessStore();
    expect(typeof bimStore.addCostSchedule).toBe('function');
    expect(typeof bimStore.addStructuralAnalysisModel).toBe('function');
  });
});

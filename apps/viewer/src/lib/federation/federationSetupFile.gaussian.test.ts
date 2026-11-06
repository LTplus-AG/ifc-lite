/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { it } from 'node:test';
import assert from 'node:assert/strict';
import type { FederatedModel } from '../../store/types.js';
import { buildFederationSetupFile, parseFederationSetupFile, serializeFederationSetupFile } from './federationSetupFile.js';

const RX180 = [1, 0, 0, 0, 0, -1, 0, 0, 0, 0, -1, 0, 0, 0, 0, 1];
const capture = (id: string, placementOrigin: 'source' | 'explicit') => ({
  id, name: `${id}.ply`, fileSize: 10, visible: true, collapsed: false,
  gaussianSplat: { placementOrigin, placement: placementOrigin === 'explicit' ? RX180 : [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] },
}) as unknown as FederatedModel;

it('a saved setup keeps only an explicitly chosen capture placement and round-trips it (#8566)', async () => {
  const setup = await buildFederationSetupFile([capture('placed', 'explicit'), capture('raw', 'source')], null);
  const text = serializeFederationSetupFile(setup);
  const parsed = parseFederationSetupFile(text);
  assert.ok(parsed.ok);
  assert.deepEqual(parsed.setup.slots.map((slot) => slot.gaussianPlacement), [RX180, undefined], 'raw-source placement is never invented');
  assert.equal(serializeFederationSetupFile(parsed.setup), text, 'deterministic');
  const broken = JSON.parse(text);
  broken.slots[0].gaussianPlacement = RX180.slice(1);
  assert.match(String((parseFederationSetupFile(JSON.stringify(broken)) as { error?: string }).error), /16 finite numbers/);
});

it('setup persists source axes and unbaked placement, never IFC frame offsets (#8752)', async () => {
  const model = capture('survey', 'explicit');
  model.gaussianSplat = { ...model.gaussianSplat!, sourcePlacement: RX180, upAxis: 'z',
    placement: [1, 0, 0, 0, 0, 0, -1, 0, 0, 1, 0, 0, -2_600_000, -520, 1_200_000, 1] };
  const parsed = parseFederationSetupFile(serializeFederationSetupFile(await buildFederationSetupFile([model], null)));
  assert.ok(parsed.ok);
  assert.deepEqual(parsed.setup.slots[0].gaussianPlacement, RX180);
  assert.equal(parsed.setup.slots[0].gaussianUpAxis, 'z');
  const invalid = { ...parsed.setup, slots: [{ ...parsed.setup.slots[0], gaussianUpAxis: 'x' }] };
  assert.equal(parseFederationSetupFile(JSON.stringify(invalid)).ok, false);
});

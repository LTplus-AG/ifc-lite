/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import assert from 'node:assert/strict';
import { afterEach, test, type TestContext } from 'node:test';
import type { MeshData } from '@ifc-lite/geometry';
import type { Renderer } from '@ifc-lite/renderer';
import { useViewerStore } from '@/store';
import { useActivityJournal } from '@/lib/activity/activity-journal';
import { resetFeaturesForTest } from '@/lib/features';
import { zoneSetRevision } from '@/lib/zones/apportionment-cache';
import { setGlobalRendererRef } from '@/hooks/useBCF';
import { ensureWasm } from '@/test/scan-slab-fixture';
import { seedZoneExport } from '@/test/zone-export-fixture';
import { viewerHost } from '@/test/agent-tools-fixture';
import { Scene } from '../../../../../../packages/renderer/src/scene';
import { dispatchMainViewerTool, type AgentToolResult } from '../main-viewer-dispatch';
import { listArtifacts, readArtifact } from './artifacts';

const initial = useViewerStore.getState();
afterEach(() => {
  setGlobalRendererRef({ current: null });
  useViewerStore.setState(initial, true);
  resetFeaturesForTest();
});

async function setup(t: TestContext) {
  if (!ensureWasm(t)) return null;
  resetFeaturesForTest();
  const fixture = await seedZoneExport();
  const scene = new Scene();
  fixture.meshes.forEach(mesh => scene.addMeshData(mesh));
  setGlobalRendererRef({ current: { getScene: () => scene } as unknown as Renderer });
  const host = viewerHost();

  async function duringExport(operation_id: string, input: object, change: () => void) {
    let changed = false;
    const unsubscribe = useActivityJournal.subscribe(() => {
      if (changed) return;
      changed = true;
      change();
    });
    try {
      const result = await dispatchMainViewerTool(host, 'viewer_operation_execute', { operation_id, input }, { canEdit: () => true });
      assert.equal(changed, true, 'the mutation ran while the native export was active');
      return result;
    } finally {
      unsubscribe();
    }
  }

  function recolour() {
    const color: MeshData['color'] = [0.25, 0.5, 0.75, 1];
    const state = useViewerStore.getState();
    state.updateZone(fixture.zoneSet.id, 'whole', { color: [0.25, 0.5, 0.75] });
    state.updateMeshColors(new Map([[fixture.wall.expressId, color]]));
    useViewerStore.setState(now => ({
      zoneAssignments: new Map(now.zoneAssignments),
    }));
  }

  function artifactId(result: AgentToolResult) {
    assert.equal(result.isError, false, result.text);
    const output = (result.structured as { result: { native_json: string } }).result;
    const detail = JSON.parse(output.native_json) as { artifact: { artifact_id: string } | null };
    assert.ok(detail.artifact);
    return detail.artifact.artifact_id;
  }

  return { ...fixture, host, duringExport, recolour, artifactId };
}

test('zones.geometry.export discards a realigned wall and publishes after a recolour (#10969)', async t => {
  const fixture = await setup(t);
  if (!fixture) return;
  const input = { set_id: fixture.zoneSet.id, zone_id: 'whole' };
  const recoloured = await fixture.duringExport('zones.geometry.export', input, fixture.recolour);
  const artifact = fixture.artifactId(recoloured);
  assert.equal(Buffer.from((await readArtifact(fixture.host, artifact, 0, 4)).data, 'base64').toString(), 'glTF');

  const realigned = await fixture.duringExport('zones.geometry.export', input, () => {
    // Federation realignment changes vertices in place and increments the content version.
    fixture.wall.positions[0] += 0.125;
    useViewerStore.getState().bumpGeometryContentVersion();
  });
  assert.equal(realigned.isError, true, realigned.text);
  assert.match(realigned.text, /changed during native export/);
  assert.deepEqual(listArtifacts(fixture.host).map(row => row.artifact_id), [artifact]);
});

test('zones.table.export discards a new apportionment and publishes after a recolour (#10969)', async t => {
  const fixture = await setup(t);
  if (!fixture) return;
  const input = { set_id: fixture.zoneSet.id, basis: 'mesh', format: 'csv' };
  const recoloured = await fixture.duringExport('zones.table.export', input, fixture.recolour);
  const artifact = fixture.artifactId(recoloured);
  const csv = await readArtifact(fixture.host, artifact, 0, 65_536);
  assert.match(Buffer.from(csv.data, 'base64').toString(), /Native Bonsai sections/);

  const recomputed = await fixture.duringExport('zones.table.export', input, () => {
    const zone = fixture.zoneSet.zones[0];
    const volume = fixture.wall.geometryVolume ?? 1;
    useViewerStore.getState().setZoneApportionment(fixture.zoneSet.id, {
      revision: zoneSetRevision(fixture.zoneSet),
      byElement: new Map([[fixture.wall.expressId, {
        wholeVolumeM3: volume, shares: [{ zoneId: zone.id, zoneName: zone.name, volumeM3: volume / 2, fraction: 0.5 }],
        outsideVolumeM3: volume / 2, outsideFraction: 0.5, overlapping: false, unreliable: false,
      }]]),
      refused: new Map(), computedAt: 1, elapsedMs: 1,
    });
  });
  assert.equal(recomputed.isError, true, recomputed.text);
  assert.match(recomputed.text, /changed during export/);
  assert.deepEqual(listArtifacts(fixture.host).map(row => row.artifact_id), [artifact]);
});

for (const kind of ['geometry', 'table'] as const) {
  test(`zones.${kind}.export discards a tick-only invalidation after recolouring (#10969)`, async t => {
    const fixture = await setup(t);
    if (!fixture) return;
    const set_id = fixture.zoneSet.id;
    const input = kind === 'geometry' ? { set_id, zone_id: 'whole' } : { set_id, basis: 'mesh', format: 'csv' };
    const invalidated = await fixture.duringExport(`zones.${kind}.export`, input, () => {
      fixture.recolour();
      useViewerStore.setState(now => ({ geometryUpdateTick: now.geometryUpdateTick + 1 }));
    });
    assert.equal(invalidated.isError, true, invalidated.text);
    assert.match(invalidated.text, /changed during/);
    assert.deepEqual(listArtifacts(fixture.host), []);
  });
}

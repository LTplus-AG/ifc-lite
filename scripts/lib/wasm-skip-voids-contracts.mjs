// SPDX-License-Identifier: MPL-2.0
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { parseMeshesViaPrePass } from './mesh-via-prepass.mjs';

function volume(meshes, id) {
  let sum = 0;
  const selected = meshes.filter(m => m.expressId === id);
  assert.ok(selected.length, `missing #${id}`);
  for (const { positions: p, indices } of selected) {
    for (let i = 0; i < indices.length; i += 3) {
      const [a, b, c] = Array.from(indices.slice(i, i + 3), n => n * 3);
      sum += p[a] * (p[b+1]*p[c+2] - p[b+2]*p[c+1])
        + p[a+1] * (p[b+2]*p[c] - p[b]*p[c+2])
        + p[a+2] * (p[b]*p[c+1] - p[b+1]*p[c]);
    }
  }
  return Math.abs(sum / 6);
}

export function runSkipVoidsContracts({ test, skip, IfcAPI }) {
  runRealSkipVoidsContract({ test, skip, IfcAPI });
  test('#8875: actual WASM gross/net toggle preserves authored booleans and restores net bytes', () => {
    const api = new IfcAPI();
    const source = readFileSync(new URL('../../rust/processing/tests/fixtures/issue_2019_wall_two_overlapping_openings.ifc', import.meta.url), 'utf8');
    const run = (content) => {
      const collection = parseMeshesViaPrePass(api, content);
      try {
        return Array.from({ length: collection.length }, (_, i) => {
          const m = collection.get(i);
          return { expressId: m.expressId, positions: m.positions, indices: m.indices, color: m.color };
        });
      } finally { collection.free(); }
    };
    try {
      const net = run(source);
      api.setSkipVoids(true);
      const gross = run(source);
      assert.ok(Math.abs(volume(gross, 30) - 2.4) < 1e-5);
      assert.ok(volume(net, 30) < 2.2);
      const boolean = source.replace("'SweptSolid',(#26)", "'CSG',(#130)")
        .replace('ENDSEC;\nEND-ISO', '#130=IFCBOOLEANRESULT(.DIFFERENCE.,#26,#46);\nENDSEC;\nEND-ISO');
      const authored = run(boolean);
      const authoredVolume = volume(authored, 30);
      assert.ok(Math.abs(authoredVolume - 2.16) < 32 / 65536, `authored cut volume: ${authoredVolume}`);
      api.setSkipVoids(false);
      // Independent oracle: removing relationship records leaves exactly the same
      // authored boolean geometry. Numeric tolerance above covers the kernel grid.
      const authoredOnly = boolean.split("\n").filter(line => !line.includes("= IFCRELVOIDSELEMENT(")).join("\n");
      assert.deepEqual(run(authoredOnly), authored);
      assert.deepEqual(run(source), net);
    } finally { api.free(); }
  });
}

/** A real Archicad file: only hosts named by the void index may change. */
export function runRealSkipVoidsContract({ test, skip, IfcAPI }) {
  const fixture = new URL('../../tests/models/ara3d/AC20-FZK-Haus.ifc', import.meta.url);
  const name = '#8875: Archicad gross geometry changes hosts only';
  if (!existsSync(fixture)) { skip(name, 'run pnpm fixtures'); return; }
  test(name, () => {
    const api = new IfcAPI();
    const source = readFileSync(fixture, 'utf8');
    const snapshot = () => {
      const collection = parseMeshesViaPrePass(api, source);
      try {
        return Array.from({length: collection.length}, (_, i) => {
          const m = collection.get(i);
          return {expressId: m.expressId, positions: m.positions, indices: m.indices, color: m.color};
        });
      } finally { collection.free(); }
    };
    try {
      const pre = api.buildPrePassOnce(new TextEncoder().encode(source));
      const hosts = new Set(pre.voidKeys);
      api.clearPrePassCache();
      assert.ok(hosts.size > 0);
      const net = snapshot();
      api.setSkipVoids(true);
      const gross = snapshot();
      assert.deepEqual(gross.filter(m => !hosts.has(m.expressId)), net.filter(m => !hosts.has(m.expressId)));
      const netHosts = net.filter(m => hosts.has(m.expressId));
      const grossHosts = gross.filter(m => hosts.has(m.expressId));
      assert.notDeepEqual(grossHosts, netHosts);
      const total = meshes => [...new Set(meshes.map(m => m.expressId))].reduce((sum, id) => sum + volume(meshes, id), 0);
      const netVolume = total(netHosts), grossVolume = total(grossHosts);
      assert.ok(grossVolume > netVolume + 0.01);
      console.log(`#8875 Archicad hosts: net=${netVolume} m³ gross=${grossVolume} m³; non-host meshes byte-identical`);
      api.setSkipVoids(false);
      assert.deepEqual(snapshot(), net);
    } finally { api.free(); }
  });
}

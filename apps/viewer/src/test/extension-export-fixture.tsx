/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
// #7170 actual packed extension installation and QuickJS handler over authored IFC.
import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import { createBimContext } from '@ifc-lite/sdk';
import { packBundle, type Bundle } from '@ifc-lite/extensions';
import { ExtensionHostService } from '@/services/extensions/host';
import { LocalBackend } from '@/sdk/local-backend';
import { ExtensionHostContext } from '@/sdk/ExtensionHostProvider';
import { useViewerStore } from '@/store';
import { render } from '@/test/render';
import { seedArtifactModels } from '@/test/artifact-models-fixture';
import { useExtensionExporters } from '@/components/extensions/useExtensionExporters';

export const EXPORTER = 'native-walls';
export class NativeExporterHost extends ExtensionHostService {
  readonly gates = new Map<string, Promise<void>>();
  readonly delivered = new Map<string, Awaited<ReturnType<ExtensionHostService['runExporter']>>>();
  constructor() { super({ sdk: createBimContext({ backend: new LocalBackend(useViewerStore) }) }); }
  override async runExporter(exporterId: string, extensionId: string) {
    const actual = await super.runExporter(exporterId, extensionId);
    this.delivered.set(extensionId, actual);
    // Delay delivery of a real native output, never replace its value or execution.
    await this.gates.get(extensionId);
    return actual;
  }
}
export async function installNativeExporter(host: NativeExporterHost, owner: string, fail = false) {
  const path = 'exporters/walls.js';
  const text = fail ? 'function run(ctx) { throw new Error("native extension handler refused"); }'
    : `function run(ctx) { return JSON.stringify({ owner: ${JSON.stringify(owner)}, walls: ctx.bim.query.byType('IfcWall').map(wall => ({ GlobalId: wall.GlobalId, Name: wall.Name })) }); }`;
  const bundle: Bundle = {
    manifest: { manifestVersion: 1, id: owner, name: owner, description: 'Native exporter acceptance fixture',
      version: '1.0.0', engines: { ifcLiteSdk: '>=2.0.0' }, capabilities: ['model.read'],
      activation: [`onExporter:${EXPORTER}`], entry: {}, contributes: { exporters: [{
        id: EXPORTER, name: 'Native walls', extension: '.json', mimeType: 'application/json', handler: path,
      }] } },
    files: new Map([[path, { path, text, bytes: new TextEncoder().encode(text) }]]),
  };
  const manifest = JSON.stringify(bundle.manifest);
  bundle.files.set('manifest.json', { path: 'manifest.json', text: manifest, bytes: new TextEncoder().encode(manifest) });
  await host.installFromBytes(packBundle(bundle), ['model.read']);
}
export async function nativeExporterHost() {
  await seedArtifactModels();
  return new NativeExporterHost();
}
export function mountExporters(host: NativeExporterHost | null) {
  let current: ReturnType<typeof useExtensionExporters> | null = null;
  function Controls() { current = useExtensionExporters('toolbar'); return null; }
  const ui = render(<ExtensionHostContext.Provider value={host}><Controls /></ExtensionHostContext.Provider>);
  return { ui, get current() { assert.ok(current); return current; } };
}

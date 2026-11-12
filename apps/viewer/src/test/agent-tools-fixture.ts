/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Seeds for the main-viewer agent tool host tests (#9523): real parsed
 * models in `useViewerStore`, each with the configured overlay the viewer
 * registers for it, read through a real `LocalBackend`.
 */

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { IfcParser, type IfcDataStore } from '@ifc-lite/parser';
import { MutablePropertyView } from '@ifc-lite/mutations';
import { createBimContext, type BimContext } from '@ifc-lite/sdk';
import { useViewerStore, type FederatedModel } from '@/store';
import { LocalBackend } from '@/sdk/local-backend';
import { fixtureModel } from '@/test/store-fixture';
import { configureMutationView } from '@/utils/configureMutationView';
import { createMainViewerToolHost, type MainViewerToolHostOptions } from '@/lib/agent-tools/main-viewer-host';
import { dispatchMainViewerTool, type AgentToolResult } from '@/lib/agent-tools/main-viewer-dispatch';

export const HELLO_WALL = new URL('../../public/samples/hello-wall.ifc', import.meta.url);
export const HELLO_WALL_IFCX = new URL('../../public/samples/hello-wall.ifcx', import.meta.url);
export const WALL_ID = 1222;
export const WALL_GID = '2JUHrTM_j3UxZiBnyBfByx';

/** A second, unrelated model: one wall 'Other wall' in storey 'L0', STEEL, a Uniclass reference, millimetres. */
export const OTHER = `ISO-10303-21;
HEADER;
FILE_DESCRIPTION((''),'2;1');
FILE_NAME('other.ifc','2024-01-01T00:00:00',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPROJECT('0proj00000000000000000',$,'P',$,$,$,$,(#20),#30);
#20=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-05,#21,$);
#21=IFCAXIS2PLACEMENT3D(#22,$,$);
#22=IFCCARTESIANPOINT((0.,0.,0.));
#30=IFCUNITASSIGNMENT((#31));
#31=IFCSIUNIT(*,.LENGTHUNIT.,.MILLI.,.METRE.);
#40=IFCBUILDINGSTOREY('2hQBAVPOr5VxhS3Jl0O47h',$,'L0',$,$,#41,$,$,.ELEMENT.,0.);
#41=IFCLOCALPLACEMENT($,#21);
#50=IFCWALL('1wall00000000000000000',$,'Other wall',$,$,#41,$,$,.SOLIDWALL.);
#70=IFCRELAGGREGATES('0kTvXnbbzCWw8lcMd1dR4o',$,$,$,#1,(#40));
#71=IFCRELCONTAINEDINSPATIALSTRUCTURE('0cont00000000000000000',$,$,$,(#50),#40);
#80=IFCMATERIAL('STEEL',$,$);
#81=IFCRELASSOCIATESMATERIAL('0mat000000000000000000',$,$,$,(#50),#80);
#90=IFCCLASSIFICATION($,$,$,'Uniclass',$,$,$);
#91=IFCCLASSIFICATIONREFERENCE($,'EF_25_10','Walls',#90,$,$);
#92=IFCRELASSOCIATESCLASSIFICATION('0cls000000000000000000',$,$,$,(#50),#91);
ENDSEC;
END-ISO-10303-21;
`;

export async function fileBytes(url: URL): Promise<Uint8Array> {
  return new Uint8Array(await readFile(url));
}

export async function parseStep(bytes: Uint8Array): Promise<IfcDataStore> {
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  const store = await new IfcParser().parseColumnar(buffer, { disableWorkerScan: true });
  store.fileSize = bytes.byteLength;
  return store;
}

export const parseHelloWall = async () => parseStep(await fileBytes(HELLO_WALL));
export const parseOther = () => parseStep(new TextEncoder().encode(OTHER));

export function model(id: string, store: IfcDataStore | null, extra: Partial<FederatedModel> = {}): FederatedModel {
  return {
    ...fixtureModel(id),
    name: `${id}.ifc`,
    fileSize: store?.fileSize ?? 0,
    ifcDataStore: store,
    loadState: 'complete',
    maxExpressId: 100_000,
    ...extra,
  } as FederatedModel;
}

export function configuredView(store: IfcDataStore, id: string): MutablePropertyView {
  const view = new MutablePropertyView(store.properties || null, id);
  configureMutationView(view, store);
  // Created ids start above the parsed file, as the viewer's editor seeds them.
  view.setExpressIdWatermark(1_000_000);
  return view;
}

/** Seed the store the way the viewer wires a loaded model: one configured overlay per model id. */
export function seed(models: FederatedModel[]): void {
  const views = new Map<string, MutablePropertyView>();
  for (const m of models) if (m.ifcDataStore) views.set(m.id, configuredView(m.ifcDataStore, m.id));
  useViewerStore.setState({
    models: new Map(models.map((m) => [m.id, m])),
    activeModelId: models[0]?.id ?? null,
    ifcDataStore: null,
    editEnabled: true,
    mutationViews: views,
    storeEditors: new Map(),
    undoStacks: new Map(),
    redoStacks: new Map(),
    mutationBatchTags: new Map(),
    mutationVersion: 0,
  });
}

export function viewerBim(): BimContext {
  return createBimContext({ backend: new LocalBackend(useViewerStore) });
}

export function viewerHost(options: MainViewerToolHostOptions = {}, bim: BimContext = viewerBim()) {
  return createMainViewerToolHost(useViewerStore, bim, options);
}

export function call(tool: string, args: Record<string, unknown> = {}, host = viewerHost()): Promise<AgentToolResult> {
  return dispatchMainViewerTool(host, tool, args);
}

export function ok(result: AgentToolResult): AgentToolResult {
  assert.equal(result.isError, false, `${result.errorCode ?? ''} ${result.text}`);
  return result;
}

export function status(result: AgentToolResult): string | undefined {
  return (result.structured as { status?: string } | null)?.status;
}

/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `ifc-lite://model/{id}/materials` — the resource mirror of the
 * `materials_list` tool.
 *
 * `MaterialData.name` only exists for a plain `IfcMaterial` (and, when
 * authored in the source file, a LayerSet/ProfileSet/ConstituentSet). An
 * `IfcMaterialList` never carries a list-level name at all, only
 * `.materials[]`. `MaterialsProvider.read` used to read `mat.name` directly,
 * so any entity whose material resolved to an `IfcMaterialList` — or to an
 * unnamed LayerSet/ProfileSet/ConstituentSet — was silently bucketed under
 * `'(unnamed)'` instead of its real material name(s).
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ToolContext } from '../context.js';
import { DEFAULT_CONFIG, InMemoryModelRegistry, NOOP_PROGRESS, SILENT_LOGGER } from '../context.js';
import { fullScope } from '../auth/scope.js';
import { loadIfcModel } from '../loader.js';
import { buildDefaultResourceRegistry } from './index.js';

/** A 22-character IFC GlobalId from a short mnemonic. */
function guid(mnemonic: string): string {
  return (mnemonic + '0'.repeat(22)).slice(0, 22);
}

// #72's material resolves to an `IfcMaterialList` (two named materials, no
// list-level Name); #73's to a plain `IfcMaterial` (name at the top level) —
// the control. A consumer that only reads `mat.name` sees #72 as unnamed.
const MODEL = `ISO-10303-21;
HEADER;
FILE_DESCRIPTION((''),'2;1');
FILE_NAME('m','2026',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1= IFCPROJECT('${guid('PROJ')}',$,'Proj',$,$,$,$,(#20),#30);
#20= IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-5,#21,$);
#21= IFCAXIS2PLACEMENT3D(#22,$,$);
#22= IFCCARTESIANPOINT((0.,0.,0.));
#30= IFCUNITASSIGNMENT((#31));
#31= IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
#40= IFCLOCALPLACEMENT($,#21);
#41= IFCBUILDINGSTOREY('${guid('STOR')}',$,'L01',$,$,#40,$,$,.ELEMENT.,0.);
#42= IFCBUILDING('${guid('BLDG')}',$,'B',$,$,#40,$,$,.ELEMENT.,$,$,$);
#43= IFCRELAGGREGATES('${guid('AGG1')}',$,$,$,#1,(#42));
#44= IFCRELAGGREGATES('${guid('AGG2')}',$,$,$,#42,(#41));
#72= IFCWALL('${guid('WALL')}',$,'Listed Wall',$,$,#40,$,'tagL',$);
#73= IFCWALL('${guid('WALP')}',$,'Plain Wall',$,$,#40,$,'tagP',$);
#45= IFCRELCONTAINEDINSPATIALSTRUCTURE('${guid('RELC')}',$,$,$,(#72,#73),#41);
#80= IFCMATERIAL('Steel',$,$);
#81= IFCMATERIAL('Concrete',$,$);
#82= IFCMATERIALLIST((#80,#81));
#83= IFCMATERIAL('Timber',$,$);
#90= IFCRELASSOCIATESMATERIAL('${guid('RAM1')}',$,$,$,(#72),#82);
#91= IFCRELASSOCIATESMATERIAL('${guid('RAM2')}',$,$,$,(#73),#83);
ENDSEC;
END-ISO-10303-21;
`;

let tmp: string;
let ctx: ToolContext;

interface MaterialsShape {
  materials: Array<{ name: string; count: number }>;
}

beforeAll(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'ifc-lite-mcp-providers-materials-'));
  await writeFile(join(tmp, 'm.ifc'), MODEL, 'utf-8');
  ctx = {
    registry: new InMemoryModelRegistry(),
    scope: fullScope(),
    progress: NOOP_PROGRESS,
    log: SILENT_LOGGER,
    signal: new AbortController().signal,
    config: { ...DEFAULT_CONFIG, allowedPaths: [tmp] },
  };
  ctx.registry.add(await loadIfcModel(join(tmp, 'm.ifc'), { modelId: 'm' }));
}, 30_000);

afterAll(async () => {
  await rm(tmp, { recursive: true, force: true });
});

describe('ifc-lite://model/{id}/materials', () => {
  it('reports the IfcMaterialList wall under a real material name, not "(unnamed)"', async () => {
    const uri = 'ifc-lite://model/m/materials';
    const provider = buildDefaultResourceRegistry().matchProvider(uri);
    if (!provider) throw new Error('materials resource not registered');
    const contents = await provider.read(uri, ctx);
    const { materials } = JSON.parse((contents[0] as { text: string }).text) as MaterialsShape;
    const names = materials.map((m) => m.name);
    expect(names).not.toContain('(unnamed)');
    // Control: the plain `IfcMaterial` wall must still resolve by its own name.
    expect(names).toContain('Timber');
    // The list-material wall must land under one of its real material names.
    expect(names.some((n) => n === 'Steel' || n === 'Concrete')).toBe(true);
  }, 30_000);
});

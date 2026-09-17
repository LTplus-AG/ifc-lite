/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act, useEffect } from 'react';
import { IfcParser } from '@ifc-lite/parser';
import { useViewerStore } from '@/store/index.js';
import type { FederatedModel } from '@/store/types.js';
import { fixtureModel } from '@/test/store-fixture.js';
import { render, cleanup } from '@/test/render.js';
import { useElementFieldCatalog, type ElementFieldCatalogState } from './useElementFieldCatalog.js';

const model = (nominal: string) => `ISO-10303-21;
HEADER;
FILE_DESCRIPTION((''),'2;1');
FILE_NAME('t','',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPROJECT('0Project0000000000000a',$,'P',$,$,$,$,$,$);
#5=IFCBUILDINGSTOREY('0Storey00000000000005',$,'Level 1',$,$,$,$,$,.ELEMENT.,0.);
#20=IFCCARTESIANPOINT((0.,0.,0.));
#21=IFCDIRECTION((0.,0.,1.));
#22=IFCDIRECTION((1.,0.,0.));
#23=IFCAXIS2PLACEMENT3D(#20,#21,#22);
#24=IFCLOCALPLACEMENT($,#23);
#25=IFCRECTANGLEPROFILEDEF(.AREA.,$,#23,1.,1.);
#26=IFCEXTRUDEDAREASOLID(#25,#23,#21,1.);
#27=IFCSHAPEREPRESENTATION($,'Body','SweptSolid',(#26));
#28=IFCPRODUCTDEFINITIONSHAPE($,$,(#27));
#41=IFCWALL('0Wall00000000000000041',$,'Wall A',$,$,#24,#28,$,$);
#90=IFCRELCONTAINEDINSPATIALSTRUCTURE('0Rel000000000000000090',$,$,$,(#41),#5);
#100=IFCPROPERTYSINGLEVALUE('Value',$,${nominal},$);
#101=IFCPROPERTYSET('0Pset00000000000000101',$,'Probe',$,(#100));
#102=IFCRELDEFINESBYPROPERTIES('0Rel000000000000000102',$,$,$,(#41),#101);
ENDSEC;
END-ISO-10303-21;
`;

async function parsed(id: string, offset: number, nominal: string): Promise<FederatedModel> {
  const bytes = new TextEncoder().encode(model(nominal));
  const store = await new IfcParser().parseColumnar(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  return { ...fixtureModel(id, { idOffset: offset }), name: `${id}.ifc`, ifcDataStore: store, maxExpressId: 102 };
}

function CatalogProbe({ onState }: { onState: (state: ElementFieldCatalogState) => void }) {
  const state = useElementFieldCatalog(true);
  useEffect(() => onState(state), [onState, state]);
  return null;
}

async function discoveredKind(models: FederatedModel[]): Promise<string | undefined> {
  useViewerStore.setState({ models: new Map(models.map((m) => [m.id, m])), activeModelId: models[0].id, mutationViews: new Map(), mutationVersion: 0 });
  let latest: ElementFieldCatalogState | null = null;
  render(<CatalogProbe onState={(state) => { latest = state; }} />);
  for (let i = 0; i < 20 && (latest === null || (latest as ElementFieldCatalogState).loading); i++) {
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 5)); });
  }
  const state = latest as ElementFieldCatalogState | null;
  assert.ok(state && !state.loading, 'discovery finished');
  const kind = state.catalog.properties.get('Probe')?.find(({ binding }) => binding.kind === 'property' && binding.propertyName === 'Value')?.binding.valueKind;
  cleanup();
  return kind;
}

describe('IFC field catalog across a federation (#4833)', () => {
  afterEach(() => cleanup());

  it('infers the same kind for a property that is numeric in one model and text in another, whichever model loaded first', async () => {
    // A bare numeric NominalValue (no IFC measure tag — some exporters write
    // `1.` instead of `IFCREAL(1.)`) carries no dataType to disagree with the
    // label's; only the merged value shapes can tell the two apart.
    const numeric = await parsed('numeric', 0, '1.');
    const text = await parsed('text', 1_000_000, "IFCLABEL('one')");
    // Merged observations have one answer: a field seen as text anywhere is not summable anywhere.
    assert.equal(await discoveredKind([numeric, text]), 'category');
    assert.equal(await discoveredKind([text, numeric]), 'category');
  });
});

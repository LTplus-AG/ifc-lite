/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Shared fixtures for the storey edit tests (#9013). */

import { readFile } from 'node:fs/promises';
import { IfcParser, extractPropertiesOnDemand, type IfcDataStore } from '@ifc-lite/parser';
import { MutablePropertyView, StoreEditor } from '@ifc-lite/mutations';
import { StepExporter } from '@ifc-lite/export';
import { AnchorEntityReader } from '../resolve-anchor.js';
import { placementInAncestor, refId } from '../host-geometry-frame.js';

export interface Session {
  store: IfcDataStore;
  view: MutablePropertyView;
  editor: StoreEditor;
  /** Export the live model (overlay applied). */
  text(schema?: 'IFC4' | 'IFC4X3'): string;
  /** World Z of a product's ObjectPlacement, file units. */
  worldZ(product: number): number;
  snapshot(): unknown;
}

export async function parse(text: string): Promise<IfcDataStore> {
  const bytes = new TextEncoder().encode(text);
  return new IfcParser().parseColumnar(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer, { disableWorkerScan: true });
}

export function session(store: IfcDataStore): Session {
  const view = new MutablePropertyView(null, 'm');
  view.setOnDemandExtractor((id) => extractPropertiesOnDemand(store, id));
  const editor = new StoreEditor(store, view);
  return {
    store, view, editor,
    text: (schema = 'IFC4') => new TextDecoder().decode(new StepExporter(store, view).export({ schema, applyMutations: true, timeStamp: '2026-11-06T00:00:00' }).content),
    worldZ(product) {
      const reader = new AnchorEntityReader(store, view);
      const placement = refId(reader.entity(product)?.attributes[5]);
      if (placement === null) throw new Error(`#${product} has no placement`);
      const frame = placementInAncestor(reader, placement, null);
      if (!frame) throw new Error(`#${product} has an unreadable placement`);
      return frame.o[2];
    },
    snapshot: () => structuredClone({
      entities: [...view.getNewEntities()].sort((a, b) => a.expressId - b.expressId),
      mutations: view.getMutations(),
      changes: view.getEffectiveChanges(),
    }),
  };
}

export async function helloWall(): Promise<IfcDataStore> {
  const bytes = await readFile(new URL('../../../../../apps/viewer/public/samples/hello-wall.ifc', import.meta.url));
  return parse(new TextDecoder().decode(bytes));
}

/**
 * A third-party-shaped model in millimetres: three storeys sharing one origin
 * axis placement (#5), a column on Level 2 placed relative to the BUILDING
 * (#60), a slab on Level 2 hanging from the storey (#70), and a beam that
 * Level 3 contains but that hangs from Level 2's placement (#80).
 */
export const THIRD_PARTY = `ISO-10303-21;
HEADER;FILE_DESCRIPTION((''),'2;1');FILE_NAME('third-party.ifc','2026-11-06T00:00:00',(''),(''),'','','');FILE_SCHEMA(('IFC4'));ENDSEC;
DATA;
#1=IFCPROJECT('0YvctVUKr0kugbFTf53O9L',$,'P',$,$,$,$,(#10),#2);
#2=IFCUNITASSIGNMENT((#3));
#3=IFCSIUNIT(*,.LENGTHUNIT.,.MILLI.,.METRE.);
#4=IFCCARTESIANPOINT((0.,0.,0.));
#5=IFCAXIS2PLACEMENT3D(#4,$,$);
#10=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-05,#5,$);
#11=IFCGEOMETRICREPRESENTATIONSUBCONTEXT('Body','Model',*,*,*,*,#10,$,.MODEL_VIEW.,$);
#12=IFCGEOMETRICREPRESENTATIONSUBCONTEXT('Axis','Model',*,*,*,*,#10,$,.GRAPH_VIEW.,$);
#20=IFCSITE('2VnaJfkC1BuQ6WwOcxNJ6K',$,'Site',$,$,#21,$,$,.ELEMENT.,$,$,$,$,$);
#21=IFCLOCALPLACEMENT($,#5);
#30=IFCBUILDING('0K3P0JJ3v8HhKXCXNoHGbS',$,'Building',$,$,#31,$,$,.ELEMENT.,$,$,$);
#31=IFCLOCALPLACEMENT(#21,#5);
#40=IFCBUILDINGSTOREY('3BXk9GCxj5V9eCELW6qKoB',$,'Level 1',$,$,#41,$,$,.ELEMENT.,0.);
#41=IFCLOCALPLACEMENT(#31,#5);
#42=IFCBUILDINGSTOREY('1UbzJ6LyL7XBk4BdJ_jP0R',$,'Level 2',$,$,#44,$,$,.ELEMENT.,3000.);
#43=IFCCARTESIANPOINT((0.,0.,3000.));
#45=IFCAXIS2PLACEMENT3D(#43,$,$);
#44=IFCLOCALPLACEMENT(#31,#45);
#46=IFCBUILDINGSTOREY('0dwaCbNdz3hA0zHj3Fmq1n',$,'Level 3',$,$,#47,$,$,.ELEMENT.,6000.);
#48=IFCCARTESIANPOINT((0.,0.,6000.));
#49=IFCAXIS2PLACEMENT3D(#48,$,$);
#47=IFCLOCALPLACEMENT(#31,#49);
#50=IFCRELAGGREGATES('1Gm7rvwBn0aOhMnZVa$4c4',$,$,$,#30,(#40,#42,#46));
#51=IFCRELAGGREGATES('3cO5$AHT9DlxAizLOHv3Mx',$,$,$,#20,(#30));
#52=IFCRELAGGREGATES('2hQEJo7gr3_vDVNO4g4dc4',$,$,$,#1,(#20));
#60=IFCCOLUMN('0Oz2e8GZz8RA2h4D8U3fsH',$,'Column',$,$,#61,$,$,$);
#62=IFCCARTESIANPOINT((1000.,0.,3000.));
#63=IFCAXIS2PLACEMENT3D(#62,$,$);
#61=IFCLOCALPLACEMENT(#31,#63);
#70=IFCSLAB('1Kxzq0Z8z0Ywd_1l0uFgFS',$,'Slab',$,$,#71,$,$,$);
#71=IFCLOCALPLACEMENT(#44,#5);
#80=IFCBEAM('2Hh6l7AY56SAGC9IQvMEv6',$,'Beam',$,$,#81,$,$,$);
#82=IFCCARTESIANPOINT((0.,0.,3000.));
#83=IFCAXIS2PLACEMENT3D(#82,$,$);
#81=IFCLOCALPLACEMENT(#44,#83);
#90=IFCRELCONTAINEDINSPATIALSTRUCTURE('2tI3d7B1T4ivX8X0SA4yuM',$,$,$,(#60,#70),#42);
#91=IFCRELCONTAINEDINSPATIALSTRUCTURE('0e4jP7xA51WhwLk6JwGcGJ',$,$,$,(#80),#46);
ENDSEC;
END-ISO-10303-21;
`;

/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The D57 style-assignment flatten through the editor (#7801 round 3): an
 * assignment created in the editor, an edit of a source assignment's
 * `Styles`, and a styled item left with no style, on an IFC2X3 model exported
 * to IFC4X3. The Rust twin is `rust/export/tests/schema_style_flatten_parity.rs`.
 */
import { describe, it, expect } from 'vitest';
import { IfcParser, type IfcDataStore } from '@ifc-lite/parser';
import { MutablePropertyView, StoreEditor } from '@ifc-lite/mutations';
import { StepExporter } from './step-exporter.js';

const SOURCE = `ISO-10303-21;
HEADER;
FILE_DESCRIPTION((''),'2;1');
FILE_NAME('t.ifc','2026-10-17T00:00:00',(''),(''),'','','');
FILE_SCHEMA(('IFC2X3'));
ENDSEC;
DATA;
#1=IFCCARTESIANPOINT((0.,0.,0.));
#3=IFCSURFACESTYLE('s',.BOTH.,());
#4=IFCSURFACESTYLE('t',.BOTH.,());
#5=IFCPRESENTATIONSTYLEASSIGNMENT((#3));
#6=IFCSTYLEDITEM(#1,(#5),$);
#7=IFCPRESENTATIONSTYLEASSIGNMENT((IFCNULLSTYLE(.NULL.)));
#8=IFCSTYLEDITEM(#1,(#7),$);
#9=IFCSTYLEDREPRESENTATION(#10,'Style','Material',(#8,#6));
#10=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-05,#11,$);
#11=IFCAXIS2PLACEMENT3D(#1,$,$);
ENDSEC;
END-ISO-10303-21;`;

async function setup(): Promise<{ store: IfcDataStore; view: MutablePropertyView; editor: StoreEditor }> {
  const bytes = new TextEncoder().encode(SOURCE);
  const store = await new IfcParser().parseColumnar(bytes.buffer.slice(0) as ArrayBuffer);
  const view = new MutablePropertyView(null, 'm');
  return { store, view, editor: new StoreEditor(store, view) };
}

function exportIfc4x3(store: IfcDataStore, view: MutablePropertyView): string[] {
  const out = new TextDecoder().decode(new StepExporter(store, view).export({ schema: 'IFC4X3', applyMutations: true }).content);
  return out.split('\n').filter((l) => l.startsWith('#'));
}

describe('style-assignment flatten through the editor (D57, #7801)', () => {
  it('flattens an assignment and a styled item created in the editor', async () => {
    const { store, view, editor } = await setup();
    const assignment = editor.addEntity('IfcPresentationStyleAssignment', [['#4']]);
    const styled = editor.addEntity('IfcStyledItem', ['#1', [`#${assignment.expressId}`], null]);
    const lines = exportIfc4x3(store, view);
    expect(lines.some((l) => l.includes('IFCPRESENTATIONSTYLEASSIGNMENT'))).toBe(false);
    expect(lines).toContain(`#${styled.expressId}=IFCSTYLEDITEM(#1,(#4),$);`);
  });

  it('flattens to the members an edit of a source assignment set', async () => {
    const { store, view } = await setup();
    view.setPositionalAttribute(5, 0, ['#4']);
    const lines = exportIfc4x3(store, view);
    expect(lines).toContain('#6=IFCSTYLEDITEM(#1,(#4),$);');
  });

  it('drops a styled item left with no style, and the reference to it', async () => {
    const { store, view } = await setup();
    const lines = exportIfc4x3(store, view);
    expect(lines.some((l) => l.startsWith('#8='))).toBe(false);
    expect(lines).toContain("#9=IFCSTYLEDREPRESENTATION(#10,'Style','Material',(#6));");
    expect(lines).toContain('#6=IFCSTYLEDITEM(#1,(#3),$);');
  });

  it('an edit that fills a null-only source assignment keeps its styled item', async () => {
    const { store, view } = await setup();
    view.setPositionalAttribute(7, 0, ['#4']);
    const lines = exportIfc4x3(store, view);
    expect(lines).toContain('#8=IFCSTYLEDITEM(#1,(#4),$);');
    expect(lines).toContain("#9=IFCSTYLEDREPRESENTATION(#10,'Style','Material',(#8,#6));");
  });
});

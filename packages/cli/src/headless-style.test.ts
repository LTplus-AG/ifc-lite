/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `bim.style` end to end: colour written as real presentation-style entities,
 * asserted on the exported STEP.
 *
 * The fixture carries the three shapes that make this more than a one-liner —
 * direct geometry, two occurrences sharing one mapped representation, and a
 * product with no representation at all — plus geometry that already has a
 * style, which IFC allows only one of per item.
 */

import { describe, expect, it } from 'vitest';
import { exportStep, ifcFile, loadInlineModel, styledTargets } from './headless-test-helpers.js';

const WALL_SOLID = 61;
const MAPPED_SOLID = 80;
const T1_MAPPED_ITEM = 84;

const MODEL = ifcFile(`#60= IFCRECTANGLEPROFILEDEF(.AREA.,$,#21,2.,0.2);
#61= IFCEXTRUDEDAREASOLID(#60,#21,#62,3.);
#62= IFCDIRECTION((0.,0.,1.));
#63= IFCSHAPEREPRESENTATION(#20,'Body','SweptSolid',(#61));
#64= IFCPRODUCTDEFINITIONSHAPE($,$,(#63));
#70= IFCWALL('WALL00000000000000000X',$,'A Wall',$,$,$,#64,'tag',$);
#80= IFCEXTRUDEDAREASOLID(#60,#21,#62,1.);
#81= IFCSHAPEREPRESENTATION(#20,'Body','SweptSolid',(#80));
#82= IFCREPRESENTATIONMAP(#21,#81);
#83= IFCCARTESIANTRANSFORMATIONOPERATOR3D($,$,#22,$,$);
#84= IFCMAPPEDITEM(#82,#83);
#85= IFCSHAPEREPRESENTATION(#20,'Body','MappedRepresentation',(#84));
#86= IFCPRODUCTDEFINITIONSHAPE($,$,(#85));
#87= IFCMAPPEDITEM(#82,#83);
#88= IFCSHAPEREPRESENTATION(#20,'Body','MappedRepresentation',(#87));
#89= IFCPRODUCTDEFINITIONSHAPE($,$,(#88));
#90= IFCAIRTERMINAL('AIR100000000000000000X',$,'T1',$,$,$,#86,'t1',.DIFFUSER.);
#91= IFCAIRTERMINAL('AIR200000000000000000X',$,'T2',$,$,$,#89,'t2',.DIFFUSER.);
#92= IFCAIRTERMINAL('AIR300000000000000000X',$,'T3',$,$,$,$,'t3',.DIFFUSER.);
#93= IFCCOLOURRGB($,1.,0.,0.);
#94= IFCSURFACESTYLESHADING(#93,0.);
#95= IFCSURFACESTYLE('Old Red',.BOTH.,(#94));
#96= IFCSTYLEDITEM(#61,(#95),$);`);

const loadModel = () => loadInlineModel(MODEL, 'style');

describe('bim.style.apply', () => {
  it('writes the colour into the exported file, not just the view', async () => {
    const bim = await loadModel();
    const wall = bim.query().byType('IfcWall').refs();
    const result = bim.style.apply(wall, '#9caec9', { name: 'IfcWall' });

    const step = exportStep(bim);
    expect(result.styledItemIds).toHaveLength(1);
    expect(step).toContain("IFCSURFACESTYLE('IfcWall'");
    expect(styledTargets(step)).toContain(WALL_SOLID);
    // #9c/#ae/#c9 as 0..1 reals.
    expect(step).toMatch(/IFCCOLOURRGB\(\$,0\.61\d*,0\.68\d*,0\.78\d*\)/);
  });

  it('accepts channels in 0..1 and writes alpha as transparency', async () => {
    const bim = await loadModel();
    bim.style.apply(bim.query().byType('IfcWall').refs(), { red: 1, green: 0, blue: 0, alpha: 0.25 });
    expect(exportStep(bim)).toMatch(/IFCSURFACESTYLESHADING\(#\d+,0\.75\)/);
  });

  it('rounds transparency instead of writing a binary-float tail', async () => {
    // 1 - 0.9 is 0.09999999999999998 in IEEE 754, and that lands verbatim in
    // the STEP text without rounding.
    const bim = await loadModel();
    bim.style.apply(bim.query().byType('IfcWall').refs(), { red: 1, green: 0, blue: 0, alpha: 0.9 });
    expect(exportStep(bim)).toMatch(/IFCSURFACESTYLESHADING\(#\d+,0\.1\)/);
  });

  it('honours the alpha pair of an #rrggbbaa string', async () => {
    // hexToRgba discards those digits and takes alpha from its own argument,
    // which is right for the viewer and wrong here: for a caller using the
    // string form they are the only way to ask for transparency, and silently
    // dropping them wrote an opaque style.
    const bim = await loadModel();
    bim.style.apply(bim.query().byType('IfcWall').refs(), '#ff000080');
    expect(exportStep(bim)).toMatch(/IFCSURFACESTYLESHADING\(#\d+,0\.498\d*\)/);
  });

  it('accepts every hex form bim.viewer.colorize accepts', async () => {
    // The two colour entry points are documented as counterparts, so a string
    // that paints in the viewer must not throw here.
    const bim = await loadModel();
    const wall = bim.query().byType('IfcWall').refs();
    for (const form of ['#f00', 'ff0000', '#FF0000', '#ff000080']) {
      expect(() => bim.style.apply(wall, form)).not.toThrow();
    }
  });

  it('leaves no orphan chain when a second call recolours the same geometry', async () => {
    // The colour-then-recolour flow, across two calls rather than two batches.
    // Bookkeeping kept during one pass cannot reach this: by the second call
    // the first call's tombstone set is long gone. The sweep keys on whether
    // anything still references the style instead.
    const bim = await loadModel();
    const wall = bim.query().byType('IfcWall').refs();
    bim.style.apply(wall, '#ff0000', { name: 'CallOne' });
    bim.style.apply(wall, '#00ff00', { name: 'CallTwo' });

    const step = exportStep(bim);
    expect(step).not.toContain("'CallOne'");
    expect(step).toContain("'CallTwo'");
    expect(styledTargets(step).filter(id => id === WALL_SOLID)).toHaveLength(1);
    // The first call's own returned result is not revisited — it was handed
    // back before this call existed. See ApplyStyleResult.
  });

  it('does not stack a second IfcStyledItem when applied twice', async () => {
    // The one-style-per-item rule has to hold against geometry this session
    // already styled, not only against what the source file carried. The index
    // of existing styles is built from the source, and addEntity does not
    // insert into it, so a source-only check cannot see the first call.
    const bim = await loadModel();
    bim.style.apply(bim.query().byType('IfcAirTerminal').refs(), '#ff0000');
    const second = bim.style.apply(bim.query().byType('IfcAirTerminal').refs(), '#00ff00');

    expect(second.replacedStyledItemIds).toHaveLength(1);
    expect(styledTargets(exportStep(bim)).filter(id => id === MAPPED_SOLID)).toHaveLength(1);
  });

  it('styles shared mapped geometry once, not once per occurrence', async () => {
    const bim = await loadModel();
    const terminals = bim.query().byType('IfcAirTerminal').refs();
    const result = bim.style.apply(terminals, '#c9a96e');

    // Two occurrences point at one IfcRepresentationMap. Styling the mapped
    // item twice would be a second IfcStyledItem on the same geometry, which
    // IFC does not allow.
    expect(result.styledItemIds).toHaveLength(1);
    expect(styledTargets(exportStep(bim))).toContain(MAPPED_SOLID);
  });

  it('styles one occurrence at a time when told not to follow mapped items', async () => {
    // Following IfcMappedItem is right for colouring by IFC class and wrong for
    // every other grouping: by system or storey, the shared geometry takes
    // whichever colour ran last and drags unrelated occurrences with it.
    const bim = await loadModel();
    const [t1] = bim.query().byType('IfcAirTerminal').toArray()
      .filter(t => t.name === 'T1')
      .map(t => t.ref);

    const shared = bim.style.apply([t1], '#ff0000');
    expect(shared.styledItemIds).toHaveLength(1);
    expect(styledTargets(exportStep(bim))).toContain(MAPPED_SOLID);

    const perOccurrence = await loadModel();
    const [only] = perOccurrence.query().byType('IfcAirTerminal').toArray()
      .filter(t => t.name === 'T1')
      .map(t => t.ref);
    perOccurrence.style.apply([only], '#ff0000', { followMappedItems: false });

    // The IfcMappedItem itself, not the solid every occurrence shares.
    const targets = styledTargets(exportStep(perOccurrence));
    expect(targets).not.toContain(MAPPED_SOLID);
    expect(targets).toContain(T1_MAPPED_ITEM);
  });

  it('reports the product that has no geometry, and only that one', async () => {
    const bim = await loadModel();
    const terminals = bim.query().byType('IfcAirTerminal').toArray();
    const noGeometry = terminals.find(t => t.name === 'T3');
    const result = bim.style.apply(terminals.map(t => t.ref), '#c9a96e');

    // The other two share one mapped representation. Deciding this by asking
    // whether the collected set grew would call the second occurrence
    // geometry-less, which is most occurrences in a real model.
    expect(result.productsWithoutGeometry).toEqual([noGeometry?.ref.expressId]);
  });

  it('replaces a style the geometry already carries', async () => {
    const bim = await loadModel();
    const result = bim.style.apply(bim.query().byType('IfcWall').refs(), '#9caec9');

    const step = exportStep(bim);
    expect(result.replacedStyledItemIds).toEqual([96]);
    // Exactly one style on that solid, not two: IFC allows at most one
    // IfcStyledItem per representation item, so this is correctness, not tidiness.
    expect(styledTargets(step).filter(id => id === WALL_SOLID)).toHaveLength(1);
    expect(step).toContain("IFCSURFACESTYLE($,");

    // The detached IfcSurfaceStyle is left in the file. It no longer applies to
    // anything, and removing it is not safe in general: a style can be shared
    // by styled items this call never touched. An unreferenced style definition
    // is valid IFC.
    expect(step).toContain("'Old Red'");
  });

  it('leaves an already-styled item alone when asked to', async () => {
    const bim = await loadModel();
    const result = bim.style.apply(
      bim.query().byType('IfcWall').refs(), '#9caec9', { replaceExisting: false },
    );

    expect(result.styledItemIds).toEqual([]);
    expect(result.keptExistingItemIds).toEqual([WALL_SOLID]);
    expect(exportStep(bim)).toContain("'Old Red'");
  });

  it('writes no colour chain at all for a batch that styles nothing', async () => {
    // A caller colouring by IFC class hands in a batch per class, and most
    // classes in a real model (types, ports, spatial structure) reach no
    // geometry. Emitting the style up front left one orphan IfcColourRgb /
    // IfcSurfaceStyleShading / IfcSurfaceStyle in the file per such batch.
    const bim = await loadModel();
    const before = (exportStep(bim).match(/IFCSURFACESTYLE\(/g) ?? []).length;

    const result = bim.style.apply(bim.query().byType('IfcProject').refs(), '#123456', {
      name: 'Nothing',
    });

    expect(result.surfaceStyleId).toBeNull();
    expect(result.styledItemIds).toEqual([]);
    const step = exportStep(bim);
    expect((step.match(/IFCSURFACESTYLE\(/g) ?? []).length).toBe(before);
    expect(step).not.toContain("'Nothing'");
  });

  it('rejects a colour string that is not a hex triple', async () => {
    const bim = await loadModel();
    const wall = bim.query().byType('IfcWall').refs();
    expect(() => bim.style.apply(wall, 'cornflowerblue')).toThrow(/not a hex colour/);
  });
});

describe('bim.style alongside hand-authored overlay entities', () => {
  const addStyleChain = (bim: Awaited<ReturnType<typeof loadModel>>, name: string) => {
    const add = (type: string, attributes: unknown[]) =>
      bim.store.addEntity('default', { type, attributes } as never);
    const colour = add('IfcColourRgb', [null, { real: 1 }, { real: 0 }, { real: 0 }]);
    const shading = add('IfcSurfaceStyleShading', [`#${colour.expressId}`, { real: 0 }]);
    return add('IfcSurfaceStyle', [name, '.BOTH.', [`#${shading.expressId}`]]);
  };

  it('does not collect a style the caller authored and has not attached yet', async () => {
    // Deciding what is garbage by scanning the overlay swept anything with no
    // styled item pointing at it, including a chain the caller was still
    // assembling. Only chains this module authored are its to remove.
    const bim = await loadModel();
    const mine = addStyleChain(bim, 'HandAuthored');

    bim.style.apply(bim.query().byType('IfcWall').refs(), '#00ff00');
    expect(exportStep(bim)).toMatch(new RegExp(`^#${mine.expressId}=`, 'm'));
  });

  it('writes no dangling style reference after a styled item is repointed', async () => {
    // getNewEntities reports attributes as created, while the exporter applies
    // setPositionalAttribute on top. Reading the former to decide what is still
    // referenced made the two disagree: a live style was removed and the file
    // kept an unresolvable reference.
    const bim = await loadModel();
    const mine = addStyleChain(bim, 'HandAuthored');
    const first = bim.style.apply(bim.query().byType('IfcWall').refs(), '#0000ff');

    bim.store.setPositionalAttribute(
      { modelId: 'default', expressId: first.styledItemIds[0] }, 1, [`#${mine.expressId}`],
    );
    bim.style.apply(bim.query().byType('IfcAirTerminal').refs(), '#ffff00');

    const step = exportStep(bim);
    const referenced = [...step.matchAll(/IFCSTYLEDITEM\(#\d+,\(#(\d+)\)/g)].map(m => m[1]);
    const dangling = referenced.filter(id => !new RegExp(`^#${id}=`, 'm').test(step));
    expect(dangling).toEqual([]);
  });
});

describe('bim.style schema target', () => {
  it('builds the chain for the schema the file will be written as', async () => {
    // The style shape is decided when the style is authored, and the export
    // schema is chosen later. IFC2X3 needs IfcStyledItem.Styles to hold
    // IfcPresentationStyleAssignment; IFC4 takes the IfcSurfaceStyle directly
    // and IFC4X3 removed the wrapper. Without a target, an IFC4 source exported
    // as IFC2X3 wrote records invalid for the file they landed in.
    const bim = await loadModel();
    bim.style.apply(bim.query().byType('IfcWall').refs(), '#9caec9', { schema: 'IFC2X3' });

    const step = exportStep(bim, 'IFC2X3');
    expect(step).toContain('IFCPRESENTATIONSTYLEASSIGNMENT(');
  });

  it('follows the source schema when no target is given', async () => {
    const bim = await loadModel();
    bim.style.apply(bim.query().byType('IfcWall').refs(), '#9caec9');
    expect(exportStep(bim)).not.toContain('IFCPRESENTATIONSTYLEASSIGNMENT(');
  });
});

describe('bim.style.applyAll', () => {
  it('lets a later batch win over an earlier one on the same geometry', async () => {
    const bim = await loadModel();
    const wall = bim.query().byType('IfcWall').refs();
    const [, second] = bim.style.applyAll([
      { refs: wall, color: '#111111', name: 'First' },
      { refs: wall, color: '#222222', name: 'Second' },
    ]);

    expect(second.replacedStyledItemIds).toHaveLength(1);
    expect(styledTargets(exportStep(bim)).filter(id => id === WALL_SOLID)).toHaveLength(1);
  });

  it('leaves no orphan chain when a later batch takes every item of an earlier one', async () => {
    // The empty-batch check covers a batch that styles nothing up front. This
    // is one step further along: batch 1 styles, batch 2 replaces all of it,
    // and batch 1's colour chain is left in the file referenced by nothing —
    // while its result still names styled items that were tombstoned.
    const bim = await loadModel();
    const wall = bim.query().byType('IfcWall').refs();
    const [first, second] = bim.style.applyAll([
      { refs: wall, color: '#ff0000', name: 'Loser' },
      { refs: wall, color: '#00ff00', name: 'Winner' },
    ]);

    const step = exportStep(bim);
    expect(first.styledItemIds).toEqual([]);
    expect(first.surfaceStyleId).toBeNull();
    expect(step).not.toContain("'Loser'");
    expect(step).toContain("'Winner'");
    expect(second.styledItemIds).toHaveLength(1);
  });

  it('gives each batch its own style and names them', async () => {
    const bim = await loadModel();
    const results = bim.style.applyAll([
      { refs: bim.query().byType('IfcWall').refs(), color: '#9caec9', name: 'IfcWall' },
      { refs: bim.query().byType('IfcAirTerminal').refs(), color: '#c9a96e', name: 'IfcAirTerminal' },
    ]);

    const step = exportStep(bim);
    expect(results.map(r => r.styledItemIds.length)).toEqual([1, 1]);
    expect(step).toContain("IFCSURFACESTYLE('IfcWall'");
    expect(step).toContain("IFCSURFACESTYLE('IfcAirTerminal'");
  });
});

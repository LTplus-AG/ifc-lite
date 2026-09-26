/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #5794: an `IfcPropertySet` shared by several elements through ONE
 * `IfcRelDefinesByProperties`, edited on one element.
 *
 * The viewer edits one element's properties, so the export copies on write:
 * the edited element gets its own `IfcPropertySet` plus its own relation, it
 * leaves the shared relation's `RelatedObjects`, and every other element keeps
 * the original set untouched. It used to withhold the shared relation and set
 * wholesale, so every other element silently lost the set; and the regenerated
 * copy flattened list/enumerated/bounded/table/complex/reference members to
 * `IFCPROPERTYSINGLEVALUE` text.
 *
 * Every assertion reads the export back through the real parser.
 */

import { describe, expect, it } from 'vitest';
import { IfcParser, extractPropertiesOnDemand, type IfcDataStore } from '@ifc-lite/parser';
import { PropertyValueType, QuantityType } from '@ifc-lite/data';
import { MutablePropertyView } from '@ifc-lite/mutations';
import { StepExporter } from './step-exporter.js';
import { MergedExporter } from './merged-exporter.js';

const SHARED_GUID = '3wkd_mjInDCfOthy7w_A60';
const WALL_A = 20;
const WALL_B = 21;
const WALL_C = 22;

const SHARED_PSET_IFC = `ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('ViewDefinition [DesignTransferView]'),'2;1');
FILE_NAME('shared-pset.ifc','2026-09-25T00:00:00',(''),(''),'test','test','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPROJECT('0YvctVUKr0kugbFTf53O9L',$,'P',$,$,$,$,$,#9);
#9=IFCUNITASSIGNMENT((#10));
#10=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
#20=IFCWALL('2Z2BGIG3j5fRzbeoRb82L1',$,'Wall A',$,$,$,$,$,$);
#21=IFCWALL('2Z2BGIG3j5fRzbeoRb82L2',$,'Wall B',$,$,$,$,$,$);
#22=IFCWALL('2Z2BGIG3j5fRzbeoRb82L3',$,'Wall C',$,$,$,$,$,$);
#30=IFCPROPERTYSINGLEVALUE('B1',$,IFCLABEL('b1'),$);
#31=IFCPROPERTYLISTVALUE('Layers',$,(IFCLABEL('p'),IFCLABEL('q')),$);
#32=IFCPROPERTYENUMERATION('FireClassEnum',(IFCLABEL('A'),IFCLABEL('B')),$);
#33=IFCPROPERTYENUMERATEDVALUE('FireClass',$,(IFCLABEL('A')),#32);
#34=IFCPROPERTYBOUNDEDVALUE('Range',$,IFCREAL(2.),IFCREAL(1.),$,$);
#35=IFCPROPERTYTABLEVALUE('Curve',$,(IFCREAL(1.),IFCREAL(2.)),(IFCREAL(10.),IFCREAL(20.)),$,$,$,$);
#36=IFCPROPERTYSINGLEVALUE('C1',$,IFCLABEL('c1'),$);
#37=IFCCOMPLEXPROPERTY('Nested',$,'Usage',(#36));
#38=IFCPROPERTYREFERENCEVALUE('Doc',$,$,#39);
#39=IFCDOCUMENTREFERENCE('http://example.org/spec',$,'Spec',$,$);
#40=IFCPROPERTYSET('${SHARED_GUID}',$,'Custom_B',$,(#30,#31,#33,#34,#35,#37,#38));
#41=IFCRELDEFINESBYPROPERTIES('0x8Q_7Can5hOwBoiPhy1M1',$,$,$,(#20,#21,#22),#40);
ENDSEC;
END-ISO-10303-21;`;

/** Member name → IFC class the source file declares it as. */
const SOURCE_KINDS: Record<string, string> = {
  B1: 'IFCPROPERTYSINGLEVALUE',
  Layers: 'IFCPROPERTYLISTVALUE',
  FireClass: 'IFCPROPERTYENUMERATEDVALUE',
  Range: 'IFCPROPERTYBOUNDEDVALUE',
  Curve: 'IFCPROPERTYTABLEVALUE',
  Nested: 'IFCCOMPLEXPROPERTY',
  Doc: 'IFCPROPERTYREFERENCEVALUE',
};

async function parse(text: string): Promise<IfcDataStore> {
  return new IfcParser().parseColumnar(new TextEncoder().encode(text).buffer);
}

function liveView(store: IfcDataStore): MutablePropertyView {
  const view = new MutablePropertyView(null, 'test-model');
  view.setOnDemandExtractor((id: number) => extractPropertiesOnDemand(store, id));
  return view;
}

async function exportEdited(
  edit: (view: MutablePropertyView) => void,
  source = SHARED_PSET_IFC,
  hiddenEntityIds?: Set<number>,
): Promise<{ text: string; store: IfcDataStore }> {
  const store = await parse(source);
  const view = liveView(store);
  edit(view);
  const visibility = hiddenEntityIds ? { visibleOnly: true, hiddenEntityIds } : {};
  const result = new StepExporter(store, view).export({ schema: 'IFC4', applyMutations: true, ...visibility });
  const text = new TextDecoder().decode(result.content);
  return { text, store: await parse(text) };
}

/** `#id` → `{ type, args }` for every DATA line of an exported file. */
function records(text: string): Map<number, { type: string; args: string }> {
  const out = new Map<number, { type: string; args: string }>();
  for (const m of text.matchAll(/^#(\d+)=([A-Z0-9]+)\((.*)\);$/gm)) {
    out.set(Number(m[1]), { type: m[2], args: m[3] });
  }
  return out;
}

const refs = (s: string): number[] => [...s.matchAll(/#(\d+)/g)].map((m) => Number(m[1]));

/**
 * The `Custom_B` sets an element is related to in the exported file, each with
 * its GlobalId and member name → member IFC class, resolved through the
 * re-parsed file's `IfcRelDefinesByProperties`.
 */
function customBSets(text: string, elementId: number): Array<{ guid: string; kinds: Record<string, string> }> {
  const recs = records(text);
  const sets: Array<{ guid: string; kinds: Record<string, string> }> = [];
  for (const rec of recs.values()) {
    if (rec.type !== 'IFCRELDEFINESBYPROPERTIES') continue;
    const related = rec.args.match(/\(([^()]*)\)\s*,\s*#(\d+)\s*$/);
    if (!related || !refs(related[1]).includes(elementId)) continue;
    const pset = recs.get(Number(related[2]));
    if (!pset || pset.type !== 'IFCPROPERTYSET') continue;
    const head = pset.args.match(/^'([^']*)',[^,]*,'([^']*)'/);
    if (!head || head[2] !== 'Custom_B') continue;
    const members = refs(pset.args.slice(pset.args.lastIndexOf('(')));
    const kinds: Record<string, string> = {};
    for (const id of members) {
      const member = recs.get(id);
      expect(member, `member #${id} of the set has a defining line`).toBeDefined();
      const name = member!.args.match(/^'([^']*)'/)?.[1] ?? '';
      kinds[name] = member!.type;
    }
    sets.push({ guid: head[1], kinds });
  }
  return sets;
}

/** Property values as the real parser reads them back. */
function customBValues(store: IfcDataStore, elementId: number): Record<string, unknown> {
  const psets = extractPropertiesOnDemand(store, elementId).filter((p) => p.name === 'Custom_B');
  expect(psets).toHaveLength(1);
  return Object.fromEntries(psets[0].properties.map((p) => [p.name, p.value]));
}

describe('shared IfcPropertySet copy-on-write export (#5794)', () => {
  it('adding a property on one element keeps the shared set on the others', async () => {
    const { text, store } = await exportEdited((view) => {
      view.setProperty(WALL_A, 'Custom_B', 'B5', 'b5', PropertyValueType.Label);
    });

    // The untouched elements keep the ORIGINAL set: same GlobalId, same
    // members, same member classes, and no B5.
    for (const other of [WALL_B, WALL_C]) {
      expect(customBSets(text, other)).toEqual([{ guid: SHARED_GUID, kinds: SOURCE_KINDS }]);
      expect(customBValues(store, other)).not.toHaveProperty('B5');
    }

    // The edited element has exactly one Custom_B: its own copy, with every
    // source member at its source class, plus the added single value.
    const [copy, ...extra] = customBSets(text, WALL_A);
    expect(extra).toEqual([]);
    expect(copy.guid).not.toBe(SHARED_GUID);
    expect(copy.kinds).toEqual({ ...SOURCE_KINDS, B5: 'IFCPROPERTYSINGLEVALUE' });
    expect(customBValues(store, WALL_A)).toMatchObject({ B1: 'b1', B5: 'b5' });

    // The shared relation now names only the elements that still share it.
    const shared = records(text).get(41);
    expect(shared?.type).toBe('IFCRELDEFINESBYPROPERTIES');
    expect(refs(shared!.args.match(/\(([^()]*)\)\s*,\s*#40\s*$/)![1])).toEqual([WALL_B, WALL_C]);
  });

  it('editing an existing member changes it for the edited element only', async () => {
    const { text, store } = await exportEdited((view) => {
      view.setProperty(WALL_B, 'Custom_B', 'B1', 'edited', PropertyValueType.Label);
    });

    expect(customBValues(store, WALL_B)).toMatchObject({ B1: 'edited' });
    for (const other of [WALL_A, WALL_C]) {
      expect(customBValues(store, other)).toMatchObject({ B1: 'b1' });
      expect(customBSets(text, other)).toEqual([{ guid: SHARED_GUID, kinds: SOURCE_KINDS }]);
    }
    const [copy, ...extra] = customBSets(text, WALL_B);
    expect(extra).toEqual([]);
    expect(copy.kinds).toEqual(SOURCE_KINDS);
  });

  it('list values read back as lists, not joined text', async () => {
    const { store } = await exportEdited((view) => {
      view.setProperty(WALL_A, 'Custom_B', 'B5', 'b5', PropertyValueType.Label);
    });
    const layers = extractPropertiesOnDemand(store, WALL_A)
      .find((p) => p.name === 'Custom_B')!
      .properties.find((p) => p.name === 'Layers');
    expect(layers?.structure).toBe('list');
    expect(layers?.values).toEqual(['p', 'q']);
  });

  it('deleting the set on one element keeps it on the others', async () => {
    const { text } = await exportEdited((view) => {
      view.deletePropertySet(WALL_C, 'Custom_B');
    });
    expect(customBSets(text, WALL_C)).toEqual([]);
    for (const other of [WALL_A, WALL_B]) {
      expect(customBSets(text, other)).toEqual([{ guid: SHARED_GUID, kinds: SOURCE_KINDS }]);
    }
  });

  it('editing every sharer gives each its own copy and drops the emptied relation', async () => {
    const { text, store } = await exportEdited((view) => {
      for (const id of [WALL_A, WALL_B, WALL_C]) {
        view.setProperty(id, 'Custom_B', 'B1', `own-${id}`, PropertyValueType.Label);
      }
    });
    const recs = records(text);
    // Nothing names the original set any more, so neither it nor its relation
    // is written; no relation is left with an empty RelatedObjects.
    expect(recs.has(41)).toBe(false);
    expect(recs.has(40)).toBe(false);
    const guids = new Set<string>();
    for (const id of [WALL_A, WALL_B, WALL_C]) {
      const [copy, ...extra] = customBSets(text, id);
      expect(extra).toEqual([]);
      expect(copy.kinds).toEqual(SOURCE_KINDS);
      guids.add(copy.guid);
      expect(customBValues(store, id)).toMatchObject({ B1: `own-${id}` });
    }
    expect(guids.size).toBe(3);
  });

  it('an unshared set keeps its member classes when regenerated', async () => {
    const unshared = SHARED_PSET_IFC.replace('(#20,#21,#22),#40', '(#20),#40');
    const { text } = await exportEdited((view) => {
      view.setProperty(WALL_A, 'Custom_B', 'B1', 'edited', PropertyValueType.Label);
    }, unshared);
    const [copy, ...extra] = customBSets(text, WALL_A);
    expect(extra).toEqual([]);
    expect(copy.kinds).toEqual(SOURCE_KINDS);
    expect(customBSets(text, WALL_B)).toEqual([]);
  });

  it('a shared IfcElementQuantity edited on one element stays on the others', async () => {
    const withQset = SHARED_PSET_IFC.replace('ENDSEC;\nEND-ISO', [
      "#50=IFCQUANTITYLENGTH('Length',$,$,5.,$);",
      "#51=IFCELEMENTQUANTITY('1yqM3I0Wn6ah7BCQg6Cf_U',$,'Qto_Test',$,$,(#50));",
      "#52=IFCRELDEFINESBYPROPERTIES('0x8Q_7Can5hOwBoiPhy1M2',$,$,$,(#20,#21),#51);",
      'ENDSEC;\nEND-ISO',
    ].join('\n'));
    const { text } = await exportEdited((view) => {
      view.setQuantity(WALL_A, 'Qto_Test', 'Length', 7, QuantityType.Length);
    }, withQset);
    const recs = records(text);
    expect(recs.get(51)?.type).toBe('IFCELEMENTQUANTITY');
    expect(recs.get(52)?.args).toMatch(/\(#21\),#51$/);
    const own = [...recs.values()].filter((r) => r.type === 'IFCRELDEFINESBYPROPERTIES' && /\(#20\),#\d+$/.test(r.args));
    const ownSets = own.map((r) => recs.get(refs(r.args).at(-1)!)).filter((r) => r?.type === 'IFCELEMENTQUANTITY');
    expect(ownSets).toHaveLength(1);
  });

  it('a set two type objects own is kept for the type that was not edited', async () => {
    const typeOwned = SHARED_PSET_IFC
      .replace("#41=IFCRELDEFINESBYPROPERTIES('0x8Q_7Can5hOwBoiPhy1M1',$,$,$,(#20,#21,#22),#40);\n", '')
      .replace('ENDSEC;\nEND-ISO', [
        "#60=IFCWALLTYPE('02noD_fgv7DRHMvfv0SV01',$,'T1',$,$,(#40),$,$,$,.SOLIDWALL.);",
        "#61=IFCWALLTYPE('02noD_fgv7DRHMvfv0SV02',$,'T2',$,$,(#40),$,$,$,.SOLIDWALL.);",
        'ENDSEC;\nEND-ISO',
      ].join('\n'));
    const { text } = await exportEdited((view) => {
      view.setProperty(60, 'Custom_B', 'B1', 'edited', PropertyValueType.Label);
    }, typeOwned);
    const recs = records(text);
    // T2 still names #40, so #40 and every member it lists must be written.
    expect(recs.get(61)?.args).toContain('(#40)');
    expect(recs.get(40)?.type).toBe('IFCPROPERTYSET');
    for (const id of refs(recs.get(40)!.args.slice(recs.get(40)!.args.lastIndexOf('(')))) {
      expect(recs.has(id), `member #${id}`).toBe(true);
    }
    // T1 got its own set in place of #40.
    const t1Sets = refs(recs.get(60)!.args.match(/\(([^()]*)\),\$,\$,\$/)![1]);
    expect(t1Sets).toHaveLength(1);
    expect(t1Sets[0]).not.toBe(40);
    expect(recs.get(t1Sets[0])?.type).toBe('IFCPROPERTYSET');
  });

  it('two same-named sets on one element never borrow each other\'s members', async () => {
    // Review finding on #6012: reuse is keyed by set name, so a second,
    // distinct `Custom_B` must not resolve its `B1` to the first set's atom.
    const twoSets = SHARED_PSET_IFC.replace('ENDSEC;\nEND-ISO', [
      "#70=IFCPROPERTYSINGLEVALUE('B1',$,IFCLABEL('second'),$);",
      "#71=IFCPROPERTYSET('1yqM3I0Wn6ah7BCQg6Cf_V',$,'Custom_B',$,(#70));",
      "#72=IFCRELDEFINESBYPROPERTIES('0x8Q_7Can5hOwBoiPhy1M3',$,$,$,(#20),#71);",
      'ENDSEC;\nEND-ISO',
    ].join('\n'));
    const { text, store } = await exportEdited((view) => {
      view.setProperty(WALL_A, 'Custom_B', 'B5', 'b5', PropertyValueType.Label);
    }, twoSets);
    const b1 = extractPropertiesOnDemand(store, WALL_A)
      .filter((p) => p.name === 'Custom_B')
      .flatMap((p) => p.properties.filter((q) => q.name === 'B1').map((q) => q.value))
      .sort();
    expect(b1).toEqual(['b1', 'second']);
    expect(customBSets(text, WALL_B)).toEqual([{ guid: SHARED_GUID, kinds: SOURCE_KINDS }]);
  });

  it('with every other sharer hidden, visibleOnly writes no orphan of the shared set', async () => {
    // Review finding on #6012: hidden sharers are not deleted, but the export
    // does not write them, so they must not keep the shared set alive — the
    // relation would be filtered to nobody and #40 shipped as an orphan
    // carrying the hidden elements' data.
    const { text } = await exportEdited((view) => {
      view.setProperty(WALL_A, 'Custom_B', 'B1', 'edited', PropertyValueType.Label);
    }, SHARED_PSET_IFC, new Set([WALL_B, WALL_C]));
    const recs = records(text);
    expect(recs.has(WALL_B) || recs.has(WALL_C)).toBe(false);
    expect(recs.has(41)).toBe(false);
    expect(recs.has(40)).toBe(false);
    const [copy, ...extra] = customBSets(text, WALL_A);
    expect(extra).toEqual([]);
    expect(copy.kinds).toEqual(SOURCE_KINDS);
    // Every IfcPropertySet in the file is related to something.
    const relatedSets = new Set(
      [...recs.values()].filter((r) => r.type === 'IFCRELDEFINESBYPROPERTIES').map((r) => refs(r.args).at(-1)),
    );
    for (const [id, rec] of recs) {
      if (rec.type === 'IFCPROPERTYSET') expect(relatedSets.has(id), `#${id} is related`).toBe(true);
    }
  });

  it('with one other sharer still visible, visibleOnly keeps the shared set for it', async () => {
    const { text } = await exportEdited((view) => {
      view.setProperty(WALL_A, 'Custom_B', 'B1', 'edited', PropertyValueType.Label);
    }, SHARED_PSET_IFC, new Set([WALL_C]));
    expect(refs(records(text).get(41)!.args.match(/\(([^()]*)\)\s*,\s*#40\s*$/)![1])).toEqual([WALL_B]);
    expect(customBSets(text, WALL_B)).toEqual([{ guid: SHARED_GUID, kinds: SOURCE_KINDS }]);
  });

  it('federated (merged) export gets the same copy-on-write', async () => {
    // Review finding on #6012: `MergedExporter` bakes each model's edits
    // through `StepExporter` (`bakeMutatedModels`), so it must inherit the fix.
    const store = await parse(SHARED_PSET_IFC);
    const view = liveView(store);
    view.setProperty(WALL_A, 'Custom_B', 'B1', 'edited', PropertyValueType.Label);
    const result = await new MergedExporter([{ id: 'm', name: 'M', dataStore: store, mutationView: view }])
      .exportAsync({ schema: 'IFC4' });
    const text = new TextDecoder().decode(result.content);
    const idOf = (guid: string): number =>
      [...records(text)].find(([, r]) => r.type === 'IFCWALL' && r.args.startsWith(`'${guid}'`))![0];
    const [a, b, c] = ['2Z2BGIG3j5fRzbeoRb82L1', '2Z2BGIG3j5fRzbeoRb82L2', '2Z2BGIG3j5fRzbeoRb82L3'].map(idOf);
    for (const other of [b, c]) {
      expect(customBSets(text, other)).toEqual([{ guid: SHARED_GUID, kinds: SOURCE_KINDS }]);
    }
    const [copy, ...extra] = customBSets(text, a);
    expect(extra).toEqual([]);
    expect(copy.guid).not.toBe(SHARED_GUID);
    expect(copy.kinds).toEqual(SOURCE_KINDS);
  });

  it('a deleted member is dropped from the copy and kept in the shared original', async () => {
    const { text } = await exportEdited((view) => {
      view.deleteProperty(WALL_A, 'Custom_B', 'Layers');
    });
    const { Layers: _removed, ...rest } = SOURCE_KINDS;
    expect(customBSets(text, WALL_A)).toEqual([{ guid: expect.any(String), kinds: rest }]);
    expect(customBSets(text, WALL_B)).toEqual([{ guid: SHARED_GUID, kinds: SOURCE_KINDS }]);
  });
});

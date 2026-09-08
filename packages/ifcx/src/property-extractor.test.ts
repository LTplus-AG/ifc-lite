/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { StringTable, QuantityType } from '@ifc-lite/data';
import { parseIfcx } from './index.js';
import { extractProperties } from './property-extractor.js';
import { parseV5aKey } from './types.js';
import type { ComposedNode, IfcxFile } from './types.js';

function createNode(path: string): ComposedNode {
  return {
    path,
    attributes: new Map(),
    children: new Map(),
  };
}

function extract(node: ComposedNode): Array<{ name: string; value: unknown }> {
  const composed = new Map([[node.path, node]]);
  const pathToId = new Map([[node.path, 1]]);
  const table = extractProperties(composed, pathToId, new StringTable());
  return table.getForEntity(1).flatMap((pset) => pset.properties);
}

describe('extractProperties — typed records and internal carriers (#1031)', () => {
  it('decodes TypedPropertyValue records to their scalar value', () => {
    const node = createNode('wall');
    node.attributes.set('bsi::ifc::v5a::Pset_FireSafety::FireRating', {
      type: 'IfcLabel',
      value: 'F30',
      source: 'manual',
    });

    const props = extract(node);
    const fireRating = props.find((p) => p.name === 'FireRating');
    assert.ok(fireRating, 'FireRating extracted');
    // The actual scalar, not a JSON blob of the record.
    assert.strictEqual(fireRating.value, 'F30');
  });

  it('skips ifclite:: internal carriers other than classifications', () => {
    const node = createNode('wall');
    node.attributes.set('ifclite::materials', [{ materialId: 'mat-1' }]);
    node.attributes.set('ifclite::geometryRef', 'geom-1');
    node.attributes.set('ifclite::deleted', false);
    node.attributes.set('ifclite::meta', { createdBy: 'ada', createdAt: '2019-05-05T00:00:00Z' });
    node.attributes.set('bsi::ifc::v5a::Pset_WallCommon::IsExternal', {
      type: 'IfcBoolean',
      value: true,
    });

    const props = extract(node);
    assert.strictEqual(props.length, 1, 'only the real property surfaces');
    assert.strictEqual(props[0].name, 'IsExternal');
    assert.strictEqual(props[0].value, true);
  });

  it('unpacks ifclite::classifications into a per-system Classification pset (#3608)', () => {
    const node = createNode('wall');
    node.attributes.set('ifclite::classifications', [
      { system: 'Uniclass 2015', code: 'Pr_20_93_47', uri: 'https://uniclass.thenbs.com/Pr_20_93_47' },
      { system: 'eBKP-H', code: 'C2.1' },
    ]);

    const composed = new Map([[node.path, node]]);
    const pathToId = new Map([[node.path, 1]]);
    const table = extractProperties(composed, pathToId, new StringTable());
    const psets = table.getForEntity(1);

    const uniclass = psets.find((p) => p.name === 'Classification - Uniclass 2015');
    assert.ok(uniclass, 'Uniclass pset present');
    const uniclassCode = uniclass!.properties.find((p) => p.name === 'Code');
    assert.strictEqual(uniclassCode?.value, 'Pr_20_93_47');
    const uniclassUri = uniclass!.properties.find((p) => p.name === 'Uri');
    assert.strictEqual(uniclassUri?.value, 'https://uniclass.thenbs.com/Pr_20_93_47');

    const ebkp = psets.find((p) => p.name === 'Classification - eBKP-H');
    assert.ok(ebkp, 'eBKP-H pset present');
    const ebkpCode = ebkp!.properties.find((p) => p.name === 'Code');
    assert.strictEqual(ebkpCode?.value, 'C2.1');
  });

  it('keeps two refs sharing a system separate, each with its own Code/Uri (#3608)', () => {
    // Ordinary Uniclass practice: an element carries both a Systems code
    // (with a URI) and a Products code (without one) under the same
    // system name. `set()`-ing a single 'Code'/'Uri' pair per system would
    // collapse these into one pset — dropping a code and pairing the
    // survivor with the wrong URI.
    const node = createNode('wall');
    node.attributes.set('ifclite::classifications', [
      { system: 'Uniclass 2015', code: 'Ss_25_10_30', uri: 'https://uniclass.thenbs.com/Ss_25_10_30' },
      { system: 'Uniclass 2015', code: 'Pr_20_93_47' },
    ]);

    const composed = new Map([[node.path, node]]);
    const pathToId = new Map([[node.path, 1]]);
    const table = extractProperties(composed, pathToId, new StringTable());
    const psets = table.getForEntity(1);

    const systems = psets.find((p) => p.name === 'Classification - Uniclass 2015 - Ss_25_10_30');
    assert.ok(systems, 'the Systems ref (Ss_25_10_30) has its own pset');
    assert.strictEqual(systems!.properties.find((p) => p.name === 'Code')?.value, 'Ss_25_10_30');
    assert.strictEqual(
      systems!.properties.find((p) => p.name === 'Uri')?.value,
      'https://uniclass.thenbs.com/Ss_25_10_30'
    );

    const products = psets.find((p) => p.name === 'Classification - Uniclass 2015 - Pr_20_93_47');
    assert.ok(products, 'the Products ref (Pr_20_93_47) has its own pset');
    assert.strictEqual(products!.properties.find((p) => p.name === 'Code')?.value, 'Pr_20_93_47');
    // The Products ref carries no URI — it must not inherit the Systems
    // ref's URI.
    assert.strictEqual(products!.properties.find((p) => p.name === 'Uri'), undefined);
  });

  it('discriminates a constructed-name collision instead of overwriting (#3608)', () => {
    // The constructed name space can collide: system "Acme" with codes A and B
    // yields "Classification - Acme - A"/"... - B", and a system literally
    // named "Acme - A" with single code C yields "Classification - Acme - A"
    // too. Without a discriminator the C ref would overwrite the A ref's
    // Code and pair it with the wrong Uri.
    const node = createNode('wall');
    node.attributes.set('ifclite::classifications', [
      { system: 'Acme', code: 'A', uri: 'https://acme.example/A' },
      { system: 'Acme', code: 'B' },
      { system: 'Acme - A', code: 'C', uri: 'https://acme-a.example/C' },
    ]);

    const composed = new Map([[node.path, node]]);
    const pathToId = new Map([[node.path, 1]]);
    const table = extractProperties(composed, pathToId, new StringTable());
    const psets = table.getForEntity(1);

    const a = psets.find((p) => p.name === 'Classification - Acme - A');
    assert.ok(a, 'the Acme/A ref keeps the plain constructed name');
    assert.strictEqual(a!.properties.find((p) => p.name === 'Code')?.value, 'A');
    assert.strictEqual(
      a!.properties.find((p) => p.name === 'Uri')?.value,
      'https://acme.example/A'
    );

    const b = psets.find((p) => p.name === 'Classification - Acme - B');
    assert.ok(b, 'the Acme/B ref is untouched by the collision');
    assert.strictEqual(b!.properties.find((p) => p.name === 'Code')?.value, 'B');

    const c = psets.find((p) => p.name === 'Classification - Acme - A (2)');
    assert.ok(c, 'the colliding "Acme - A" system ref gets a discriminator');
    assert.strictEqual(c!.properties.find((p) => p.name === 'Code')?.value, 'C');
    assert.strictEqual(
      c!.properties.find((p) => p.name === 'Uri')?.value,
      'https://acme-a.example/C'
    );
  });

  it('skips a classification ref with no code', () => {
    const node = createNode('wall');
    node.attributes.set('ifclite::classifications', [{ system: 'Uniclass 2015' }]);

    const props = extract(node);
    assert.strictEqual(props.length, 0, 'a codeless ref surfaces nothing');
  });

  it('v5a properties keep the exact authored Pset name, not a display-formatted one', () => {
    const node = createNode('wall');
    node.attributes.set('bsi::ifc::v5a::Pset_WallCommon::IsExternal', {
      type: 'IfcBoolean',
      value: true,
    });

    const composed = new Map([[node.path, node]]);
    const pathToId = new Map([[node.path, 1]]);
    const table = extractProperties(composed, pathToId, new StringTable());
    const psets = table.getForEntity(1);
    assert.strictEqual(psets.length, 1);
    // Consumers match on the real IFC pset name (whereProperty,
    // property panels); "IFC - v5a::Pset_WallCommon" would hide it.
    assert.strictEqual(psets[0].name, 'Pset_WallCommon');
    assert.strictEqual(table.getPropertyValue(1, 'Pset_WallCommon', 'IsExternal'), true);
  });

  it('leaves raw scalar attributes untouched (legacy migrated values)', () => {
    const node = createNode('wall');
    node.attributes.set('bsi::ifc::v5a::Pset_WallCommon::FireRating', 'F30');

    const props = extract(node);
    const fireRating = props.find((p) => p.name === 'FireRating');
    assert.ok(fireRating);
    assert.strictEqual(fireRating.value, 'F30');
  });

  it('quantity-named Pset_* members stay properties (namespace wins over name heuristic)', () => {
    const node = createNode('wall');
    node.attributes.set('bsi::ifc::v5a::Pset_Dimensions::Length', { type: 'IfcReal', value: 2 });
    node.attributes.set('bsi::ifc::v5a::Pset_Dimensions::Area', 4.5);

    const props = extract(node);
    const length = props.find((p) => p.name === 'Length');
    assert.ok(length, 'Length stays in the property table');
    assert.strictEqual(length.value, 2);
    const area = props.find((p) => p.name === 'Area');
    assert.ok(area, 'raw-number Area stays in the property table too');
    assert.strictEqual(area.value, 4.5);
  });

  it('custom v5a sets mirror the collab dialect: typed → property, raw number → quantity', async () => {
    const file: IfcxFile = {
      header: {
        id: 'custom-sets',
        ifcxVersion: 'ifcx-alpha',
        dataVersion: '1',
        author: 'test',
        timestamp: '2026-06-10T00:00:00Z',
      },
      imports: [],
      schemas: {},
      data: [
        {
          path: 'wall',
          attributes: {
            'bsi::ifc::class': { code: 'IfcWall', uri: 'u' },
            // Custom pset with a quantity-LIKE name: typed record → stays
            // a property (collab inflation puts it in psets).
            'bsi::ifc::v5a::Dimensions::Length': { type: 'IfcReal', value: 2 },
            // Custom quantity set with a non-heuristic name: raw number →
            // quantity (collab inflation puts it in quantities).
            'bsi::ifc::v5a::CarbonMetrics::EmbodiedCO2': 412.5,
          },
        },
      ],
    };
    const buffer = new TextEncoder().encode(JSON.stringify(file)).buffer as ArrayBuffer;
    const result = await parseIfcx(buffer);

    const props = result.properties.getForEntity(1).flatMap((pset) => pset.properties);
    const length = props.find((p) => p.name === 'Length');
    assert.ok(length, 'typed Length stays a property');
    assert.strictEqual(length.value, 2);
    assert.ok(!props.some((p) => p.name === 'EmbodiedCO2'), 'raw custom quantity not a property');

    const qsets = result.quantities.getForEntity(1);
    const co2Set = qsets.find((qset) => qset.name === 'CarbonMetrics');
    assert.ok(co2Set, `authored custom set name kept (got ${JSON.stringify(qsets.map((q) => q.name))})`);
    const co2 = co2Set.quantities.find((q) => q.name === 'EmbodiedCO2');
    assert.ok(co2, 'raw custom quantity reaches the quantity table');
    assert.strictEqual(co2.value, 412.5);
    assert.strictEqual(
      co2.type,
      QuantityType.Count,
      'unrecognized numeric in a non-Qto custom set must not fabricate a Length unit'
    );
    assert.ok(
      !qsets.some((qset) => qset.quantities.some((q) => q.name === 'Length')),
      'typed Length not double-claimed as quantity'
    );
  });

  it('typed quantity-like properties land in the quantity table, not dropped', async () => {
    const file: IfcxFile = {
      header: {
        id: 'typed-qty',
        ifcxVersion: 'ifcx-alpha',
        dataVersion: '1',
        author: 'test',
        timestamp: '2026-06-10T00:00:00Z',
      },
      imports: [],
      schemas: {},
      data: [
        {
          path: 'wall',
          attributes: {
            'bsi::ifc::class': { code: 'IfcWall', uri: 'u' },
            // Quantity-like name with a typed record (#1031): must be
            // routed to the QuantityTable, not vanish from both tables.
            'bsi::ifc::v5a::Qto_WallBaseQuantities::NetArea': { type: 'IfcReal', value: 12.5 },
          },
        },
      ],
    };
    const buffer = new TextEncoder().encode(JSON.stringify(file)).buffer as ArrayBuffer;
    const result = await parseIfcx(buffer);

    const entityId = 1; // single entity
    const qsets = result.quantities.getForEntity(entityId);
    const all = qsets.flatMap((qset) => qset.quantities);
    const netArea = all.find((q) => q.name === 'NetArea');
    assert.ok(netArea, `NetArea present in quantity table (got ${JSON.stringify(qsets)})`);
    assert.strictEqual(netArea.value, 12.5);
  });

  it('does not silently drop bsi::ifc::material (#PCERT real-world fixtures carry it)', () => {
    // Real buildingSMART sample scenes (tests/models/ifc5/PCERT-Sample-Scene_*)
    // author `bsi::ifc::material` as `{ code, uri }` on most physical
    // elements — the only place IFCX carries which material an element is
    // made of.
    // `SKIP_ATTRIBUTES` treats it as a non-property attribute (like the
    // graph-structural `bsi::ifc::class`/mesh/transform keys) with nothing
    // else in the package ever reading it, so it vanished entirely: no
    // property, no relationship. A STEP-sourced model surfaces the same data
    // via `IfcRelAssociatesMaterial` (query engine, viewer Material tab).
    const node = createNode('wall');
    node.attributes.set('bsi::ifc::material', {
      code: 'concrete_reinforced_in_situ',
      uri: 'https://identifier.buildingsmart.org/uri/buildingsmart-community/materials-demo/1.0/class/concrete_reinforced_in_situ',
    });

    const props = extract(node);
    const material = props.find((p) => p.name === 'Material');
    assert.ok(
      material,
      `material code reaches the property table (got ${JSON.stringify(props)})`
    );
    assert.strictEqual(material?.value, 'concrete_reinforced_in_situ');
    const uri = props.find((p) => p.name === 'Uri');
    assert.ok(uri, `material uri reaches the property table (got ${JSON.stringify(props)})`);
    assert.strictEqual(
      uri?.value,
      'https://identifier.buildingsmart.org/uri/buildingsmart-community/materials-demo/1.0/class/concrete_reinforced_in_situ'
    );
  });
});

describe('parseV5aKey — malformed keys from third-party ifcx files', () => {
  /**
   * `parseV5aKey` splits `bsi::ifc::v5a::<Set>::<Prop>`. Its `sep <= 0` guard
   * rejects an EMPTY set name (`bsi::ifc::v5a::::Name`, where the separator
   * sits at index 0). Relaxing that to `sep < 0` survived the whole 109-test
   * suite -- nothing pinned the empty-set-name case.
   *
   * It matters because this parses attribute keys out of an .ifcx document,
   * which may come from another tool: `property-extractor.ts:110`/`:232` and
   * `index.ts:376` all feed it third-party content. No writer in THIS repo
   * emits a doubled separator, but the guard exists for input we did not
   * write -- without it a malformed key yields a property set named '' that
   * then flows on into the property and quantity tables.
   */
  it('rejects a v5a key whose set name is empty', () => {
    assert.strictEqual(parseV5aKey('bsi::ifc::v5a::::NetArea'), null);
  });

  /**
   * Control: a well-formed key must still parse, so the guard above cannot be
   * satisfied by rejecting everything.
   */
  it('still parses a well-formed v5a key', () => {
    assert.deepStrictEqual(parseV5aKey('bsi::ifc::v5a::Qto_WallBaseQuantities::NetArea'), {
      setName: 'Qto_WallBaseQuantities',
      name: 'NetArea',
    });
  });

  /**
   * The trailing-separator form has an empty MEMBER name and is rejected by
   * the same condition's upper bound. Pinned alongside so the two halves of
   * that guard are not left leaning on each other.
   */
  it('rejects a v5a key whose member name is empty', () => {
    assert.strictEqual(parseV5aKey('bsi::ifc::v5a::Qto_WallBaseQuantities::'), null);
  });
});

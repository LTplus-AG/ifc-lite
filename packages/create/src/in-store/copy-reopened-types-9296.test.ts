/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { it, expect } from 'vitest';
import { IfcParser, extractPropertiesOnDemand, extractQuantitiesOnDemand } from '@ifc-lite/parser';
import { MutablePropertyView, StoreEditor } from '@ifc-lite/mutations';
import { StepExporter } from '../../../export/src/step-exporter.js';
import { IfcCreator } from '../index.js';
import { AnchorEntityReader, resolveSpatialAnchor } from './resolve-anchor.js';
import { addOrdinaryElementInStore } from './ordinary-element.js';
import { addElementTypeToStore, assignTypeInStore } from './element-type.js';
import { copyBatchInStore } from './copy-batch.js';
import { asRef, refList } from './style-entity-reader.js';

for (const reopenBetweenCopies of [false, true]) {
  it(`#9296 one type relationship covers successive saved wall batches (reopen between copies: ${reopenBetweenCopies})`, async () => {
    const creator = new IfcCreator();
    const ground = creator.addIfcBuildingStorey({ Name: 'Ground', Elevation: 0 });
    const upper = creator.addIfcBuildingStorey({ Name: 'Upper', Elevation: 3 });
    const third = creator.addIfcBuildingStorey({ Name: 'Third', Elevation: 6 });
    const parse = (bytes: Uint8Array) => new IfcParser().parseColumnar(
      bytes.slice().buffer as ArrayBuffer, { disableWorkerScan: true });
    let data = await parse(new TextEncoder().encode(creator.toIfc().content));
    let view = new MutablePropertyView(null, 'copy'), editor = new StoreEditor(data, view);
    const anchor = resolveSpatialAnchor(data, ground, view);
    const walls = Array.from({ length: 5 }, (_, i) => addOrdinaryElementInStore(editor, anchor, {
      kind: 'wall', params: { Start: [0, i * 2, 0], End: [8, i * 2, 0], Height: 3, Thickness: .2 },
    }));
    const type = addElementTypeToStore(editor, anchor, { Type: 'IfcWallType', Name: 'Wall type', PredefinedType: 'STANDARD' });
    assignTypeInStore(editor, anchor, type.typeId, walls, []);
    const save = () => new StepExporter(data, view).export({ schema: 'IFC4', applyMutations: true }).content;
    const reopen = async () => {
      data = await parse(save());
      view = new MutablePropertyView(null, 'reopened');
      view.setOnDemandExtractor(id => extractPropertiesOnDemand(data, id));
      view.setQuantityExtractor(id => extractQuantitiesOnDemand(data, id));
      editor = new StoreEditor(data, view);
    };
    const typed = [...walls];
    const check = async () => {
      const reader = new AnchorEntityReader(await parse(save()), null);
      const relationships = [...reader.ids('IFCRELDEFINESBYTYPE')].map(id => reader.entity(id)!)
        .filter(rel => asRef(rel.attributes[5]) === type.typeId);
      expect(relationships, 'one relationship for the wall type').toHaveLength(1);
      expect(refList(relationships[0].attributes[4]).sort((a, b) => a - b), 'originals and every copy remain typed')
        .toEqual([...typed].sort((a, b) => a - b));
    };
    await reopen(); // The first extension must find a relationship in the saved source.
    await check();
    let selection = walls.slice(0, 4);
    for (const storey of [upper, third]) {
      const copies = copyBatchInStore(data, editor, selection, [{ targetStoreyId: storey }]);
      for (const result of copies) for (const [copy, source] of result.copiedFrom) view.setEntityAlias(copy, source);
      selection = copies.map(copy => copy.copyId);
      typed.push(...selection);
      await check();
      if (reopenBetweenCopies) await reopen();
    }
    expect(typed).toHaveLength(13);
  });
}

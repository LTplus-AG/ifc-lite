/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MutablePropertyView, StoreEditor } from '@ifc-lite/mutations';
import { StepExporter } from '@ifc-lite/export';
import { BACK_WALL as GUID, SAMPLE_MODEL, parseIfc as parse, seedAuthoringSample } from '@/test/authoring-sample-fixture';
    test('#7276 public native material Name cannot shadow a real SketchUp wall GlobalId after export/reparse', async () => {
        const { dataStore: store } = await seedAuthoringSample();
        const wall = store.entities.getExpressIdByGlobalId(GUID);
        assert.equal(store.entities.getTypeName(wall), 'IfcWall');
        const view = new MutablePropertyView(store.properties, SAMPLE_MODEL);
        const editor = new StoreEditor(store, view);
        const material = editor.addEntity('IfcMaterial', [GUID, 'Authored description', 'Authored category']);
        const bytes = new StepExporter(store, view).export({ schema: store.schemaVersion, applyMutations: true, includeGeometry: true }).content;
        const saved = await parse(bytes);
        assert.deepEqual(saved.getEntity(material.expressId)?.attributes, [GUID, 'Authored description', 'Authored category']);
        assert.equal(saved.getEntity(wall)?.attributes[0], GUID);
        assert.equal(saved.entities.getGlobalId(material.expressId), '');
        assert.equal(saved.entities.getName(material.expressId), GUID);
        assert.equal(saved.entities.getExpressIdByGlobalId(GUID), wall);
    });


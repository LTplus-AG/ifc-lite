/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** #9026 item 14: a grid and column authored on an IFC4 model, exported as
 * IFC4X3. Each IfcGridPlacement must be in the IFC4X3 layout and name the
 * owning grid's placement, through the overlay path a session writes. */
import { describe, expect, it } from 'vitest';
import { StepExporter } from '@ifc-lite/export';
import { MutablePropertyView, StoreEditor } from '@ifc-lite/mutations';
import { IfcParser, extractPropertiesOnDemand } from '@ifc-lite/parser';
import { IfcCreator } from '../ifc-creator.js';
import { addColumnOnGridToStore } from './grid-column.js';
import { addGridToStore, rectangularGridAxes } from './grid.js';
import { resolveSpatialAnchor } from './resolve-anchor.js';

describe('a session-authored grid column exported across IFC4X3 (#9026 item 14)', () => {
  it('writes the three-attribute layout, relative to the owning grid', async () => {
    const creator = new IfcCreator({ Schema: 'IFC4', Timestamp: 0 });
    const storeyId = creator.addIfcBuildingStorey({ Name: 'S', Elevation: 3 });
    const store = await new IfcParser().parseColumnar(
      new TextEncoder().encode(creator.toIfc().content).buffer as ArrayBuffer, { disableWorkerScan: true });
    const view = new MutablePropertyView(null, 'g');
    view.setOnDemandExtractor((id) => extractPropertiesOnDemand(store, id));
    const editor = new StoreEditor(store, view);
    const anchor = resolveSpatialAnchor(store, storeyId, view);
    const grid = addGridToStore(editor, anchor, rectangularGridAxes({ UOffsets: [0, 6], VOffsets: [0, 4] }));
    const { gridPlacement } = addColumnOnGridToStore(editor, store, anchor, { Position: [6, 4, 0], Width: 0.4, Depth: 0.4, Height: 3 }, {
      GridId: grid.gridId, IntersectingAxes: [grid.uAxisIds[1], grid.vAxisIds[1]],
    });

    const step = new TextDecoder().decode(new StepExporter(store, view).export({ schema: 'IFC4X3', applyMutations: true }).content);

    expect(step).toContain(`#${gridPlacement.placementId}=IFCGRIDPLACEMENT(#${grid.placementId},#${gridPlacement.intersectionId},$);`);
  });
});

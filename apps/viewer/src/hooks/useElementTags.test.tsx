/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import { afterEach, it } from 'node:test';
import assert from 'node:assert/strict';
import { useRef, act } from 'react';
import { IfcParser } from '@ifc-lite/parser';
import type { Drawing2D } from '@ifc-lite/drawing-2d';
import { useViewerStore } from '@/store';
import { fixtureModel, fixtureModels } from '@/test/store-fixture.js';
import { render, cleanup, mouseDown } from '@/test/render.js';
import { useElementTags } from './useElementTags.js';

const initial = useViewerStore.getState();
afterEach(() => { cleanup(); useViewerStore.setState(initial, true); });
const polygon = (entityId: number, x = 0) => ({ entityId, ifcType: 'IfcDoor', modelIndex: 0, isCut: true,
  polygon: { outer: [{ x, y: 0 }, { x: x+2, y: 0 }, { x: x+2, y: 2 }, { x, y: 2 }], holes: [] } });
function drawing(entityId: number, x = 0): Drawing2D {
  return { config: { plane: { axis: 'z', position: 1, flipped: false }, projectionDepth: 10, includeHiddenLines: true, creaseAngle: 30, scale: 50 },
    lines: [], cutPolygons: [polygon(entityId,x)], projectionPolygons: [], bounds: { min: { x, y: 0 }, max: { x: x+2, y: 2 } },
    stats: { cutLineCount: 0, projectionLineCount: 0, hiddenLineCount: 0, silhouetteLineCount: 0, polygonCount: 1, totalTriangles: 0, processingTimeMs: 0 } };
}
function Harness() {
  const ref = useRef<HTMLDivElement>(null);
  const current = useViewerStore(s => s.drawing2D);
  const tags = useElementTags(current, { x: 0, y: 0, scale: 100 }, 'down', ref);
  return <div ref={ref} onMouseDown={tags.handleMouseDown} onMouseMove={tags.handleMouseMove}>
    {tags.texts.map(tag => <span key={tag.id} data-tag-x={tag.position.x}>{tag.text}</span>)}
  </div>;
}

for (const federated of [false, true]) {
  it(`#9296 a drawing gesture binds the correct ${federated ? 'federated' : 'single-model'} door and follows regeneration`, async () => {
    const store = await new IfcParser().parseColumnar(new TextEncoder().encode(`ISO-10303-21;
HEADER; FILE_DESCRIPTION((''),'2;1'); FILE_NAME('','',(''),(''),'','',''); FILE_SCHEMA(('IFC4')); ENDSEC;
DATA;
#1=IFCPROJECT('0Project00000000000001',$,'Project',$,$,$,$,$,$);
#10=IFCDOOR('0Door00000000000000010',$,'Entrance',$,$,$,$,$,2.1,0.9,$,$,$);
ENDSEC; END-ISO-10303-21;`).buffer, { disableWorkerScan: true });
    const first = { ...fixtureModel('m', { idOffset: federated ? 1_000_000 : 0 }), ifcDataStore: store };
    const second = { ...fixtureModel('other', { idOffset: 2_000_000 }), ifcDataStore: store };
    const globalId = federated ? 1_000_010 : 10;
    useViewerStore.setState({ ...fixtureModels(first, ...(federated ? [second] : [])), drawing2D: drawing(globalId),
      tagAnnotations2D: [], annotation2DActiveTool: 'tag' });
    const ui = render(<Harness />);
    const canvas = ui.firstElementChild!;
    mouseDown(canvas, { clientX: 100, clientY: 100 });
    const tags = useViewerStore.getState().tagAnnotations2D;
    assert.equal(tags.length, 1);
    assert.equal(tags[0].modelId, 'm'); assert.equal(tags[0].entityId, 10);
    assert.equal(ui.querySelector('span')?.textContent, 'Entrance');
    assert.equal(Number(ui.querySelector('span')?.getAttribute('data-tag-x')), 1.15);
    act(() => useViewerStore.setState({ drawing2D: drawing(globalId,5) }));
    assert.equal(Number(ui.querySelector('span')?.getAttribute('data-tag-x')), 6.15);
    act(() => { useViewerStore.setState({ annotation2DActiveTool: 'none' }); });
    mouseDown(canvas, { clientX: 620, clientY: 115 });
    assert.equal(useViewerStore.getState().selectedAnnotation2D?.type, 'tag');
    act(() => useViewerStore.getState().deleteSelectedAnnotation2D());
    assert.equal(ui.querySelector('span'), null, 'Delete removes the displayed tag');
  });
}

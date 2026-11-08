/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import { installLayout } from '@/test/dom-layout';
installLayout();
import '@/lib/commands/modeling/builtin';
import assert from 'node:assert/strict';
import { it, afterEach } from 'node:test';
import { cleanup, click, waitFor } from '@/test/render';
import { useViewerStore } from '@/store';
import { seedModelingSession, MODEL_ID, UPPER_STOREY } from '@/test/modeling-session-fixture';
import { renderScene } from '../../viewport-ui/scene/test/scene-test-support';
import { WorkplaneScene } from './WorkplaneScene';
import { StoreyManager } from './storeys/StoreyManager';
afterEach(() => { cleanup(); useViewerStore.getState().exitModelWorkspace(); });
it('#9334 a tiny or empty storey retains a usable drawing extent and a visible crosshair', async () => {
  await seedModelingSession();
  // L0 contains the fixture's imported wall; L1 is the empty drawing storey.
  useViewerStore.getState().enterModelWorkspace({ modelId: MODEL_ID, storeyId: UPPER_STOREY });
  const wall = useViewerStore.getState().addWall(MODEL_ID, UPPER_STOREY, { Start: [0, 0, 0], End: [0.1, 0, 0], Height: 3, Thickness: 0.2 });
  assert.ok('expressId' in wall);
  const { container, source, flush } = renderScene(<WorkplaneScene />);
  source.camera.projectToScreen = p => ({ x: 400 + p.x * 10, y: 300 + p.z * 10 });
  flush();
  const polygon = container.querySelector<SVGPolygonElement>('[data-scene-primitive="plane-outline"]')!;
  const xs = polygon.getAttribute('points')!.split(' ').map(point => Number(point.split(',')[0]));
  assert.ok(Math.max(...xs) - Math.min(...xs) >= 120, `at least 12 m, even with tiny bounds: ${polygon.getAttribute('points')}`);
  assert.equal(container.querySelector<SVGGElement>('[data-snap-kind="workplane"]')?.style.display, '');
});

it('#9334 Draw on the same row reprojects an idle workplane after a programmatic camera change', async () => {
  await seedModelingSession();
  useViewerStore.getState().enterModelWorkspace({ modelId: MODEL_ID, storeyId: UPPER_STOREY });
  const { container, source, projector, flush } = renderScene(<><WorkplaneScene /><StoreyManager onBack={() => {}} /></>);
  await waitFor(() => !!container.querySelector(`[data-storey-row="${UPPER_STOREY}"]`), 'storey rows load');
  source.camera.projectToScreen = p => ({ x: 400 + p.x * 10, y: 300 + p.z * 10 });
  flush(); flush();
  assert.equal(projector.isRunning, false, 'the projector has gone idle');
  const polygon = container.querySelector<SVGPolygonElement>('[data-scene-primitive="plane-outline"]')!;
  const before = polygon.getAttribute('points');
  source.camera.projectToScreen = p => ({ x: 300 + p.x * 20, y: 200 + p.z * 20 });
  click(container.querySelector(`[data-storey-row="${UPPER_STOREY}"] [role="radio"]`)!);
  assert.equal(projector.isRunning, true, 'Draw on wakes identical world coordinates');
  flush();
  assert.notEqual(polygon.getAttribute('points'), before);
  assert.equal(container.querySelector<SVGGElement>('[data-snap-kind="workplane"]')?.style.transform, 'translate(300px, 200px)');
});

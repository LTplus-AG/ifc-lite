/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `stair.place` and `railing.place` (#6232 D1). A stair is two clicks on the
 * workplane and climbs exactly to the storey above; a railing follows the
 * clicked polyline, snapping onto a slab edge's or stair side's height. Each
 * placement is ONE undo step and asks the re-mesh for what it wrote.
 */

import '@/test/setup-dom.js';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { railingPostPoints } from '@ifc-lite/create';
import type { MutablePropertyView } from '@ifc-lite/mutations';
import { useViewerStore } from '@/store';
import { cleanup, press, render } from '@/test/render.js';
import { MODEL_ID, STOREY, UPPER_STOREY, seedModelingSession } from '@/test/modeling-session-fixture';
import { CommandFieldsBar } from '@/components/viewer/tools/command/CommandFieldsBar';
import { CommandBarContent } from '@/components/viewer/tools/command/CommandHud';
import { RAIL_TOOLS } from '@/components/viewer/model/rail-tools';
import { TOOL_SURFACE_COMMANDS } from '@/components/viewer/surface-commands-tools';
import { KEY_COMMANDS } from '@/lib/commands/keyboard-commands';
import type { SnapCandidate, SnapResult } from '@/lib/snap/types';
import '../builtin.js';
import {
  commandDoubleClick, commandPointerDown, commandPointerMove, getCommandRuntime, writeCommandField,
} from '../runtime.js';
import { setRequestRemesh, type RemeshRequest } from '../transaction.js';
import type { CommandContext } from '../types.js';
import { STAIR_PLACE } from './stair-place.js';
import { RAILING_PLACE } from './railing-place.js';
import type { StairPlaceGesture } from './stair-place-geometry.js';
import type { RailingPlaceGesture } from './railing-place-geometry.js';
import { resetStairRailingSettings } from './stair-railing-settings.js';

const at = (x: number, y: number, winner: SnapCandidate | null = null): SnapResult => ({ local: [x, y], winner, guides: [], locked: false });
const meshEdge = (x: number, y: number, elevation: number): SnapCandidate => ({ kind: 'endpoint', local: [x, y], elevation, source: 'mesh' });
const click = (x: number, y: number, winner: SnapCandidate | null = null) => act(() => { commandPointerMove(at(x, y, winner)); commandPointerDown(at(x, y, winner)); });
const doubleClick = (x: number, y: number, winner: SnapCandidate | null = null) => act(() => { commandPointerMove(at(x, y, winner)); commandPointerDown(at(x, y, winner)); commandDoubleClick(at(x, y, winner)); });
const move = (x: number, y: number) => act(() => { commandPointerMove(at(x, y)); });
const gesture = <G,>() => getCommandRuntime().gesture as G;
const ctx = () => getCommandRuntime().ctx as CommandContext;
const field = (command: { fields?: readonly { id: string }[] }, id: string) => command.fields!.findIndex((f) => f.id === id);
const type = (command: { fields?: readonly { id: string }[] }, id: string, value: number) => act(() => { writeCommandField(field(command, id), value); });
const undoDepth = () => useViewerStore.getState().undoStacks.get(MODEL_ID)?.length ?? 0;
const round = (v: unknown, places = 6) => +num(v).toFixed(places);
/** An overlay REAL is `{ real }`. */
const num = (v: unknown): number => (typeof v === 'object' && v !== null ? (v as { real: number }).real : (v as number));

const live = () => {
  const s = useViewerStore.getState();
  return { dataStore: s.models.get(MODEL_ID)!.ifcDataStore!, view: s.mutationViews.get(MODEL_ID)! };
};
function created(ifcClass: string): number[] {
  const { view } = live();
  return view.getNewEntities().filter((e) => e.type.toUpperCase() === ifcClass && !view.isDeleted(e.expressId)).map((e) => e.expressId);
}
const deref = (view: MutablePropertyView, v: unknown) => view.getNewEntity(Number(String(v).slice(1)))!;
const point = (view: MutablePropertyView, ref: unknown) => (deref(view, ref).attributes[0] as unknown[]).map(num);

/** The body items of an overlay product: IfcProduct.Representation → shape → body → items. */
function bodyItems(id: number): number[] {
  const { view } = live();
  const shape = deref(view, view.getNewEntity(id)!.attributes[6]);
  const rep = deref(view, (shape.attributes[2] as unknown[])[0]);
  return (rep.attributes[3] as unknown[]).map((ref) => Number(String(ref).slice(1)));
}

/** The flight's stepped side outline as (run, rise) pairs, native units. */
function flightOutline(flight: number): number[][] {
  const { view } = live();
  const solid = view.getNewEntity(bodyItems(flight)[0])!;
  const curve = deref(view, deref(view, solid.attributes[0]).attributes[2]);
  return (curve.attributes[0] as unknown[]).map((ref) => point(view, ref));
}

let remeshed: RemeshRequest[] = [];
let restoreRemesh: () => void = () => {};

beforeEach(async () => {
  await seedModelingSession();
  resetStairRailingSettings();
  remeshed = [];
  restoreRemesh = setRequestRemesh((_get, request) => { remeshed.push(request); });
});
afterEach(() => {
  restoreRemesh();
  useViewerStore.getState().exitModelWorkspace();
  cleanup();
});

describe('stair.place (#6232 D1)', () => {
  it('two clicks write an IfcStair with a flight that rises exactly the storey height, in ONE undo step', () => {
    useViewerStore.getState().startCommand('stair.place');
    const before = undoDepth();
    click(1, 1);
    move(6, 1);
    // The ghost shows the flight before it is committed.
    assert.equal(STAIR_PLACE.ghost!(gesture<StairPlaceGesture>(), ctx()).length, 1, 'one ghost mesh for the whole flight');
    click(6, 1);

    const [stair] = created('IFCSTAIR');
    const [flight] = created('IFCSTAIRFLIGHT');
    assert.ok(stair && flight, 'an IfcStair with an IfcStairFlight');
    const { view } = live();
    // The 3 m to the level above is 17 risers of 3/17 m: 3 m / 0.175 rounds to 17.
    const [risers, treads, riser, tread] = [8, 9, 10, 11].map((i) => num(view.getNewEntity(flight)!.attributes[i]));
    assert.equal(risers, 17);
    assert.equal(treads, 17);
    assert.ok(Math.abs(risers * riser - 3) < 1e-9, `the flight rises ${risers * riser} m: exactly the storey height`);
    assert.ok(Math.abs(risers * tread - 5) < 1e-9, 'the 5 m run is cut into 17 treads');
    const outline = flightOutline(flight);
    assert.ok(Math.abs(Math.max(...outline.map((p) => p[1])) - 3) < 1e-9, 'the top tread is at the storey above');
    assert.ok(Math.abs(Math.max(...outline.map((p) => p[0])) - 5) < 1e-9, 'and ends where the run ends');
    assert.equal(created('IFCRELAGGREGATES').filter((rel) => String(view.getNewEntity(rel)!.attributes[4]) === `#${stair}`).length, 1, 'the stair aggregates its flight');

    // Centred on the drawn line: the foot corner is half the 1 m width to the right of the run.
    const location = point(view, deref(view, deref(view, view.getNewEntity(stair)!.attributes[5]).attributes[1]).attributes[0]);
    assert.deepEqual(location.map((v) => round(v)), [1, 0.5, 0]);

    const s = useViewerStore.getState();
    assert.equal(s.selectedEntityId !== null && s.resolveGlobalIdFromModels(s.selectedEntityId)?.expressId, flight, 'the flight is selected');
    assert.deepEqual(remeshed.map((r) => [r.cause, [...r.expressIds].sort()]), [['created', [stair, flight].sort()]], 'the flight is re-meshed');
    assert.equal(hierarchyStorey(stair), STOREY);
    assert.equal(hierarchyStorey(flight), STOREY);

    useViewerStore.getState().undo(MODEL_ID);
    for (const cls of ['IFCSTAIR', 'IFCSTAIRFLIGHT', 'IFCRELAGGREGATES']) assert.deepEqual(created(cls), [], `${cls} undone`);
    assert.equal(undoDepth(), before, 'one Ctrl+Z took the whole stair');
    useViewerStore.getState().redo(MODEL_ID);
    assert.equal(created('IFCSTAIR').length, 1, 'redo puts it back');
  });

  it('a millimetre model rises exactly 3000 mm', async () => {
    await seedModelingSession({ unit: 'millimetre' });
    useViewerStore.getState().startCommand('stair.place');
    click(0, 0);
    click(4, 0);
    const [flight] = created('IFCSTAIRFLIGHT');
    const { view } = live();
    const [risers, , riser] = [8, 9, 10].map((i) => num(view.getNewEntity(flight)!.attributes[i]));
    assert.ok(Math.abs(risers * riser - 3000) < 1e-6, `${risers} × ${riser} mm`);
  });

  it('the riser height asked for is fitted to a whole number of risers that still climbs the storey', () => {
    useViewerStore.getState().startCommand('stair.place');
    click(0, 0);
    type(STAIR_PLACE, 'riser', 0.2);
    move(6, 0);
    const bar = render(<CommandFieldsBar />);
    const riserField = bar.querySelector('[aria-label="Riser"]')!;
    assert.equal(riserField.getAttribute('aria-valuenow'), '0.2', '3 m in 0.2 m risers is exactly 15');
    click(6, 0);
    const [flight] = created('IFCSTAIRFLIGHT');
    const attrs = live().view.getNewEntity(flight)!.attributes;
    assert.deepEqual([attrs[8], round(attrs[10])], [15, 0.2]);

    // 0.18 m does not divide 3 m: 17 risers of 3/17 m, not 0.18 m ones that would stop short.
    useViewerStore.getState().startCommand('stair.place');
    type(STAIR_PLACE, 'riser', 0.18);
    click(0, 3);
    click(6, 3);
    const second = created('IFCSTAIRFLIGHT')[1];
    const [n, r] = [8, 10].map((i) => num(live().view.getNewEntity(second)!.attributes[i]));
    assert.equal(n, 17);
    assert.ok(Math.abs(n * r - 3) < 1e-9);
  });

  it('a typed tread fixes the run at risers × tread; a typed length fixes the tread', () => {
    useViewerStore.getState().startCommand('stair.place');
    click(0, 0);
    type(STAIR_PLACE, 'tread', 0.3);
    move(2, 0);
    click(2, 0);
    let attrs = live().view.getNewEntity(created('IFCSTAIRFLIGHT')[0])!.attributes;
    assert.equal(attrs[8], 17);
    assert.equal(round(attrs[11]), 0.3, 'the typed tread, whatever the cursor');

    useViewerStore.getState().startCommand('stair.place');
    click(0, 5);
    type(STAIR_PLACE, 'length', 3.4);
    move(1, 5);
    click(1, 5);
    attrs = live().view.getNewEntity(created('IFCSTAIRFLIGHT')[1])!.attributes;
    assert.equal(round(round(attrs[8]) * round(attrs[11], 9)), 3.4, 'the typed run, cut into 17 treads of 0.2 m');
  });

  it('the storey above is the one to climb to: none above, it is a free flight of the riser asked for', () => {
    useViewerStore.getState().enterModelWorkspace({ storeyId: UPPER_STOREY });
    useViewerStore.getState().startCommand('stair.place');
    click(0, 0);
    click(5, 0);
    const attrs = live().view.getNewEntity(created('IFCSTAIRFLIGHT')[0])!.attributes;
    assert.deepEqual([attrs[8], round(attrs[10])], [16, 0.175]);
    assert.equal(hierarchyStorey(created('IFCSTAIR')[0]), UPPER_STOREY);
  });

  it('refuses a run too short to hold steps, and a waist too thick for the flight; nothing is written', () => {
    useViewerStore.getState().startCommand('stair.place');
    const before = undoDepth();
    click(0, 0);
    move(1, 0);
    assert.deepEqual(STAIR_PLACE.validate!(gesture<StairPlaceGesture>(), ctx()), { ok: false, reasonKey: 'stairRailing.stair.tooShort' }, '1 m over 17 risers');
    click(1, 0);
    assert.deepEqual(created('IFCSTAIR'), []);
    assert.equal(undoDepth(), before);

    move(6, 0);
    type(STAIR_PLACE, 'waist', 3);
    assert.deepEqual(STAIR_PLACE.validate!(gesture<StairPlaceGesture>(), ctx()), { ok: false, reasonKey: 'stairRailing.stair.waistTooThick' });
    click(6, 0);
    assert.deepEqual(created('IFCSTAIR'), []);
  });

  it('with no edit rights nothing is placed', () => {
    useViewerStore.getState().startCommand('stair.place');
    click(0, 0);
    useViewerStore.setState({ editEnabled: false });
    click(5, 0);
    assert.deepEqual(created('IFCSTAIR'), []);
  });
});

/** The storey the spatial tree resolves an element to. */
function hierarchyStorey(id: number): number | undefined {
  return live().dataStore.spatialHierarchy?.elementToStorey.get(id);
}

describe('railing.place (#6232 D1)', () => {
  const railPath = (railing: number): number[][] => {
    const { view } = live();
    const sweep = view.getNewEntity(bodyItems(railing)[0])!;
    const polyline = deref(view, sweep.attributes[0]);
    return (polyline.attributes[0] as unknown[]).map((ref) => point(view, ref));
  };

  it('follows the clicked polyline, one post at each point and each spacing, in ONE undo step', () => {
    useViewerStore.getState().startCommand('railing.place');
    const before = undoDepth();
    click(0, 0);
    click(4, 0);
    move(4, 3);
    assert.equal(RAILING_PLACE.ghost!(gesture<RailingPlaceGesture>(), ctx()).length, 1, 'the rubber band is part of the ghost');
    doubleClick(4, 3);

    const [railing] = created('IFCRAILING');
    assert.ok(railing, 'an IfcRailing');
    assert.equal(created('IFCRAILING').length, 1, 'the double-click stacked no second one');
    const path = railPath(railing);
    // Directrix is relative to the first point, at the rail's centreline (1 m − half the 50 mm rail).
    assert.deepEqual(path.map((p) => p.map((v) => round(v))), [[0, 0, 0.975], [4, 0, 0.975], [4, 3, 0.975]], 'the rail is the clicked polyline, no extra last segment');
    const posts = railingPostPoints([[0, 0, 0], [4, 0, 0], [4, 3, 0]], 1.2);
    assert.equal(bodyItems(railing).length - 1, posts.length, 'a post at each point and each 1.2 m in between');
    assert.deepEqual(remeshed.map((r) => [r.cause, r.expressIds]), [['created', [railing]]]);
    assert.equal(hierarchyStorey(railing), STOREY);

    useViewerStore.getState().undo(MODEL_ID);
    assert.deepEqual(created('IFCRAILING'), []);
    assert.equal(undoDepth(), before, 'one Ctrl+Z took the whole railing');
    useViewerStore.getState().redo(MODEL_ID);
    assert.equal(created('IFCRAILING').length, 1);
  });

  it('typed height and post spacing build the railing; Backspace drops the last point; Enter finishes with the rubber band', () => {
    useViewerStore.getState().startCommand('railing.place');
    type(RAILING_PLACE, 'height', 1.1);
    type(RAILING_PLACE, 'spacing', 2);
    click(0, 0);
    click(2, 0);
    click(2, 5);
    press(document.body, 'Backspace');
    assert.equal(gesture<RailingPlaceGesture>().chain.length, 2, 'Backspace takes the last point');
    move(6, 0);
    assert.deepEqual(RAILING_PLACE.validate!(gesture<RailingPlaceGesture>(), ctx()), { ok: true }, 'two points and the rubber band');
    // Enter places what the ghost shows: the two points and the rubber band.
    press(document.body, 'Enter');
    const [railing] = created('IFCRAILING');
    assert.ok(railing);
    const path = railPath(railing);
    assert.deepEqual(path.map((p) => p.map((v) => round(v))), [[0, 0, 1.075], [2, 0, 1.075], [6, 0, 1.075]]);
  });

  it('a corner or edge of a slab or stair lifts the path to its height; free points stay level with the one before', () => {
    useViewerStore.getState().startCommand('railing.place');
    click(0, 0, meshEdge(0, 0, 0.5));
    click(3, 0);
    doubleClick(6, 0);
    const [railing] = created('IFCRAILING');
    // First point on a 0.5 m surface: the whole path runs level with it.
    assert.deepEqual(railPath(railing).map((p) => round(p[2])), [0.975, 0.975, 0.975], 'the directrix is relative to the first point');
    const placement = deref(live().view, live().view.getNewEntity(railing)!.attributes[5]);
    const origin = point(live().view, deref(live().view, placement.attributes[1]).attributes[0]);
    assert.equal(round(origin[2]), 0.5, 'and that point stands at the surface it snapped to');

    useViewerStore.getState().startCommand('railing.place');
    click(0, 2, meshEdge(0, 2, 0));
    click(4, 2, meshEdge(4, 2, 3));
    doubleClick(4, 5);
    const sloped = railPath(created('IFCRAILING')[1]);
    assert.deepEqual(sloped.map((p) => round(p[2] - 0.975)), [0, 3, 3], 'up a stair side, then level along the landing');
  });

  it('the free points before the first snap take its height: a path that meets its first slab corner third is level from the start', () => {
    useViewerStore.getState().startCommand('railing.place');
    click(0, 0);
    click(3, 0);
    click(6, 0, meshEdge(6, 0, 0.3));
    doubleClick(6, 3);
    const [railing] = created('IFCRAILING');
    assert.deepEqual(railPath(railing).map((p) => round(p[2])), [0.975, 0.975, 0.975, 0.975]);
  });

  it('an edge far below the plane (the ground) or far above it (a roof) is not something the rail sits on', () => {
    useViewerStore.getState().startCommand('railing.place');
    click(0, 0, meshEdge(0, 0, -2.7));
    click(4, 0, meshEdge(4, 0, 7.5));
    doubleClick(8, 0);
    const [railing] = created('IFCRAILING');
    assert.deepEqual(railPath(railing).map((p) => round(p[2])), [0.975, 0.975, 0.975]);
    const view = live().view;
    const location = point(view, deref(view, deref(view, view.getNewEntity(railing)!.attributes[5]).attributes[1]).attributes[0]);
    assert.equal(location[2], 0);
  });

  it('a face under the cursor does not lift the path; a lone click finishes nothing', () => {
    useViewerStore.getState().startCommand('railing.place');
    click(0, 0, { kind: 'face', local: [0, 0], elevation: 2, source: 'mesh' });
    doubleClick(0, 0);
    assert.deepEqual(created('IFCRAILING'), [], 'one point is not a railing');
    click(3, 0, { kind: 'face', local: [3, 0], elevation: 2, source: 'mesh' });
    doubleClick(3, 0);
    const placement = created('IFCRAILING');
    assert.equal(placement.length, 1);
    const view = live().view;
    const location = point(view, deref(view, deref(view, view.getNewEntity(placement[0])!.attributes[5]).attributes[1]).attributes[0]);
    assert.equal(location[2], 0, 'a face is not a target to sit on');
  });
});

describe('the rail, keys, palette and bar (#6232 D1)', () => {
  it('Stair and Railing have a rail row, a chord of their own and a palette row', () => {
    for (const [id, key] of [['stair.place', 'model.stair'], ['railing.place', 'model.railing']] as const) {
      const row = RAIL_TOOLS.find((tool) => tool.id === id);
      assert.ok(row, `${id} has a rail row`);
      assert.equal(row.shortcut, key);
      assert.ok(KEY_COMMANDS.some((command) => command.id === key && command.when === 'workspace.model'), `${key} is a workspace key`);
      assert.ok(TOOL_SURFACE_COMMANDS.some((command) => 'shortcut' in command && command.shortcut === key), `${key} is in the palette`);
    }
    const chords = KEY_COMMANDS.filter((c) => c.id === 'model.stair' || c.id === 'model.railing').flatMap((c) => c.keys);
    for (const chord of chords) {
      const clashes = KEY_COMMANDS.filter((c) => c.when === 'workspace.model' && c.keys.some((k) => JSON.stringify(k) === JSON.stringify(chord)));
      assert.equal(clashes.length, 1, `${chord.key} is bound once in the workspace`);
    }
  });

  it('the rail row starts the command from the workspace, and Shift+T / Shift+L do too', () => {
    const row = RAIL_TOOLS.find((tool) => tool.id === 'stair.place')!;
    act(() => { row.run(); });
    assert.equal(useViewerStore.getState().session?.activeCommandId, 'stair.place');
    useViewerStore.getState().endCommand('cancel');
    act(() => { RAIL_TOOLS.find((tool) => tool.id === 'railing.place')!.run(); });
    assert.equal(useViewerStore.getState().session?.activeCommandId, 'railing.place');
  });

  it('the stair bar says how many risers climb to which storey; the railing bar counts points and length, and Finish places it', () => {
    useViewerStore.getState().startCommand('stair.place');
    const stair = render(<CommandBarContent tier={0} />);
    assert.match(stair.querySelector('[data-stair-summary]')!.textContent!, /^17 risers · up to L1$/);
    cleanup();

    useViewerStore.getState().startCommand('railing.place');
    click(0, 0);
    click(3, 0);
    const bar = render(<CommandBarContent tier={0} />);
    assert.match(bar.querySelector('[data-railing-summary]')!.textContent!, /^2 points · 3(\.0+)? ?m$/);
    const finish = [...bar.querySelectorAll('button')].find((b) => b.textContent === 'Finish') as HTMLButtonElement;
    act(() => { finish.click(); });
    assert.equal(created('IFCRAILING').length, 1, 'Finish is Enter for touch users');
  });
});

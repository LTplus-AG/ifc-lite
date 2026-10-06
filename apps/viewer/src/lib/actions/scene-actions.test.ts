/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseSceneActions, SCENE_ACTION_OUTPUT_GUIDANCE, SCENE_TARGET_LIMIT } from './scene-actions';

const W1 = '0Wall00000000000000101';
const set = (actions: unknown[], extra: Record<string, unknown> = {}) =>
  JSON.stringify({ version: 1, kind: 'scene.actions', title: 'Show failing', actions, ...extra });

// #6907: the contract is strict and bounded; every refusal names what to fix.
test('parses every action type, fenced answers and the "color" spelling, normalising duplicates away', () => {
  const parsed = parseSceneActions('```json\n' + set([
    { type: 'select', targets: [{ globalId: W1 }, { globalId: W1 }] },
    { type: 'isolate', targets: [{ citation: 'E1' }, { globalId: W1, modelId: 'm' }] },
    { type: 'hide', targets: [{ citation: 'E2' }] },
    { type: 'color', groups: [{ label: 'Failing', color: 'red', targets: [{ citation: 'E1' }] }, { label: 'Passing', colour: 'green', targets: [{ citation: 'E3' }] }] },
    { type: 'frame', targets: [{ citation: 'E1' }] },
    { type: 'section', units: 'mm', plane: { origin: [0, 0, 1200], normal: [0, 0, 1] } },
  ], { rationale: 'Because' }) + '\n```');
  assert.equal(parsed.actions.length, 6);
  assert.deepEqual(parsed.actions[0], { type: 'select', targets: [{ globalId: W1 }] }, 'a repeated target is dropped, not reinterpreted');
  assert.equal(parsed.actions[3].type, 'colour');
  assert.equal(parsed.rationale, 'Because');
  const box = parseSceneActions(set([{ type: 'section', units: 'm', box: { min: [0, 0, 0], max: [1, 2, 3] } },
    { type: 'camera', units: 'ft', eye: [10, 10, 10], target: [0, 0, 0] }]));
  assert.deepEqual(box.actions.map(a => a.type), ['section', 'camera']);
});

test('refuses malformed sets with an actionable reason', () => {
  const refusals: Array<[string, RegExp]> = [
    ['{"version":1', /not valid JSON/],
    [JSON.stringify({ version: 2, kind: 'scene.actions', title: 'x', actions: [] }), /Not a scene action set/],
    [set([]), /at least one action/],
    [set([{ type: 'select', targets: [{ globalId: 'short' }] }]), /22-character IFC GlobalId/],
    [set([{ type: 'select', targets: [] }]), /at least one target/],
    [set([{ type: 'select', targets: [{ citation: 'row 1' }] }]), /look like E1/],
    [set([{ type: 'select', targets: [{ citation: 'E1', globalId: W1 }] }]), /either a GlobalId or a citation/],
    [set([{ type: 'select', targets: Array.from({ length: SCENE_TARGET_LIMIT + 1 }, (_, i) => ({ citation: `E${(i % 9000) + 1}` })) }]), /at most 2000 targets/],
    [set([{ type: 'paint', targets: [{ citation: 'E1' }] }]), /unsupported type/],
    [set([{ type: 'colour', groups: [{ label: 'A', colour: '#ff0000', targets: [{ citation: 'E1' }] }] }]), /colour must be one of red/],
    [set([{ type: 'colour', groups: [{ label: 'A', colour: 'red', targets: [{ citation: 'E1' }] }, { label: 'B', colour: 'red', targets: [{ citation: 'E2' }] }] }]), /reuses red/],
    [set([{ type: 'section', plane: { origin: [0, 0, 0], normal: [0, 0, 1] } }]), /must state units/],
    [set([{ type: 'section', units: 'm', plane: { origin: [0, 0, 0], normal: [0, 0, 0] } }]), /normal must not be zero/],
    [set([{ type: 'section', units: 'm', plane: { origin: [0, 0, 'NaN'], normal: [0, 0, 1] } }]), /finite numbers/],
    [set([{ type: 'section', units: 'm', plane: { origin: [0, 0, 1e12], normal: [0, 0, 1] } }]), /out of range/],
    [set([{ type: 'section', units: 'm', box: { min: [0, 0, 0], max: [1, 0, 1] } }]), /min must be below max/],
    [set([{ type: 'section', units: 'm', box: { min: [0, 0, 0], max: [1, 1, 1] }, plane: { origin: [0, 0, 0], normal: [0, 0, 1] } }]), /exactly one of plane or box/],
    [set([{ type: 'camera', units: 'm', eye: [1, 1, 1], target: [1, 1, 1] }]), /eye and target must differ/],
    [set([{ type: 'frame', targets: [{ citation: 'E1' }] }, { type: 'camera', units: 'm', eye: [1, 1, 1], target: [0, 0, 0] }]), /either frame or camera/],
    [set([{ type: 'hide', targets: [{ citation: 'E1' }] }, { type: 'hide', targets: [{ citation: 'E2' }] }]), /only one of each/],
  ];
  for (const [answer, reason] of refusals) assert.throws(() => parseSceneActions(answer), reason, answer.slice(0, 80));
});

test('provider guidance names the declared kind, every action type and the coordinate convention', () => {
  for (const word of ['"kind":"scene.actions"', 'select', 'isolate', 'hide', 'colour', 'frame', 'section', 'camera', 'Z up', 'units']) {
    assert.ok(SCENE_ACTION_OUTPUT_GUIDANCE.includes(word), word);
  }
});

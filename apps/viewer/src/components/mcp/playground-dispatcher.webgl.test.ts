/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The playground agent tools on a device with no WebGL context (#2412).
 *
 * #2401 stopped the missing context from taking the whole `/mcp` page down,
 * and left the panel painting a fallback. What it did not do is tell the
 * AGENT, and the agent is what drives these tools. Every viewer answer was
 * written for a viewer that is merely not ready yet:
 *
 *   viewer_open    "Geometry is processing — call viewer_status in a moment"
 *   viewer_status  "Viewer panel mounted but no geometry yet."
 *   everything else "Viewer is not open. Call viewer_open first."
 *
 * Each one points at the next, and on this device none of them can ever come
 * true, so the model ping-pongs until the user gives up. These tests pin the
 * exit: once three.js has refused a context, every viewer tool says so
 * TERMINALLY — no "in a moment", no "try again", no reload.
 *
 * Two independent sources have to work, because the loop has two shapes:
 *   • a mounted controller reporting `webglUnavailable`, and
 *   • the session latch alone, with NO controller attached — which is the
 *     state `McpPlayground` is in whenever the panel is collapsed, since it
 *     unmounts `PlaygroundViewer` and nulls the ref.
 *
 * The latch is driven through the production entry point (`startThreeScene`
 * with a factory that throws three's own context error), not by poking module
 * state, so "the verdict is latched" is measured the way production reaches it.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { ToolErrorCode } from '@ifc-lite/mcp/browser';
import {
  dispatch,
  parsePlaygroundModel,
  type DispatchContext,
  type LoadedPlaygroundModel,
} from './playground-dispatcher.js';
import type { ViewerController, SelectionHit } from './playground-viewer-types.js';
import { startThreeScene, resetThreeWebglSupportForTests } from './three-webgl-support.js';

/** Words that keep an agent in the loop. None may appear in a terminal answer. */
const RETRY_VOCABULARY = ['in a moment', 'moment', 'shortly', 'try again', 'reload', 'wait', 'processing', 'not ready', 'yet'];

function assertTerminal(text: string, label: string): void {
  const lower = text.toLowerCase();
  for (const word of RETRY_VOCABULARY) {
    assert.equal(lower.includes(word), false, `${label} must not tell the agent to ${word}: ${text}`);
  }
  assert.equal(lower.includes('webgl'), true, `${label} must name the actual cause: ${text}`);
}

/**
 * A viewer controller whose three states are all expressible.
 *
 * Deliberately a switchable record rather than a "broken viewer" stub: a fake
 * that can only say `webglUnavailable: true` would make every assertion below
 * pass no matter what the dispatcher does. The control tests at the bottom
 * drive the OTHER two states through the same fake, so its ability to produce
 * a passing viewer and a still-loading viewer is proven, not assumed.
 */
function fakeViewer(state: {
  loaded: boolean;
  webglUnavailable: boolean;
  selection?: SelectionHit[];
}): ViewerController & { calls: string[] } {
  const calls: string[] = [];
  const record = <T>(name: string, value: T): T => {
    calls.push(name);
    return value;
  };
  return {
    calls,
    isLoaded: () => state.loaded,
    status: () => ({
      loaded: state.loaded,
      meshCount: state.loaded ? 7 : 0,
      selection: state.selection ?? [],
      webglUnavailable: state.webglUnavailable,
    }),
    colorize: () => record('colorize', { count: 3 }),
    isolate: () => record('isolate', { count: 2 }),
    hide: () => record('hide', { count: 1 }),
    show: () => record('show', { count: 1 }),
    reset: () => { calls.push('reset'); },
    flyTo: () => record('flyTo', { count: 1 }),
    setSection: () => { calls.push('setSection'); },
    clearSection: () => { calls.push('clearSection'); },
    colorByStorey: () => record('colorByStorey', { groups: 2 }),
    colorByProperty: () => record('colorByProperty', { legend: [] }),
    getSelection: () => record('getSelection', state.selection ?? []),
    setOnSelectionChange: () => { calls.push('setOnSelectionChange'); },
    subscribeSelection: () => {
      calls.push('subscribeSelection');
      return () => undefined;
    },
  };
}

/** Stands in for the container React hands the scene factory. */
const CONTAINER = {} as HTMLElement;

/**
 * Latch the session verdict the way production does: three's constructor throws
 * its context error, `startThreeScene` recognises it and marks the gate.
 *
 * (The probe path would need a DOM; this one is the failure actually seen in
 * the field on the playground, and it exercises the same latch.)
 */
function latchNoWebgl(): void {
  const started = startThreeScene(CONTAINER, () => {
    throw new Error('THREE.WebGLRenderer: Error creating WebGL context.');
  });
  assert.equal(started.ok, false, 'precondition: the scene must have failed to start');
}

/**
 * One parse for the file: none of these tools touch geometry or mutate the
 * model, and re-parsing per test would only pay the WASM boot again.
 */
let model: LoadedPlaygroundModel;
let parsed: Promise<LoadedPlaygroundModel> | null = null;

beforeEach(async () => {
  resetThreeWebglSupportForTests();
  if (!parsed) {
    const ifc = [
      'ISO-10303-21;', 'HEADER;', "FILE_DESCRIPTION((''),'2;1');",
      "FILE_NAME('','',(''),(''),'','','');", "FILE_SCHEMA(('IFC4'));", 'ENDSEC;',
      // 22 characters: an IfcGloballyUniqueId is a base64-encoded UUID, and a
      // fixture with a short one is what the next fixture gets copied from.
      'DATA;', "#1=IFCWALL('2412WebglLoopFixture00',$,'Wall A',$,$,$,$,$,.STANDARD.);", 'ENDSEC;',
      'END-ISO-10303-21;', '',
    ].join('\n');
    const bytes = new TextEncoder().encode(ifc);
    parsed = parsePlaygroundModel(bytes.buffer as ArrayBuffer, 'webgl-loop.ifc');
  }
  model = await parsed;
});

afterEach(() => {
  resetThreeWebglSupportForTests();
});

describe('viewer tools on a device that refuses WebGL (#2412)', () => {
  it('answers viewer_open terminally instead of promising geometry is processing', async () => {
    latchNoWebgl();
    let opened = 0;
    const ctx: DispatchContext = {
      viewer: fakeViewer({ loaded: false, webglUnavailable: true }),
      openViewerPanel: () => { opened += 1; },
    };

    const res = await dispatch(model, 'viewer_open', {}, ctx);

    assertTerminal(res.text, 'viewer_open');
    assert.equal((res.structured as { open: boolean }).open, false);
    assert.equal(opened, 0, 'must not re-open a panel that can only paint its fallback');
  });

  it('answers viewer_status terminally instead of "mounted but no geometry yet"', async () => {
    latchNoWebgl();
    const ctx: DispatchContext = { viewer: fakeViewer({ loaded: false, webglUnavailable: true }) };

    const res = await dispatch(model, 'viewer_status', {}, ctx);

    assertTerminal(res.text, 'viewer_status');
    assert.equal((res.structured as { webglUnavailable: boolean }).webglUnavailable, true);
  });

  it('answers viewer_ask terminally instead of spending a user turn on consent', async () => {
    latchNoWebgl();
    const ctx: DispatchContext = { viewer: fakeViewer({ loaded: false, webglUnavailable: true }) };

    const res = await dispatch(model, 'viewer_ask', { reason: 'highlight the walls' }, ctx);

    assertTerminal(res.text, 'viewer_ask');
    assert.equal((res.structured as { suggestedTool: string | null }).suggestedTool, null,
      'suggesting viewer_open here is what closes the loop');
  });

  it('fails every action tool terminally instead of sending the agent back to viewer_open', async () => {
    latchNoWebgl();
    const ctx: DispatchContext = { viewer: fakeViewer({ loaded: false, webglUnavailable: true }) };

    // The whole requireViewer family, not one representative: the reported arm
    // was ONE of these and the rest share the message verbatim.
    for (const tool of [
      'viewer_colorize', 'viewer_isolate', 'viewer_hide', 'viewer_show', 'viewer_reset',
      'viewer_fly_to', 'viewer_set_section', 'viewer_clear_section', 'viewer_color_by_storey',
      'viewer_color_by_property', 'viewer_get_selection', 'viewer_describe_selection',
    ]) {
      const res = await dispatch(model, tool, { type: 'IfcWall', color: '#ff0000', property: 'Name' }, ctx);
      assert.equal(res.isError, true, `${tool} must fail`);
      assert.equal(res.errorCode, ToolErrorCode.UNSUPPORTED_OPERATION, `${tool} error code`);
      assertTerminal(res.text, tool);
      assert.equal(res.text.includes('viewer_open'), false, `${tool} must not point back at viewer_open`);
    }
  });

  it('refuses viewer_wait_for_selection immediately instead of blocking on a canvas nobody can click', async () => {
    latchNoWebgl();
    const ctx: DispatchContext = { viewer: fakeViewer({ loaded: false, webglUnavailable: true }) };

    const t0 = Date.now();
    const res = await dispatch(model, 'viewer_wait_for_selection', { timeout_ms: 60_000 }, ctx);

    assert.equal(res.isError, true);
    assertTerminal(res.text, 'viewer_wait_for_selection');
    assert.ok(Date.now() - t0 < 2_000, 'must not sit through its timeout waiting for a click that cannot happen');
  });

  it('stays terminal with NO controller attached — the collapsed-panel shape of the same loop', async () => {
    // `McpPlayground` unmounts `PlaygroundViewer` when the panel collapses, so
    // `ctx.viewer` is null again and the controller flag is gone. Only the
    // session latch remembers, and it must be enough on its own.
    latchNoWebgl();
    const ctx: DispatchContext = { viewer: null, openViewerPanel: () => undefined };

    const status = await dispatch(model, 'viewer_status', {}, ctx);
    assertTerminal(status.text, 'viewer_status (no controller)');

    const open = await dispatch(model, 'viewer_open', {}, ctx);
    assertTerminal(open.text, 'viewer_open (no controller)');

    const isolate = await dispatch(model, 'viewer_isolate', { type: 'IfcWall' }, ctx);
    assert.equal(isolate.isError, true);
    assertTerminal(isolate.text, 'viewer_isolate (no controller)');
  });

  it('leaves viewer_close answerable — it is not an arm of the loop (#2436 review)', async () => {
    // The one viewer tool deliberately left alone, pinned so the decision is
    // not re-litigated. It reads no viewer state, never claims success
    // (`closed: false`), and points at the USER rather than another viewer
    // tool. What it describes still works here: `ViewerPanel` renders its
    // toggle button outside the `open &&` branch, so the chevron exists with
    // or without a context, and collapsing a panel showing the degraded
    // fallback is a real thing to want. This test fails if someone later makes
    // it route back into viewer_open/viewer_status, which WOULD be a loop arm.
    latchNoWebgl();
    const ctx: DispatchContext = { viewer: fakeViewer({ loaded: false, webglUnavailable: true }) };

    const res = await dispatch(model, 'viewer_close', {}, ctx);

    assert.equal(res.isError, false, 'hiding a panel is not blocked by a missing GPU');
    // The load-bearing pair: without these the review's proposed change (return
    // NO_WEBGL_MESSAGE here) passes this test, which would make it a test that
    // cannot fail on the only axis it exists for. Verified by mutation.
    assert.equal(res.text.toLowerCase().includes('webgl'), false,
      'the device verdict is not an answer to "hide the panel" — the user can still collapse it');
    assert.equal((res.structured as { note: string }).note, 'user-toggle',
      'the agent must still learn who owns the panel');
    assert.equal((res.structured as { closed: boolean }).closed, false, 'it must not claim to have closed anything');
    assert.equal(res.text.includes('viewer_open'), false, 'routing back to viewer_open would make this a loop arm');
    assert.equal(res.text.includes('viewer_status'), false, 'same for viewer_status');
    assert.equal(res.text.toLowerCase().includes('canvas'), false, 'there is no canvas on this device to point at');
  });

  it('stays terminal with NO latch — a controller that reports the refusal is enough on its own', async () => {
    // The mirror of the case above: the two sources are ORed, so neither may
    // be load-bearing for the other's scenario.
    const ctx: DispatchContext = { viewer: fakeViewer({ loaded: false, webglUnavailable: true }) };

    const res = await dispatch(model, 'viewer_colorize', { type: 'IfcWall', color: '#ff0000' }, ctx);

    assert.equal(res.isError, true);
    assertTerminal(res.text, 'viewer_colorize (controller only)');
  });
});

describe('the WebGL-capable paths this must not disturb (#2412 controls)', () => {
  it('still tells the agent to call viewer_open when the panel is merely closed', async () => {
    // The pre-existing state, through the same fake: not loaded, but nothing
    // has refused a context. This answer SHOULD point at viewer_open — turning
    // it terminal would be its own dead end, on a device where 3D works.
    const ctx: DispatchContext = { viewer: fakeViewer({ loaded: false, webglUnavailable: false }) };

    const res = await dispatch(model, 'viewer_isolate', { type: 'IfcWall' }, ctx);

    assert.equal(res.isError, true);
    assert.equal(res.errorCode, ToolErrorCode.UNSUPPORTED_OPERATION);
    assert.ok(res.text.includes('viewer_open'), `the closed-panel answer must still route to viewer_open: ${res.text}`);
    assert.equal(res.text.toLowerCase().includes('webgl'), false, 'a closed panel is not a device refusal');
  });

  it('still reports a mounted, loaded viewer as ready', async () => {
    const viewer = fakeViewer({ loaded: true, webglUnavailable: false });
    const ctx: DispatchContext = { viewer };

    const status = await dispatch(model, 'viewer_status', {}, ctx);
    assert.ok(status.text.includes('7 meshes'), `expected the live status line, got: ${status.text}`);
    assert.equal((status.structured as { loaded: boolean }).loaded, true);

    const colorize = await dispatch(model, 'viewer_colorize', { type: 'IfcWall', color: '#ff0000' }, ctx);
    assert.equal(colorize.isError, false);
    assert.ok(viewer.calls.includes('colorize'), 'the working path must still reach the controller');
  });

  it('still opens the panel on a device whose verdict is simply unknown', async () => {
    // Nothing has probed yet (the panel has never been expanded). `viewer_open`
    // has real work to do here and must not be short-circuited.
    let opened = 0;
    const ctx: DispatchContext = { viewer: null, openViewerPanel: () => { opened += 1; } };

    const res = await dispatch(model, 'viewer_open', {}, ctx);

    assert.equal(opened, 1, 'an unknown verdict must still mount the panel');
    assert.equal((res.structured as { open: boolean }).open, true);
  });
});

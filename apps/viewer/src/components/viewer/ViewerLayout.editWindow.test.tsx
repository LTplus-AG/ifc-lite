/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #10535: renderer-first edits. A loaded-column move on the F5 tower re-rendered
 * every mounted panel inside the edit's own task, before the re-mesh reply
 * could be handled. While an edit is in flight only the viewport (the live
 * scope) may render; panels follow once the edit settles, and converge on the
 * same state, undo included. A user's input publishes the held state before
 * any handler runs.
 *
 * The census counts the component fibers each React commit actually rendered,
 * through the DevTools hook, which must exist before react-dom loads; every
 * module that loads react-dom is therefore imported after it.
 */

import '@/test/setup-dom.js';
(globalThis as unknown as { __APP_VERSION__: string }).__APP_VERSION__ = '0.0.0-test';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';

interface Fiber { tag: number; flags: number; type: unknown; child: Fiber | null; sibling: Fiber | null; return: Fiber | null }
const COMPONENT_TAGS = new Set([0, 1, 11, 14, 15]); // function, class, forwardRef, memo, simple memo
const PERFORMED_WORK = 1;
const nameOf = (fiber: Fiber): string => {
  const type = fiber.type as { displayName?: string; name?: string; render?: { name?: string }; type?: { name?: string } } | null;
  return type?.displayName ?? type?.name ?? type?.render?.name ?? type?.type?.name ?? '?';
};

/** Names of the components a commit rendered outside a `LiveViewerScope`, while `recording`. */
const census = { recording: false, outside: new Set<string>(), previous: new WeakSet<Fiber>() };
(globalThis as unknown as { __REACT_DEVTOOLS_GLOBAL_HOOK__: unknown }).__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
  supportsFiber: true, renderers: new Map(), inject: () => 1, checkDCE: () => undefined,
  onScheduleFiberRoot: () => undefined, onCommitFiberUnmount: () => undefined, onPostCommitFiberRoot: () => undefined,
  onCommitFiberRoot(_id: number, root: { current: Fiber }) {
    const seen = new WeakSet<Fiber>();
    const stack: Array<{ fiber: Fiber; live: boolean }> = [{ fiber: root.current, live: false }];
    while (stack.length > 0) {
      const { fiber, live } = stack.pop()!;
      seen.add(fiber);
      const isComponent = COMPONENT_TAGS.has(fiber.tag);
      const name = isComponent ? nameOf(fiber) : '';
      // A fiber this commit did not visit is the same object as last time; a visited one did work.
      if (census.recording && isComponent && !live && !census.previous.has(fiber) && (fiber.flags & PERFORMED_WORK)) census.outside.add(name);
      const childLive = live || name === 'LiveViewerScope';
      if (fiber.sibling) stack.push({ fiber: fiber.sibling, live });
      if (fiber.child) stack.push({ fiber: fiber.child, live: childLive });
    }
    census.previous = seen;
  },
};

const { act, useState } = await import('react');
const { MutablePropertyView } = await import('@ifc-lite/mutations');
const { PropertyValueType } = await import('@ifc-lite/data');
const { advance, cleanup, click, mouseDown, press, render, type } = await import('@/test/render.js');
const { installManualFrames } = await import('@/test/manual-frames');
const { renderViewerLayout } = await import('@/test/viewer-layout-harness.js');
const { useViewerStore } = await import('@/store');
const { formFactorState } = await import('@/test/form-factor-state');
const { fixtureModel, fixtureModels } = await import('@/test/store-fixture.js');
const { replayWorkspaceHistory } = await import('@/lib/model-placement/history');
const { requestRemesh } = await import('@/lib/remesh/remesh-service');
type FederatedModel = import('@/store/types').FederatedModel;
type ManualFrames = import('@/test/manual-frames').ManualFrames;

const MODEL_ID = 'model-a';
/** Two frames and the settle task, with margin. */
const SETTLE_MS = 80;

function model(): FederatedModel {
  return {
    id: MODEL_ID, name: `${MODEL_ID}.ifc`, ifcDataStore: null, geometryResult: null, visible: true, collapsed: false,
    schemaVersion: 'IFC4', loadedAt: 1, fileSize: 3, idOffset: 0, maxExpressId: 0,
  };
}

/** What a panel outside the viewport sees through the `useViewerStore` hook. */
const panelSees: { version: number; selected: number | null } = { version: -1, selected: null };
function PanelProbe() {
  panelSees.version = useViewerStore((s) => s.mutationVersion);
  panelSees.selected = useViewerStore((s) => s.selectedEntityId);
  return null;
}

/** An edit as the store publishes one: a change in the session's overlay and a new mutationVersion. */
function edit(view: InstanceType<typeof MutablePropertyView>, value: string): void {
  view.setProperty(1, 'Pset_WallCommon', 'FireRating', value, PropertyValueType.Label);
  useViewerStore.setState((s) => ({ mutationViews: new Map([[MODEL_ID, view]]), mutationVersion: s.mutationVersion + 1 }));
}

/** Close a hand-run window, so a failed assertion leaves nothing open for the next test. */
async function closeFrames(frames: ManualFrames): Promise<void> {
  frames.flush();
  frames.restore();
  await advance(0);
}

/** One frame by hand, then the task after it; the store queues its frame from a microtask. */
function frameStepper(frames: ManualFrames): () => Promise<void> {
  return () => act(async () => {
    await Promise.resolve();
    frames.step();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

describe('renderer-first edit window (#10535)', () => {
  beforeEach(async () => {
    useViewerStore.setState({
      models: new Map([[MODEL_ID, model()]]), ...formFactorState(false),
      leftPanelCollapsed: false, rightPanelCollapsed: false, mutationViews: new Map(), mutationVersion: 0,
      selectedEntityId: null, georefMutations: new Map(), scheduleData: null, scheduleIsEdited: false, scheduleSourceModelId: null,
    });
    await advance(SETTLE_MS);
  });
  afterEach(() => {
    cleanup();
    useViewerStore.setState({ models: new Map(), mutationViews: new Map(), selectedEntityId: null });
  });

  it('renders no panel inside an edit, then converges panels on the edited state', async () => {
    renderViewerLayout();
    render(<PanelProbe />);
    await advance(SETTLE_MS); // mount effects and their follow-up commits
    const view = new MutablePropertyView(null, MODEL_ID);

    census.outside.clear();
    census.recording = true;
    act(() => edit(view, 'REI60'));
    census.recording = false;
    assert.deepEqual([...census.outside], [], 'only the live viewport renders while the edit is in flight');
    assert.equal(panelSees.version, 0, 'panels keep the pre-edit state inside the edit');

    // A selection made while the edit is in flight is held with it.
    act(() => useViewerStore.setState({ selectedEntityId: 7 }));
    assert.equal(panelSees.selected, null);

    await advance(SETTLE_MS);
    const live = useViewerStore.getState();
    assert.equal(panelSees.version, live.mutationVersion, 'panels converge on the edited state');
    assert.equal(panelSees.selected, 7, 'and on the selection made meanwhile');
  });

  it('a panel rerender during a hold reads the previously published IFC property', () => {
    const view = new MutablePropertyView(null, MODEL_ID);
    view.setProperty(1, 'Pset_WallCommon', 'FireRating', 'REI30', PropertyValueType.Label);
    useViewerStore.setState({ mutationViews: new Map([[MODEL_ID, view]]) });
    function PropertyProbe() {
      const current = useViewerStore((s) => s.mutationViews.get(MODEL_ID));
      const [rerendered, setRerendered] = useState(false);
      return <button type="button" onClick={() => setRerendered(true)}>
        {rerendered ? 'rerendered' : 'initial'} {current?.getPropertyValue(1, 'Pset_WallCommon', 'FireRating')}
      </button>;
    }
    const ui = render(<PropertyProbe />);
    const button = ui.querySelector('button')!;
    assert.match(button.textContent ?? '', /initial REI30/);
    act(() => edit(view, 'REI60'));
    click(button, { detail: 1 });
    assert.match(button.textContent ?? '', /rerendered REI30/);
  });

  it('a panel rerender via getMutationView reads the previously published IFC property', () => {
    const view = new MutablePropertyView(null, MODEL_ID);
    view.setProperty(1, 'Pset_WallCommon', 'FireRating', 'REI30', PropertyValueType.Label);
    useViewerStore.setState({ mutationViews: new Map([[MODEL_ID, view]]) });
    function PropertyProbe() {
      const current = useViewerStore((s) => s.getMutationView(MODEL_ID));
      const [rerendered, setRerendered] = useState(false);
      return <button type="button" onClick={() => setRerendered(true)}>
        {rerendered ? 'rerendered' : 'initial'} {current?.getPropertyValue(1, 'Pset_WallCommon', 'FireRating')}
      </button>;
    }
    const ui = render(<PropertyProbe />);
    const button = ui.querySelector('button')!;
    assert.match(button.textContent ?? '', /initial REI30/);
    act(() => edit(view, 'REI60'));
    click(button, { detail: 1 });
    assert.match(button.textContent ?? '', /rerendered REI30/);
  });

  it('a panel rerender after an authored mesh append keeps the published mesh list', async () => {
    const mesh = (expressId: number): import('@ifc-lite/geometry').MeshData => ({
      expressId, positions: new Float32Array(9), indices: new Uint32Array([0, 1, 2]),
      normals: new Float32Array(9), color: [1, 1, 1, 1],
    });
    const append = (id: number) => useViewerStore.getState().appendGeometryBatch(MODEL_ID, [mesh(id)]);
    append(1);
    function MeshProbe() {
      const geometry = useViewerStore((s) => s.models.get(MODEL_ID)?.geometryResult);
      const [rerendered, setRerendered] = useState(false);
      return <button type="button" onClick={() => setRerendered(true)}>
        {rerendered ? 'rerendered' : 'initial'} {geometry?.meshes.map(({ expressId }) => expressId).join(',')}
      </button>;
    }
    const ui = render(<MeshProbe />);
    const button = ui.querySelector('button')!;
    assert.equal(button.textContent, 'initial 1');
    act(() => {
      edit(new MutablePropertyView(null, MODEL_ID), 'REI60');
      append(2);
    });
    click(button, { detail: 1 });
    assert.equal(button.textContent, 'rerendered 1');
    await advance(SETTLE_MS);
    assert.equal(button.textContent, 'rerendered 1,2');
  });

  it('publishes the session reset during primary model replacement without waiting for a frame', () => {
    render(<PanelProbe />);
    const version = panelSees.version;
    try {
      act(() => useViewerStore.getState().setLoading(true));
      act(() => useViewerStore.getState().resetViewerState({ preserveLoading: true }));
      assert.equal(panelSees.version, version + 1, 'the shell sees the reset in the same task as the viewport');
    } finally {
      act(() => useViewerStore.getState().setLoading(false));
    }
  });

  it('undo and redo converge too', async () => {
    const wall = fixtureModel(MODEL_ID, { entities: [{ expressId: 1, type: 'IfcWall', name: 'Wall 1' }] });
    wall.maxExpressId = 1;
    const view = new MutablePropertyView(null, MODEL_ID);
    useViewerStore.setState({
      ...fixtureModels(wall), mutationViews: new Map([[MODEL_ID, view]]), undoStacks: new Map(), redoStacks: new Map(),
      mutationBatchTags: new Map(), dirtyModels: new Set(), mutationVersion: 0, collabRole: null, editEnabled: true,
    });
    render(<PanelProbe />);
    await advance(SETTLE_MS);
    const value = () => view.getPropertyValue(1, 'Pset_WallCommon', 'FireRating');

    act(() => { useViewerStore.getState().setProperty(MODEL_ID, 1, 'Pset_WallCommon', 'FireRating', 'REI60', PropertyValueType.Label); });
    await advance(SETTLE_MS);
    assert.equal(value(), 'REI60');
    assert.equal(panelSees.version, useViewerStore.getState().mutationVersion);

    const edited = panelSees.version;
    act(() => { replayWorkspaceHistory(useViewerStore.getState(), 'undo'); });
    assert.equal(value(), null, 'undo applies at once');
    assert.equal(panelSees.version, edited, 'and reaches panels when it settles');
    await advance(SETTLE_MS);
    assert.equal(panelSees.version, useViewerStore.getState().mutationVersion);

    act(() => { replayWorkspaceHistory(useViewerStore.getState(), 'redo'); });
    assert.equal(value(), 'REI60', 'redo applies at once');
    await advance(SETTLE_MS);
    assert.equal(panelSees.version, useViewerStore.getState().mutationVersion);
  });

  it('an overlay layer registered inside an edit reaches the renderer at once', async () => {
    renderViewerLayout();
    await advance(SETTLE_MS);
    act(() => edit(new MutablePropertyView(null, MODEL_ID), 'REI45'));
    try {
      act(() => useViewerStore.getState().registerOverlayLayer({ id: 'edit-window-test', priority: 1, hiddenIds: new Set([9]), colorOverrides: null }));
      assert.equal(useViewerStore.getState().hiddenEntities.has(9), true, 'the compositor follows the scene, not the panels');
    } finally {
      act(() => useViewerStore.getState().removeOverlayLayer('edit-window-test'));
    }
  });

  it('typing while an edit is held keeps every character', async () => {
    const typed: string[] = [];
    function Field() {
      const [value, setValue] = useState('');
      const version = useViewerStore((s) => s.mutationVersion);
      return <input aria-label="field" data-version={version} value={value} onChange={(e) => { typed.push(e.target.value); setValue(e.target.value); }} />;
    }
    const container = render(<Field />);
    const field = container.querySelector('input')!;
    act(() => edit(new MutablePropertyView(null, MODEL_ID), 'REI30'));
    type(field, 'abc');
    assert.deepEqual(typed, ['abc'], 'the input event reaches the handler');
    assert.equal(field.value, 'abc');
    await advance(SETTLE_MS);
    assert.equal(field.value, 'abc', 'the edit settling does not overwrite it');
  });

  it('a control whose own change is an edit keeps its new value', () => {
    function Toggle() {
      const on = useViewerStore((s) => s.mutationVersion % 2 === 1);
      return <input type="checkbox" aria-label="toggle" checked={on}
        onChange={() => useViewerStore.setState((s) => ({ mutationVersion: s.mutationVersion + 1 }))} />;
    }
    const container = render(<Toggle />);
    const box = container.querySelector('input')!;
    assert.equal(box.checked, false);
    act(() => { box.click(); });
    assert.equal(box.checked, true, 'the edit the control made is published with it, not held');
  });

  it('a key press inside an edit publishes the held state before any handler reads it', () => {
    render(<PanelProbe />);
    const view = new MutablePropertyView(null, MODEL_ID);
    act(() => edit(view, 'REI90'));
    assert.equal(panelSees.version, 0);
    press(window, 'z', { ctrlKey: true });
    assert.equal(panelSees.version, useViewerStore.getState().mutationVersion);
  });

  it('a second edit inside the window gets its own frames; the first edit\'s close cannot publish it early', async () => {
    render(<PanelProbe />);
    const view = new MutablePropertyView(null, MODEL_ID);
    const frames = installManualFrames();
    const frame = frameStepper(frames);
    try {
      act(() => edit(view, 'REI30'));
      await frame(); // the first edit's close is one frame in
      act(() => edit(view, 'REI60'));
      await frame(); // where the first edit's close publishes
      assert.equal(panelSees.version, 0, 'the second edit has had one frame, not its two');
      await frame();
      assert.equal(panelSees.version, useViewerStore.getState().mutationVersion, 'panels end on the second edit');
    } finally {
      await closeFrames(frames);
    }
  });

  // Edge work that starts and ends inside the window: a re-mesh reply the viewport drains, and a
  // re-mesh that answers with no mesh edit (no store update at all).
  const EDGES: Array<[string, () => () => void | Promise<unknown>]> = [
    ['mesh work that drains', () => {
      useViewerStore.setState({ pendingMeshEdits: {} as never });
      return () => useViewerStore.setState({ pendingMeshEdits: null });
    }],
    ['a re-mesh that ends', () => {
      // This model has no source store, so the request releases without a mesh edit.
      const request = requestRemesh(useViewerStore.getState, MODEL_ID, [1], 'shape');
      return () => request;
    }],
  ];
  for (const [name, start] of EDGES) {
    it(`${name} inside the window gets two frames after it ends`, async () => {
      render(<PanelProbe />);
      const view = new MutablePropertyView(null, MODEL_ID);
      const frames = installManualFrames();
      const frame = frameStepper(frames);
      try {
        act(() => edit(view, 'REI30'));
        await frame(); // the edit's close is one frame in
        await act(async () => {
          const end = start();
          await end();
        });
        await frame(); // where the edit's first close would publish
        assert.equal(panelSees.version, 0, 'one frame since it ended, not two');
        await frame();
        assert.equal(panelSees.version, useViewerStore.getState().mutationVersion, 'published on the second frame');
      } finally {
        await closeFrames(frames);
      }
    });
  }

  it('a later edit does not extend the first edit\'s cap (regression guard)', () => {
    render(<PanelProbe />);
    const view = new MutablePropertyView(null, MODEL_ID);
    // An undrained mesh edit keeps the window from closing early; the cap alone publishes.
    act(() => useViewerStore.setState({ pendingMeshEdits: {} as never }));
    mock.timers.enable({ apis: ['setTimeout'] });
    try {
      act(() => edit(view, 'REI30'));
      act(() => mock.timers.tick(150));
      act(() => edit(view, 'REI60'));
      assert.equal(panelSees.version, 0);
      act(() => mock.timers.tick(100)); // 250 ms after the first edit, 100 after the second
      assert.equal(panelSees.version, useViewerStore.getState().mutationVersion, 'the first edit\'s cap publishes both');
    } finally {
      act(() => mock.timers.tick(250)); // past any cap, so a failed assertion leaves no window open
      mock.timers.reset();
      act(() => useViewerStore.setState({ pendingMeshEdits: null }));
    }
  });

  it('the release of the key that made an edit keeps it held', () => {
    render(<PanelProbe />);
    const view = new MutablePropertyView(null, MODEL_ID);
    const onKey = () => edit(view, 'REI60'); // the key's own handler makes the edit, after the idle store saw the press
    window.addEventListener('keydown', onKey, { once: true });
    press(window, 'z', { ctrlKey: true });
    assert.equal(useViewerStore.getState().mutationVersion, 1, 'setup: the keydown made the edit');
    act(() => { window.dispatchEvent(new window.KeyboardEvent('keyup', { key: 'z', ctrlKey: true, bubbles: true })); });
    assert.equal(panelSees.version, 0, 'the keyup does not render panels on the edit\'s path');
  });

  it('a click with no press before it publishes the held state before its handler', () => {
    let answered = -1;
    function Action() {
      const version = useViewerStore((s) => s.mutationVersion);
      return <button type="button" onClick={() => { answered = version; }}>Apply</button>;
    }
    const container = render(<Action />);
    act(() => edit(new MutablePropertyView(null, MODEL_ID), 'REI120'));
    act(() => { container.querySelector('button')!.click(); });
    assert.equal(answered, useViewerStore.getState().mutationVersion, 'assistive-technology activation answers with the edited state');
  });

  it('a click with no press on a button input publishes the held state before its handler', () => {
    let answered = -1;
    function Action() {
      const version = useViewerStore((s) => s.mutationVersion);
      return <input type="button" value="Apply" onClick={() => { answered = version; }} />;
    }
    const container = render(<Action />);
    act(() => edit(new MutablePropertyView(null, MODEL_ID), 'REI90'));
    act(() => { container.querySelector('input')!.click(); });
    assert.equal(answered, useViewerStore.getState().mutationVersion, 'the input button answers with the edited state');
  });

  it('a click with no press on an ARIA-role control publishes the held state before its handler', () => {
    let answered = -1;
    function Tabs() {
      const version = useViewerStore((s) => s.mutationVersion);
      return <div role="tablist"><button type="button" role="tab" aria-selected="false" onClick={() => { answered = version; }}>Second</button></div>;
    }
    const container = render(<Tabs />);
    act(() => edit(new MutablePropertyView(null, MODEL_ID), 'REI150'));
    act(() => { (container.querySelector('[role="tab"]') as HTMLElement).click(); });
    assert.equal(answered, useViewerStore.getState().mutationVersion, 'assistive-technology tab activation answers with the edited state');
  });

  it('the compatibility mousedown leaves an edit from pointerdown held', () => {
    render(<PanelProbe />);
    const target = document.body;
    target.addEventListener('pointerdown', () => edit(new MutablePropertyView(null, MODEL_ID), 'REI30'), { once: true });
    act(() => { target.dispatchEvent(new window.PointerEvent('pointerdown', { bubbles: true, button: 0, buttons: 1 })); });
    assert.equal(useViewerStore.getState().mutationVersion, 1, 'the plan-style press made its edit');

    mouseDown(target, { button: 0, buttons: 1 });
    assert.equal(panelSees.version, 0, 'the compatibility event leaves the edit held');
    mouseDown(target, { button: 2, buttons: 3 });
    assert.equal(panelSees.version, 1, 'a separate mouse-only press still publishes');
  });

  it('the click after a pointer press keeps an edit its release committed held', () => {
    render(<PanelProbe />);
    const view = new MutablePropertyView(null, MODEL_ID);
    act(() => { window.dispatchEvent(new window.PointerEvent('pointerdown', { bubbles: true })); });
    act(() => edit(view, 'REI15')); // a drag tool commits on pointerup
    click(document.body, { detail: 1 });
    assert.equal(panelSees.version, 0, 'the pressed click does not render panels on the edit\'s critical path');
  });
});

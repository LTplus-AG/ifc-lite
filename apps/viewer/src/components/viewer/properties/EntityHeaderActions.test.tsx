/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #3618: from an Entity List row a user can select an object and reach the
 * Properties panel's "info tab", but the existing "Zoom to" button does not
 * help when the object sits behind other geometry, and full Isolate ("I")
 * hides everything else and loses spatial context. "Show in context" reuses
 * the already-shared X-Ray channel (`ghostExceptEntities`, driven by Clash,
 * IDS and BCF) so the rest of the model fades translucent instead of
 * disappearing, and frames the camera on the selected entity in the same
 * click.
 *
 * Driven through the REAL `EntityHeaderActions` component and the real store,
 * never by calling `setGhostExceptEntities` directly — the defect class this
 * repo keeps re-finding is a handler wired to the wrong id or channel.
 */

import '@/test/setup-dom.js';
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { render, cleanup, click } from '@/test/render.js';
import { useViewerStore } from '@/store';
import { EntityHeaderActions } from './EntityHeaderActions.js';

const SELECTED = 4_000_042;
const OTHER = 4_000_099;

function resetStore(): void {
  useViewerStore.setState({
    selectedEntityId: null,
    ghostExceptEntities: null,
    isolatedEntities: null,
    hiddenEntities: new Set<number>(),
    cameraCallbacks: {},
  });
}

describe('EntityHeaderActions — "Show in context"', () => {
  afterEach(() => {
    cleanup();
    resetStore();
  });

  it('ghosts every other entity and frames the camera, without isolating (hiding) anything', () => {
    let framed = 0;
    resetStore();
    useViewerStore.setState({
      selectedEntityId: SELECTED,
      cameraCallbacks: { frameSelection: () => { framed += 1; } },
    });

    const container = render(<EntityHeaderActions />);
    const ghostButton = Array.from(container.querySelectorAll('button'))[1];
    assert.ok(ghostButton, 'expected three header buttons (Zoom to, Show in context, Hide/Show)');

    click(ghostButton);

    const state = useViewerStore.getState();
    assert.deepStrictEqual(
      state.ghostExceptEntities && Array.from(state.ghostExceptEntities),
      [SELECTED],
      'ghostExceptEntities must hold exactly the selected entity',
    );
    assert.strictEqual(state.isolatedEntities, null, 'ghosting must not also isolate (hide) the rest');
    assert.strictEqual(framed, 1, 'the camera must frame the selected entity in the same click');
  });

  it('toggles off on a second click, clearing the ghost channel', () => {
    resetStore();
    useViewerStore.setState({
      selectedEntityId: SELECTED,
      ghostExceptEntities: new Set([SELECTED]),
      cameraCallbacks: {},
    });

    const container = render(<EntityHeaderActions />);
    const ghostButton = Array.from(container.querySelectorAll('button'))[1];

    click(ghostButton);

    assert.strictEqual(useViewerStore.getState().ghostExceptEntities, null);
  });

  it('does not clear a ghost context installed for a DIFFERENT entity — clicking sets its own', () => {
    resetStore();
    useViewerStore.setState({
      selectedEntityId: SELECTED,
      ghostExceptEntities: new Set([OTHER]),
      cameraCallbacks: {},
    });

    const container = render(<EntityHeaderActions />);
    const ghostButton = Array.from(container.querySelectorAll('button'))[1];

    click(ghostButton);

    assert.deepStrictEqual(
      Array.from(useViewerStore.getState().ghostExceptEntities ?? []),
      [SELECTED],
      'a click for the selected entity must replace the previous ghost set with its own',
    );
  });

  // Kills the mutation `restoreVisibilityState({isolated, ...})` ->
  // `setGhostExceptEntities(...)`. That setter nulls `isolatedEntities`
  // unconditionally and nothing captured it, so isolating and then fading
  // destroyed the isolation for good -- the whole building reappeared faded,
  // and toggling back left it solid with the isolation gone.
  it('preserves an active isolation when entering and leaving "Show in context"', () => {
    resetStore();
    const isolation = new Set([SELECTED, OTHER]);
    useViewerStore.setState({ selectedEntityId: SELECTED, isolatedEntities: isolation });

    const container = render(<EntityHeaderActions />);
    const ghostButton = Array.from(container.querySelectorAll('button'))[1];

    click(ghostButton);
    const entered = useViewerStore.getState();
    assert.deepStrictEqual(
      entered.isolatedEntities && [...entered.isolatedEntities].sort(),
      [...isolation].sort(),
      'entering must not destroy the isolation',
    );
    assert.deepStrictEqual(entered.ghostExceptEntities && [...entered.ghostExceptEntities], [SELECTED]);

    click(ghostButton);
    const left = useViewerStore.getState();
    assert.strictEqual(left.ghostExceptEntities, null, 'leaving clears the fade');
    assert.deepStrictEqual(
      left.isolatedEntities && [...left.isolatedEntities].sort(),
      [...isolation].sort(),
      'leaving must leave the isolation standing',
    );
  });

  // Kills the mutation "drop the unmount teardown". PropertiesPanel renders
  // nothing without a selection, so the button unmounts on deselect; without
  // teardown the model stayed faded with no control able to undo it.
  it('tears its own fade down when the panel unmounts (deselection)', () => {
    resetStore();
    useViewerStore.setState({ selectedEntityId: SELECTED });

    const container = render(<EntityHeaderActions />);
    click(Array.from(container.querySelectorAll('button'))[1]);
    assert.deepStrictEqual(
      useViewerStore.getState().ghostExceptEntities &&
        [...useViewerStore.getState().ghostExceptEntities!],
      [SELECTED],
    );

    cleanup();
    assert.strictEqual(
      useViewerStore.getState().ghostExceptEntities,
      null,
      'a fade with no control left to clear it must not survive the panel',
    );
  });

  // The teardown must not fire on someone else's fade. Ownership is recorded when
  // this control installs one, so a foreign ghost -- of ANY size -- survives.
  // Codex on #3737: IDS row focus and Layer Diff both install SINGLETON ghosts
  // and record their own ownership, so a "size === 1 and has(selection)" test
  // would have torn down their presentation.
  it('leaves a foreign singleton ghost standing on unmount', () => {
    resetStore();
    const foreign = new Set([SELECTED]);
    useViewerStore.setState({ selectedEntityId: SELECTED, ghostExceptEntities: foreign });

    render(<EntityHeaderActions />);
    cleanup();
    assert.strictEqual(
      useViewerStore.getState().ghostExceptEntities,
      foreign,
      "a singleton ghost this control did not install must survive -- contents are not ownership",
    );
  });

  it('leaves a foreign multi-entity ghost standing on unmount', () => {
    resetStore();
    const foreign = new Set([SELECTED, OTHER]);
    useViewerStore.setState({ selectedEntityId: SELECTED, ghostExceptEntities: foreign });

    render(<EntityHeaderActions />);
    cleanup();
    assert.strictEqual(useViewerStore.getState().ghostExceptEntities, foreign);
  });

  // Kills the mutation "leave the widened isolation in place". Admitting the
  // selection is a TEMPORARY widening for the duration of the context view; if
  // leaving keeps it, the user's isolation silently gains an entity they never
  // added. Codex asked for exactly this: retain enough prior state to restore
  // the original isolation when the context view ends.
  it('narrows the isolation back when the context view ends', () => {
    resetStore();
    const original = new Set([OTHER]);
    useViewerStore.setState({ selectedEntityId: SELECTED, isolatedEntities: original });

    const container = render(<EntityHeaderActions />);
    const ghostButton = Array.from(container.querySelectorAll('button'))[1];

    click(ghostButton);
    assert.ok(useViewerStore.getState().isolatedEntities?.has(SELECTED), 'widened while shown');

    click(ghostButton);
    const after = useViewerStore.getState().isolatedEntities;
    assert.ok(after?.has(OTHER), 'the original isolation comes back');
    assert.ok(!after?.has(SELECTED), 'the temporary admission must not persist');
    assert.strictEqual(useViewerStore.getState().ghostExceptEntities, null);
  });

  // Kills the mutation "install B's fade without releasing A's first". Moving the
  // context view from A to B read the isolation A had already widened and recorded
  // THAT as B's prior, so clearing restored the A-widened set and left A admitted
  // permanently. CodeRabbit CLI on #3737, major.
  it('A -> B -> clear leaves the original isolation, with neither A nor B admitted', () => {
    resetStore();
    const original = new Set([9_999]);
    useViewerStore.setState({ selectedEntityId: SELECTED, isolatedEntities: original });

    const container = render(<EntityHeaderActions />);
    const ghostButton = Array.from(container.querySelectorAll('button'))[1];

    click(ghostButton); // fade on A (SELECTED), isolation widened by A
    assert.ok(useViewerStore.getState().isolatedEntities?.has(SELECTED));

    // Selection moves to B and the user clicks again: the button is OFF for B,
    // so this installs B's fade rather than clearing.
    useViewerStore.setState({ selectedEntityId: OTHER });
    const c2 = render(<EntityHeaderActions />);
    click(Array.from(c2.querySelectorAll('button'))[1]);

    click(Array.from(c2.querySelectorAll('button'))[1]); // clear B

    const iso = useViewerStore.getState().isolatedEntities;
    assert.ok(iso?.has(9_999), 'the original isolation survives');
    assert.ok(!iso?.has(SELECTED), 'A must not be left admitted');
    assert.ok(!iso?.has(OTHER), 'B must not be left admitted');
  });

  // CodeRabbit on #3737 reported the mirror-image bug: recording ownership on
  // every render meant that with the fade on A and the selection moved to B,
  // cleanup compared B against A's set and left the model faded forever.
  // Identity-based ownership makes the current selection irrelevant by
  // construction, which is what this pins. It is NOT a killing test for that
  // mutation -- the harness only flushes inside act(), which it does not export,
  // so no re-render happens between the setState and cleanup and the stale-ref
  // version passes it too. The mutation is killed by the foreign-singleton test
  // above, which fails without identity ownership.
  it('tears its own fade down regardless of the current selection', () => {
    resetStore();
    useViewerStore.setState({ selectedEntityId: SELECTED });
    const container = render(<EntityHeaderActions />);
    click(Array.from(container.querySelectorAll('button'))[1]);

    // Selection moves while the fade stays installed for SELECTED.
    useViewerStore.setState({ selectedEntityId: OTHER });
    cleanup();

    assert.strictEqual(
      useViewerStore.getState().ghostExceptEntities,
      null,
      'our own fade must still be torn down once the selection has moved on',
    );
  });

  // Codex on #3737: preserving an isolation that excludes the selection hides the
  // very entity being shown -- isEntityVisible rejects ids absent from
  // isolatedEntities, and ghosting only fades what survived that filter, so the
  // camera framed something invisible.
  it('admits the selected entity into a preserved isolation that excludes it', () => {
    resetStore();
    useViewerStore.setState({
      selectedEntityId: SELECTED,
      isolatedEntities: new Set([OTHER]),
    });

    const container = render(<EntityHeaderActions />);
    click(Array.from(container.querySelectorAll('button'))[1]);

    const iso = useViewerStore.getState().isolatedEntities;
    assert.ok(iso?.has(SELECTED), 'the entity being shown must be inside the isolation');
    assert.ok(iso?.has(OTHER), 'the rest of the isolation must be preserved');
  });

  it('control: "Zoom to" and "Hide" keep their existing, unrelated behaviour', () => {
    let framed = 0;
    resetStore();
    useViewerStore.setState({
      selectedEntityId: SELECTED,
      cameraCallbacks: { frameSelection: () => { framed += 1; } },
    });

    const container = render(<EntityHeaderActions />);
    const buttons = Array.from(container.querySelectorAll('button'));
    const [zoomButton, , hideButton] = buttons;

    click(zoomButton);
    assert.strictEqual(framed, 1);
    assert.strictEqual(useViewerStore.getState().ghostExceptEntities, null, 'Zoom to must not touch ghosting');

    click(hideButton);
    assert.ok(
      useViewerStore.getState().hiddenEntities.has(SELECTED),
      'Hide must still hide the selected entity, unchanged by the new button',
    );
  });
});

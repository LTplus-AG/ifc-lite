/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The Space Sketch bar's narrower forms (#5975). When the top-center lane is
 * too narrow for one row, history (undo/redo), snap and Help fold into one
 * `MoreHorizontal` overflow trigger and the heading text goes (tier 1), then
 * the confirm button shrinks to ✓ + count (tier 2), instead of the bar
 * wrapping onto a second row. `SpaceSketchBarContent` takes `tier` as a prop;
 * the live `SpaceSketchBar` picks it with `useHudBarTier`, which needs real
 * layout and is covered by the viewport-hud e2e. Asserted here through the
 * rendered output of each tier.
 */

import '@/test/setup-dom.js';
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { cleanup, click, render } from '@/test/render.js';
import { SpaceSketchBarContent, type SpaceSketchBarProps } from './SpaceSketchHud.js';

function noop(): void {}

function props(over: Partial<SpaceSketchBarProps> = {}): SpaceSketchBarProps {
  return {
    canAuthor: true,
    drawMode: 'free',
    onDrawMode: noop,
    footprintArmed: false,
    onFootprint: noop,
    roomCount: 0,
    canUndo: true,
    canRedo: true,
    onUndo: noop,
    onRedo: noop,
    snapToBuilding: true,
    onToggleSnap: noop,
    optionsOpen: false,
    onOptionsOpenChange: noop,
    optionsDirty: false,
    options: {
      boundaryMode: 'center',
      onBoundaryMode: noop,
      hasWallData: true,
      snapDelta: null,
      usedTol: 0.05,
      snapDisabled: false,
      onSnap: noop,
      snapTol: null,
      showBuilding: true,
      onToggleBuilding: noop,
      showDiagnostics: false,
      onToggleDiagnostics: noop,
    },
    helpOpen: false,
    onHelpOpenChange: noop,
    needsConfirm: false,
    pendingRooms: 0,
    pendingStoreys: 0,
    onConfirm: noop,
    onClose: noop,
    onMinimize: noop,
    ...over,
  };
}

function byTitle(ui: HTMLElement, title: string): HTMLButtonElement | undefined {
  return [...ui.querySelectorAll('button')].find((b) => b.title === title);
}

afterEach(cleanup);

describe('SpaceSketchBarContent tiers (#5975)', () => {
  it('shows history, snap and Help inline when not compact, and no More trigger', () => {
    const ui = render(<SpaceSketchBarContent {...props()} tier={0} />);
    assert.ok(byTitle(ui, 'Undo (Ctrl+Z)'), 'Undo is inline');
    assert.ok(byTitle(ui, 'Redo (Ctrl+Shift+Z)'), 'Redo is inline');
    assert.ok(byTitle(ui, 'Snap to walls + corners: on'), 'Snap toggle is inline');
    assert.ok(byTitle(ui, 'How it works'), 'Help trigger is inline');
    assert.equal(ui.querySelector('[data-testid="spaceSketch-more-trigger"]'), null, 'no overflow trigger');
  });

  it('collapses history, snap and Help behind one More trigger when compact', () => {
    const ui = render(<SpaceSketchBarContent {...props()} tier={1} />);
    assert.equal(byTitle(ui, 'Undo (Ctrl+Z)'), undefined, 'Undo is not inline');
    assert.equal(byTitle(ui, 'Redo (Ctrl+Shift+Z)'), undefined, 'Redo is not inline');
    assert.equal(byTitle(ui, 'Snap to walls + corners: on'), undefined, 'Snap toggle is not inline');
    assert.equal(byTitle(ui, 'How it works'), undefined, 'Help trigger is not inline');
    const trigger = ui.querySelector<HTMLButtonElement>('[data-testid="spaceSketch-more-trigger"]');
    assert.ok(trigger, 'the More trigger renders');

    // The Options popover and the confirm/minimize/close controls stay
    // inline in both forms — only the LOWER-priority actions move.
    assert.ok(byTitle(ui, 'Options: boundary, corner tolerance, underlay, generate all storeys'), 'Options stays inline');
    assert.ok(byTitle(ui, 'Close without creating (Esc)'), 'Close stays inline');

    click(trigger);
    const popoverText = document.body.textContent ?? '';
    assert.match(popoverText, /Undo \(Ctrl\+Z\)/, 'Undo is reachable from More');
    assert.match(popoverText, /Redo \(Ctrl\+Shift\+Z\)/, 'Redo is reachable from More');
    assert.match(popoverText, /Snap to walls \+ corners/, 'Snap is reachable from More');
    assert.match(popoverText, /One tool — actions follow the cursor:/, 'the Help legend is reachable from More');
  });

  it('runs the Undo/Redo/Snap actions from inside the More popover', () => {
    let undone = 0, snapped: boolean[] = [];
    const ui = render(
      <SpaceSketchBarContent
        {...props({ onUndo: () => { undone++; }, onToggleSnap: () => { snapped.push(true); } })}
        tier={1}
      />,
    );
    click(ui.querySelector<HTMLButtonElement>('[data-testid="spaceSketch-more-trigger"]')!);
    const undo = [...document.querySelectorAll('button')].find((b) => b.textContent?.trim().startsWith('Undo'));
    assert.ok(undo, 'Undo row renders inside More');
    click(undo);
    assert.equal(undone, 1, 'the real onUndo still fires from inside More');

    const snap = document.querySelector<HTMLInputElement>('input[type="checkbox"]');
    assert.ok(snap, 'the snap checkbox renders inside More');
    click(snap);
    assert.equal(snapped.length, 1, 'the real onToggleSnap still fires from inside More');
  });

  it('drops the heading at compact, and shrinks confirm to a count at minimal while keeping the full label accessible', () => {
    const props2 = props({ needsConfirm: true, pendingRooms: 12, pendingStoreys: 1 });
    const full = render(<SpaceSketchBarContent {...props2} tier={0} />);
    assert.match(full.textContent ?? '', /Space Sketch/, 'the full bar shows the heading');
    const wide = render(<SpaceSketchBarContent {...props2} tier={1} />);
    assert.doesNotMatch(wide.textContent ?? '', /Space Sketch/, 'compact drops the heading');
    assert.match(wide.textContent ?? '', /Confirm 12 spaces/, 'compact keeps the confirm label');

    const ui = render(<SpaceSketchBarContent {...props2} tier={2} />);
    assert.doesNotMatch(ui.textContent ?? '', /Space Sketch/, 'minimal has no heading either');
    const confirm = byTitle(ui, 'Create the drafted spaces on every storey and close');
    assert.ok(confirm, 'the confirm button is still there');
    assert.equal(confirm.textContent?.trim(), '12', 'it shows the count alone');
    assert.equal(confirm.getAttribute('aria-label'), 'Confirm 12 spaces', 'the full label stays its accessible name');
    assert.ok(ui.querySelector('[data-testid="spaceSketch-more-trigger"]'), 'minimal keeps the More trigger');
  });
});

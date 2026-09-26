/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * ARIA tree semantics + keyboard navigation (#5883, WAI-ARIA APG tree view
 * pattern): the panel's rows were plain `div`s with `onClick`, no
 * `tabIndex`, and no `onKeyDown` anywhere — a keyboard user could not move,
 * expand, collapse or select. Every assertion here fails on current `main`
 * and passes once `role="tree"`/`treeitem` + `useTreeKeyboard` land.
 *
 * `axe-core` is not a direct devDependency of `apps/viewer` (only
 * `@axe-core/playwright`, a root-level e2e devDependency, is) — per
 * AGENTS.md, package-specific deps belong in the consuming package, so this
 * suite does not import it and asserts the ARIA attributes directly instead,
 * as the issue's acceptance criteria allow. `tests/e2e/axe-baseline.ts`
 * covers the real axe run at the e2e level.
 */

import '@/test/setup-dom.js';
import { installLayout } from '@/test/dom-layout.js';
installLayout();

import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { act } from 'react';
import { IfcTypeEnum } from '@ifc-lite/data';
import { advance, cleanup, press, render, waitFor } from '@/test/render.js';
import { fixtureModel, fixtureModels } from '@/test/store-fixture.js';
import { SourceHostProvider } from '@/services/sources/SourceHostProvider.js';
import { useViewerStore } from '@/store';
import { HierarchyPanel } from '../HierarchyPanel.js';

afterEach(cleanup);

/** Project(1) -> Site(2) -> Building(3) -> Storey(4, collapsed) -> Wall(7).
 *  The initial-expansion effect (`useHierarchyTree`) opens Project/Site/
 *  Building for a single model, so the flat list starts as those four rows
 *  plus the still-collapsed storey — exactly one level of "expand to reveal
 *  a child" left for the keyboard tests below. */
function mountHierarchy(): { container: HTMLElement; tree: HTMLElement } {
  const model = fixtureModel('aria-tree-model', { entities: [
    { expressId: 7, type: 'IfcWall', name: 'Target Wall' },
  ] });
  const storey = { expressId: 4, type: IfcTypeEnum.IfcBuildingStorey, name: 'Storey 1', children: [], elements: [7] };
  const building = { expressId: 3, type: IfcTypeEnum.IfcBuilding, name: 'Building', children: [storey], elements: [] };
  const site = { expressId: 2, type: IfcTypeEnum.IfcSite, name: 'Site', children: [building], elements: [] };
  const project = { expressId: 1, type: IfcTypeEnum.IfcProject, name: 'Project', children: [site], elements: [] };
  Object.assign(model.ifcDataStore!, {
    spatialHierarchy: {
      project,
      byStorey: new Map([[4, [7]]]),
      byBuilding: new Map(),
      bySite: new Map(),
      bySpace: new Map(),
      storeyElevations: new Map(),
      storeyHeights: new Map(),
      elementToStorey: new Map([[7, 4]]),
      getStoreyElements: () => [],
      getStoreyByElevation: () => null,
      getContainingSpace: () => null,
      getPath: () => [],
    },
  });
  useViewerStore.setState({
    ...fixtureModels(model), ifcDataStore: model.ifcDataStore, hierarchyMode: 'spatial',
    selectedEntityId: null, selectedEntityIds: new Set(), selectedStoreys: new Set(),
  });
  const container = render(<SourceHostProvider><HierarchyPanel /></SourceHostProvider>);
  const tree = container.querySelector('[role="tree"]');
  assert.ok(tree instanceof HTMLElement, 'the tree container renders with role="tree"');
  return { container, tree: tree as HTMLElement };
}

/** Project(1) -> Site(2) -> Building(3) -> Storey(4, collapsed) -> `wallCount`
 *  plain walls (expressIds 100..100+wallCount-1), all under that one storey.
 *  Used for the Shift+Down range-select test (a handful of walls) and the
 *  virtualization test (hundreds, to force some of them out of the
 *  virtualizer's mounted window — #6139 review). */
function mountWallsHierarchy(wallCount: number): { tree: HTMLElement } {
  const entities = Array.from({ length: wallCount }, (_, i) => ({ expressId: 100 + i, type: 'IfcWall', name: `Wall ${i}` }));
  const expressIds = entities.map((e) => e.expressId);
  const model = fixtureModel('walls-tree-model', { entities });
  const storey = { expressId: 4, type: IfcTypeEnum.IfcBuildingStorey, name: 'Storey 1', children: [], elements: expressIds };
  const building = { expressId: 3, type: IfcTypeEnum.IfcBuilding, name: 'Building', children: [storey], elements: [] };
  const site = { expressId: 2, type: IfcTypeEnum.IfcSite, name: 'Site', children: [building], elements: [] };
  const project = { expressId: 1, type: IfcTypeEnum.IfcProject, name: 'Project', children: [site], elements: [] };
  Object.assign(model.ifcDataStore!, {
    spatialHierarchy: {
      project,
      byStorey: new Map([[4, expressIds]]),
      byBuilding: new Map(),
      bySite: new Map(),
      bySpace: new Map(),
      storeyElevations: new Map(),
      storeyHeights: new Map(),
      elementToStorey: new Map(expressIds.map((id) => [id, 4])),
      getStoreyElements: () => [],
      getStoreyByElevation: () => null,
      getContainingSpace: () => null,
      getPath: () => [],
    },
  });
  useViewerStore.setState({
    ...fixtureModels(model), ifcDataStore: model.ifcDataStore, hierarchyMode: 'spatial',
    selectedEntityId: null, selectedEntityIds: new Set(), selectedStoreys: new Set(),
  });
  const container = render(<SourceHostProvider><HierarchyPanel /></SourceHostProvider>);
  const tree = container.querySelector('[role="tree"]');
  assert.ok(tree instanceof HTMLElement, 'the tree container renders with role="tree"');
  return { tree: tree as HTMLElement };
}

/** Navigate Site -> Building -> Storey -> expand -> first child, from the
 *  freshly mounted root (Project starts as the roving tab stop). Shared by
 *  the tests below so each one starts from "focus is on the first wall". */
function focusFirstWall(tree: HTMLElement): void {
  press(tree, 'ArrowDown'); // Site
  press(tree, 'ArrowDown'); // Building
  press(tree, 'ArrowDown'); // Storey (collapsed)
  press(tree, 'ArrowRight'); // expand
  press(tree, 'ArrowRight'); // move into Wall 0
}

function treeitems(tree: HTMLElement): HTMLElement[] {
  return [...tree.querySelectorAll<HTMLElement>('[role="treeitem"]')];
}

function byName(tree: HTMLElement, name: string): HTMLElement {
  const row = treeitems(tree).find((el) => el.textContent?.includes(name));
  assert.ok(row, `expected a treeitem for "${name}"`);
  return row!;
}

describe('HierarchyPanel ARIA tree (#5883)', () => {
  it('does not steal focus from another control when the panel mounts', async () => {
    const outside = document.createElement('input');
    document.body.appendChild(outside);
    outside.focus();
    try {
      mountHierarchy();
      await advance(30);
      assert.ok(document.activeElement === outside, 'mounting a tree must preserve existing focus');
    } finally {
      outside.remove();
    }
  });

  it('exposes role="tree" with an accessible label, and treeitems with correct aria-level', () => {
    const { tree } = mountHierarchy();
    assert.equal(tree.getAttribute('role'), 'tree');
    assert.ok(tree.getAttribute('aria-label'), 'the tree has an accessible name');

    assert.equal(byName(tree, 'Project').getAttribute('aria-level'), '1');
    assert.equal(byName(tree, 'Site').getAttribute('aria-level'), '2');
    assert.equal(byName(tree, 'Building').getAttribute('aria-level'), '3');
    assert.equal(byName(tree, 'Storey 1').getAttribute('aria-level'), '4');

    // Parents carry aria-expanded; the collapsed storey is false, its already
    // auto-expanded ancestors are true.
    assert.equal(byName(tree, 'Storey 1').getAttribute('aria-expanded'), 'false');
    assert.equal(byName(tree, 'Building').getAttribute('aria-expanded'), 'true');

    // Roving tabIndex: exactly one row is in the tab order.
    const tabbable = treeitems(tree).filter((el) => el.getAttribute('tabindex') === '0');
    assert.equal(tabbable.length, 1, 'exactly one treeitem has tabIndex 0');
  });

  it('Down moves the roving tabIndex to the next row', () => {
    const { tree } = mountHierarchy();
    const project = byName(tree, 'Project');
    const site = byName(tree, 'Site');
    assert.equal(project.getAttribute('tabindex'), '0');
    assert.equal(site.getAttribute('tabindex'), '-1');

    press(tree, 'ArrowDown');

    assert.equal(project.getAttribute('tabindex'), '-1');
    assert.equal(site.getAttribute('tabindex'), '0');
  });

  it('Right expands a collapsed row, then moves into its first child', () => {
    const { tree } = mountHierarchy();
    // Move the roving tabIndex onto the (collapsed) storey: Project -> Site -> Building -> Storey.
    press(tree, 'ArrowDown');
    press(tree, 'ArrowDown');
    press(tree, 'ArrowDown');
    const storey = byName(tree, 'Storey 1');
    assert.equal(storey.getAttribute('tabindex'), '0');
    assert.equal(storey.getAttribute('aria-expanded'), 'false');
    assert.doesNotMatch(tree.textContent ?? '', /Target Wall/);

    press(tree, 'ArrowRight');
    assert.equal(byName(tree, 'Storey 1').getAttribute('aria-expanded'), 'true');
    assert.match(tree.textContent ?? '', /Target Wall/, 'expanding the storey reveals the wall');
    // First ArrowRight only expands; the roving tabIndex stays put.
    assert.equal(byName(tree, 'Storey 1').getAttribute('tabindex'), '0');

    press(tree, 'ArrowRight');
    // Second ArrowRight (now expanded): moves into the first child.
    const wall = byName(tree, 'Target Wall');
    assert.equal(wall.getAttribute('tabindex'), '0');
    assert.equal(byName(tree, 'Storey 1').getAttribute('tabindex'), '-1');
  });

  it('Left collapses an expanded row, or moves to the parent if already collapsed/a leaf', () => {
    const { tree } = mountHierarchy();
    press(tree, 'ArrowDown'); // Site
    press(tree, 'ArrowDown'); // Building
    press(tree, 'ArrowDown'); // Storey (collapsed)
    press(tree, 'ArrowRight'); // expand
    press(tree, 'ArrowRight'); // move to Wall (leaf)
    assert.equal(byName(tree, 'Target Wall').getAttribute('tabindex'), '0');

    // Leaf: Left moves to the parent (Storey), not a collapse.
    press(tree, 'ArrowLeft');
    assert.equal(byName(tree, 'Storey 1').getAttribute('tabindex'), '0');
    assert.equal(byName(tree, 'Storey 1').getAttribute('aria-expanded'), 'true');

    // Expanded parent: Left collapses it in place.
    press(tree, 'ArrowLeft');
    assert.equal(byName(tree, 'Storey 1').getAttribute('aria-expanded'), 'false');
    assert.equal(byName(tree, 'Storey 1').getAttribute('tabindex'), '0');
    assert.doesNotMatch(tree.textContent ?? '', /Target Wall/);
  });

  it('Enter activates the focused row exactly like a click (storey selection)', () => {
    const { tree } = mountHierarchy();
    press(tree, 'ArrowDown'); // Site
    press(tree, 'ArrowDown'); // Building
    press(tree, 'ArrowDown'); // Storey
    assert.equal(useViewerStore.getState().selectedStoreys.size, 0);
    const beforeRevision = useViewerStore.getState().selectionRevision;

    press(byName(tree, 'Storey 1'), 'Enter');

    assert.equal(useViewerStore.getState().selectedStoreys.has(4), true, 'Enter selects the focused storey, like a click');
    assert.equal(useViewerStore.getState().selectionRevision, beforeRevision + 1, 'Enter activates the row once');
  });

  it('leaves Enter on a nested chevron button to that button', () => {
    const { tree } = mountHierarchy();
    press(tree, 'ArrowDown'); // Site
    press(tree, 'ArrowDown'); // Building
    press(tree, 'ArrowDown'); // Storey
    const chevron = byName(tree, 'Storey 1').querySelector('button[aria-label="Expand Storey 1"]');
    assert.ok(chevron, 'the storey has its own expand button');

    press(chevron, 'Enter');

    assert.equal(useViewerStore.getState().selectedStoreys.size, 0,
      'a nested button key press must not activate the tree row');
  });

  it('keeps every button inside a treeitem out of the tab order (#6139 review)', () => {
    const { tree } = mountHierarchy();
    press(tree, 'ArrowDown'); // Site
    press(tree, 'ArrowDown'); // Building
    press(tree, 'ArrowDown'); // Storey
    press(tree, 'ArrowRight'); // expand — mounts the wall row's chevron/eye buttons too

    const rows = treeitems(tree);
    assert.ok(rows.length > 1);
    for (const row of rows) {
      for (const button of [...row.querySelectorAll('button')]) {
        assert.equal(
          button.getAttribute('tabindex'), '-1',
          `a button inside the "${row.textContent}" treeitem must not be in the tab order — Tab from a treeitem must reach the next treeitem`,
        );
      }
    }
    // The roving tab stop is still exactly one treeitem, not any of the buttons.
    assert.equal(rows.filter((r) => r.getAttribute('tabindex') === '0').length, 1);
  });

  it('Shift+Down twice from a selected wall extends the selection to three rows (#6139 review)', () => {
    const { tree } = mountWallsHierarchy(5);
    focusFirstWall(tree);
    assert.equal(byName(tree, 'Wall 0').getAttribute('tabindex'), '0');

    // Plain Enter: single-select Wall 0 (the legacy single-select path, which
    // still seeds the multi-select anchor there, #1463) — carried on
    // `selectedEntityId`, not the multi-select `selectedEntityIds` set, so
    // the Shift+Down below extends a range FROM this row.
    press(tree, 'Enter');
    assert.equal(useViewerStore.getState().selectedEntityId, 100);
    assert.equal(useViewerStore.getState().selectedEntityIds.size, 0);

    press(tree, 'ArrowDown', { shiftKey: true });
    assert.equal(byName(tree, 'Wall 1').getAttribute('tabindex'), '0', 'Shift+Down still moves focus');
    assert.deepEqual([...useViewerStore.getState().selectedEntityIds].sort((a, b) => a - b), [100, 101]);

    press(tree, 'ArrowDown', { shiftKey: true });
    assert.equal(byName(tree, 'Wall 2').getAttribute('tabindex'), '0');
    assert.deepEqual([...useViewerStore.getState().selectedEntityIds].sort((a, b) => a - b), [100, 101, 102]);
  });

  it('keeps a tab stop in the tree when the active row is not mounted, and focuses it once it is (virtualization, #6139 review)', async () => {
    const { tree } = mountWallsHierarchy(300);
    focusFirstWall(tree);

    press(tree, 'End');

    // Right after End: the last wall (row 304 of 304) is not mounted by the
    // virtualizer yet (it's still scrolling the ~35 rows near the top). Zero
    // MOUNTED treeitems carry tabIndex 0 — the tree CONTAINER itself does
    // instead, so the tree is never absent from Tab order.
    assert.equal(
      treeitems(tree).filter((el) => el.getAttribute('tabindex') === '0').length, 0,
      'the target row is not mounted yet, so no treeitem should claim the tab stop',
    );
    assert.equal(tree.getAttribute('tabindex'), '0', 'the container claims the tab stop while the active row is unmounted');

    // happy-dom does not dispatch a real `scroll` event for a programmatic
    // `scrollTop`/`scrollTo()` write (`useTreeKeyboard`'s `moveTo` already
    // called `virtualizer.scrollToIndex` above) — `@tanstack/react-virtual`
    // only recomputes its mounted range from a `scroll` LISTENER
    // (`observeElementOffset`), never by polling, so nothing here is
    // otherwise going to move. Firing the event synthesizes exactly what a
    // real browser's scroll would deliver, to exercise OUR focus-follow
    // effect once the row it's waiting for actually mounts.
    act(() => {
      // A number comfortably past the tree's total measured height (300+
      // rows * ~36px) — the virtualizer clamps it to the real end itself;
      // `scrollHeight` is not one of the properties `installLayout` stubs,
      // so it cannot stand in for that clamp here.
      tree.scrollTop = 100_000;
      tree.dispatchEvent(new Event('scroll'));
    });

    await waitFor(
      () => document.activeElement instanceof HTMLElement
        && document.activeElement.getAttribute('role') === 'treeitem'
        && (document.activeElement.textContent?.includes('Wall 299') ?? false),
      'focus never reached the last wall row',
    );
    assert.equal(tree.getAttribute('tabindex'), '-1', 'the container yields the tab stop back once a treeitem has it');
  });
});

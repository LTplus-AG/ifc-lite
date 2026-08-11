/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Reachability guards for zone volume apportionment (issue #2508).
 *
 * The viewer ships the classic strip and the ribbon at once, and a feature that
 * only one of them reaches is a feature half the users never see. #2510 and
 * #2511 each shipped a first guard that stayed green while the feature was
 * unreachable, for two reasons this file avoids:
 *
 *  - a leftover IMPORT satisfied a "the toolbar mentions it" source check, so
 *    every source assertion here strips import lines first;
 *  - the section's own tests passed while nothing HOSTED it, so the panel-side
 *    guards below drive the real host component and read the result off what it
 *    renders, not off a symbol existing.
 *
 * `Location zones` (#1869) reached neither toolbar before this — the ActivityBar
 * rail was its only entry point, which #2508 calls out as a discoverability
 * problem. These pin that it now reaches both, and that neither toolbar grew
 * apportionment UI of its own to drift from the panel's.
 */

import '@/test/setup-dom.js';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { useViewerStore } from '@/store';
import { useWorkspacePanelControls } from './toolbar/useWorkspacePanelControls.js';
import { ZoneApportionSummary } from './ZoneApportionSummary.js';
import { ZoneVolumeBreakdown } from './ZoneVolumeBreakdown.js';
import { zoneSetRevision } from '@/lib/zones';
import { gatherProvedVolumes } from '@/hooks/useZoneApportionment';
import type { ZoneSet } from '@/lib/zones';
import { ProjectUnits } from '@ifc-lite/parser';

const HERE = dirname(fileURLToPath(import.meta.url));

/** Read a source file with its IMPORT lines removed. A guard that accepts an
 *  import is a guard that passes on a dead feature — the exact hole #2510's
 *  first attempt had. */
function bodyOf(relativePath: string): string {
  return readFileSync(join(HERE, relativePath), 'utf8')
    .split('\n')
    .filter((line) => !/^\s*import\b/.test(line) && !/^\s*}\s*from\s+'/.test(line))
    .join('\n');
}

const ZONE_SET: ZoneSet = {
  id: 'zs1',
  name: 'Takt areas',
  visible: true,
  createdAt: 0,
  updatedAt: 0,
  zones: [
    { id: 'a', name: 'Area A', center: [-3, 0, 0], size: [6, 10, 10], rotationY: 0 },
    { id: 'b', name: 'Area B', center: [3, 0, 0], size: [6, 10, 10], rotationY: 0 },
  ],
};

describe('#2508 zone apportionment reachability', () => {
  describe('both toolbars reach the Zones panel', () => {
    it('the classic strip dispatches it', () => {
      const body = bodyOf('MainToolbar.tsx');
      assert.match(body, /toggleWorkspacePanel\('zones'\)/, 'the classic Panels menu must open Zones');
    });

    it('the ribbon dispatches it', () => {
      const body = bodyOf('ribbon/tabs/AnalyzeTab.tsx');
      assert.match(body, /toggleWorkspacePanel\('zones'\)/, 'the ribbon Analyze tab must open Zones');
    });

    it('both read their active state from the SHARED hook, not from a private flag', () => {
      // Two toolbars deriving "is Zones open" independently is how they drift.
      for (const file of ['MainToolbar.tsx', 'ribbon/tabs/AnalyzeTab.tsx']) {
        assert.match(bodyOf(file), /activeWorkspacePanels\.has\('zones'\)/, `${file} must use the shared set`);
      }
      assert.match(
        bodyOf('toolbar/useWorkspacePanelControls.ts'),
        /sidebarActivePanel === 'zones'/,
        'the shared hook is the one place that decides',
      );
    });

    it('neither toolbar grows apportionment UI of its own', () => {
      for (const file of ['MainToolbar.tsx', 'ribbon/tabs/AnalyzeTab.tsx']) {
        const body = bodyOf(file);
        assert.doesNotMatch(body, /ZoneApportionSummary|ZoneVolumeBreakdown/, `${file} must not host a second copy`);
      }
    });
  });

  // These two exist because the SOURCE guards above passed while BOTH toolbar
  // entries were dead. Dispatching the right action is not the same as the
  // panel opening, and rendering the right `active` prop is not the same as
  // that prop being recomputed. Each was found by clicking the button.
  describe('the dispatch actually opens the panel', () => {
    it('toggleWorkspacePanel("zones") makes Zones the docked panel', () => {
      // Zones has no visibility flag of its own, so the sidebar exclusivity
      // subscription -- which promotes whichever panel's flag just went
      // off->on -- could never adopt it. The menu item dispatched, every flag
      // went false, and the docked slot fell back to Information: the panel
      // could not be opened from ANY entry point.
      useViewerStore.getState().showWorkspacePanel('properties');
      assert.equal(useViewerStore.getState().sidebarActivePanel, 'properties');

      useViewerStore.getState().toggleWorkspacePanel('zones');
      assert.equal(useViewerStore.getState().sidebarActivePanel, 'zones', 'the click must dock the Zones panel');

      useViewerStore.getState().toggleWorkspacePanel('zones');
      assert.equal(useViewerStore.getState().sidebarActivePanel, 'properties', 'and toggle back off');
    });

    it('a FLAGGED panel still routes through the subscription, unchanged', () => {
      // The fix must not become a second writer for panels that already have
      // one. Layers has a flag; opening it must still set both.
      useViewerStore.getState().toggleWorkspacePanel('layers');
      const s = useViewerStore.getState();
      assert.equal(s.sidebarActivePanel, 'layers');
      assert.equal(s.layersPanelVisible, true);
      useViewerStore.getState().showWorkspacePanel('properties');
    });
  });

  describe('the toolbars re-read the active panel when it changes', () => {
    it('activeWorkspacePanels tracks sidebarActivePanel across a re-render', () => {
      // `activeWorkspacePanels` is a useMemo. Adding `zones` to its BODY while
      // leaving `sidebarActivePanel` out of its dependency array froze the
      // Zones button's highlight at whatever it was when some unrelated panel
      // flag last changed -- it read "open" with the panel closed. Drive the
      // real hook through a real re-render.
      const seen: boolean[] = [];
      function Probe() {
        const { activeWorkspacePanels } = useWorkspacePanelControls();
        seen.push(activeWorkspacePanels.has('zones'));
        return null;
      }
      const host = document.createElement('div');
      document.body.appendChild(host);
      const probeRoot = createRoot(host);
      try {
        useViewerStore.getState().showWorkspacePanel('properties');
        act(() => probeRoot.render(<Probe />));
        assert.equal(seen.at(-1), false, 'closed to start with');

        act(() => { useViewerStore.getState().toggleWorkspacePanel('zones'); });
        assert.equal(seen.at(-1), true, 'the toolbar must see Zones open');

        act(() => { useViewerStore.getState().toggleWorkspacePanel('zones'); });
        assert.equal(seen.at(-1), false, 'and see it close again');
      } finally {
        act(() => probeRoot.unmount());
        host.remove();
      }
    });
  });

  describe('the panels host the apportionment UI', () => {
    it('the Zones panel hosts the whole-set control', () => {
      assert.match(bodyOf('ZonesPanel.tsx'), /<ZoneApportionSummary\b/, 'ZonesPanel must render the control');
    });

    it('the Properties panel hosts the per-element breakdown', () => {
      assert.match(bodyOf('PropertiesPanel.tsx'), /<ZoneVolumeBreakdown\b/, 'PropertiesPanel must render the breakdown');
    });
  });

  describe('driving the real components', () => {
    let container: HTMLDivElement;
    let root: Root;

    beforeEach(() => {
      container = document.createElement('div');
      document.body.appendChild(container);
      root = createRoot(container);
      useViewerStore.setState({
        zoneSets: [ZONE_SET],
        zoneAssignments: new Map(),
        zoneApportionment: new Map(),
      });
    });

    afterEach(() => {
      act(() => root.unmount());
      container.remove();
      useViewerStore.setState({ zoneSets: [], zoneAssignments: new Map(), zoneApportionment: new Map() });
    });

    it('the set control is disabled when nothing straddles, and says so', () => {
      act(() => root.render(<ZoneApportionSummary zoneSet={ZONE_SET} />));
      const button = container.querySelector('button');
      assert.ok(button, 'the control must render');
      assert.equal(button.disabled, true, 'nothing to split');
      assert.match(button.textContent ?? '', /0 straddlers/);
    });

    it('CLICKING it with a straddler present records the outcome, including a refusal', () => {
      // No renderer is mounted in the node runner, so every element refuses
      // with `no-geometry`. That is the point: the click must run the real
      // gather-and-run path, survive having no geometry, and REPORT it rather
      // than crash or silently produce an empty breakdown.
      useViewerStore.setState({
        zoneAssignments: new Map([[42, { zs1: { zoneId: 'a', zoneName: 'Area A', straddles: true, touchedZoneIds: ['a', 'b'] } }]]),
      });
      act(() => root.render(<ZoneApportionSummary zoneSet={ZONE_SET} />));
      const button = container.querySelector('button')!;
      assert.equal(button.disabled, false, 'a straddler makes the control live');
      assert.match(button.textContent ?? '', /1 straddler\b/);

      act(() => button.click());

      const entry = useViewerStore.getState().zoneApportionment.get('zs1');
      assert.ok(entry, 'the click must store a result');
      assert.equal(entry.revision, zoneSetRevision(ZONE_SET));
      assert.equal(entry.refused.get(42), 'no-geometry');
      assert.match(container.textContent ?? '', /no geometry loaded/i, 'and the panel must say what it skipped');
    });

    it('the per-element breakdown renders each zone with its basis and legend', () => {
      useViewerStore.setState({
        zoneApportionment: new Map([['zs1', {
          revision: zoneSetRevision(ZONE_SET),
          byElement: new Map([[42, {
            wholeVolumeM3: 7.2,
            shares: [
              { zoneId: 'a', zoneName: 'Area A', volumeM3: 2.88, fraction: 0.4 },
              { zoneId: 'b', zoneName: 'Area B', volumeM3: 4.32, fraction: 0.6 },
            ],
            outsideVolumeM3: 0,
            outsideFraction: 0,
            overlapping: false,
            unreliable: false,
          }]]),
          refused: new Map(),
          computedAt: 0,
          elapsedMs: 1,
        }]]),
      });
      act(() => root.render(
        <ZoneVolumeBreakdown
          zoneSet={ZONE_SET}
          globalId={42}
          quantitySets={[{ name: 'Qto_WallBaseQuantities', quantities: [{ name: 'NetVolume', type: 2, value: 4.5 }] }]}
          projectUnits={ProjectUnits.empty()}
          unitDisplayOverrides={{}}
        />,
      ));
      const text = container.textContent ?? '';
      assert.match(text, /Area A/);
      assert.match(text, /2\.88/, 'the mesh share must be shown');
      assert.match(text, /40\.0%/, 'and its fraction');
      // The declared basis is offered ALONGSIDE, reconciling with the file's
      // own NetVolume: 40% of 4.5 = 1.8.
      assert.match(text, /NetVolume/);
      assert.match(text, /1\.8/, 'the net breakdown must reconcile with the declared total');
      // #2199's rule: the legend renders beside the numbers, not in a tooltip.
      assert.match(text, /openings excluded/, 'the basis legend must be visible');
    });

    it('an apportionment computed against MOVED zones is not shown', () => {
      useViewerStore.setState({
        zoneApportionment: new Map([['zs1', {
          revision: 'stale-revision',
          byElement: new Map([[42, {
            wholeVolumeM3: 7.2,
            shares: [{ zoneId: 'a', zoneName: 'Area A', volumeM3: 2.88, fraction: 0.4 }],
            outsideVolumeM3: 0, outsideFraction: 0, overlapping: false, unreliable: false,
          }]]),
          refused: new Map(),
          computedAt: 0,
          elapsedMs: 1,
        }]]),
      });
      act(() => root.render(
        <ZoneVolumeBreakdown
          zoneSet={ZONE_SET}
          globalId={42}
          quantitySets={[]}
          projectUnits={ProjectUnits.empty()}
          unitDisplayOverrides={{}}
        />,
      ));
      assert.doesNotMatch(container.textContent ?? '', /2\.88/, 'a stale number must not be rendered');
      assert.match(container.textContent ?? '', /Split volume by zone/, 'it offers to recompute instead');
    });
  });

  describe('what the apportioned numbers are allowed to be read from', () => {
    const geometryWith = (volume: number) => ({
      meshes: [{ expressId: 42, geometryVolume: volume }],
    }) as never;

    afterEach(() => {
      useViewerStore.setState({ models: new Map(), geometryResult: null });
    });

    it('trusts a model federation alignment left alone', () => {
      useViewerStore.setState({
        geometryResult: null,
        models: new Map([['m1', {
          id: 'm1', name: 'A', visible: true, idOffset: 0, maxExpressId: 1e6, loadedAt: 1,
          ifcDataStore: null, geometryResult: geometryWith(2.5),
          federationAlignmentStatus: 'anchor',
        } as never]]),
      });
      const proved = gatherProvedVolumes();
      assert.equal(proved.byGlobalId.get(42), 2.5);
      assert.equal(proved.rescaled.has(42), false);
    });

    for (const status of ['same-crs', 'reprojected'] as const) {
      it(`names — rather than silently drops — a model alignment re-baked (${status})`, () => {
        // #1993: those two statuses re-bake every vertex through a map carrying
        // a scale, so 2.5 describes geometry at a size no longer drawn. Simply
        // omitting it would read downstream as "the kernel never proved one",
        // which points the user at the element instead of at the federation.
        useViewerStore.setState({
          geometryResult: null,
          models: new Map([['m1', {
            id: 'm1', name: 'A', visible: true, idOffset: 0, maxExpressId: 1e6, loadedAt: 1,
            ifcDataStore: null, geometryResult: geometryWith(2.5),
            federationAlignmentStatus: status,
          } as never]]),
        });
        const proved = gatherProvedVolumes();
        assert.equal(proved.byGlobalId.has(42), false, 'the stale magnitude must not be usable');
        assert.equal(proved.rescaled.has(42), true, 'and it must be named as rescaled');
      });
    }

    it('trusts the legacy single-model result, which never went through alignment', () => {
      useViewerStore.setState({ models: new Map(), geometryResult: geometryWith(2.5) });
      const proved = gatherProvedVolumes();
      assert.equal(proved.byGlobalId.get(42), 2.5);
      assert.equal(proved.rescaled.size, 0);
    });
  });

  describe('a new primary file does not serve the outgoing model\'s cubic metres', () => {
    it('resetViewerState drops the apportionment cache with the assignments', () => {
      // `validEntry` only checks the ZONE revision, and swapping the model does
      // not move a zone. So an entry that survives here is served against the
      // incoming file — and under the single-model fallback (globalId ===
      // expressId) the new model's ids collide with the old one's.
      useViewerStore.setState({
        zoneSets: [ZONE_SET],
        zoneAssignments: new Map([[42, { zs1: { zoneId: 'a', zoneName: 'Area A', straddles: true, touchedZoneIds: ['a', 'b'] } }]]),
        zoneApportionment: new Map([['zs1', {
          revision: zoneSetRevision(ZONE_SET),
          byElement: new Map([[42, {
            wholeVolumeM3: 7.2,
            shares: [{ zoneId: 'a', zoneName: 'Area A', volumeM3: 2.88, fraction: 0.4 }],
            outsideVolumeM3: 0, outsideFraction: 0, overlapping: false, unreliable: false,
          }]]),
          refused: new Map(),
          computedAt: 0,
          elapsedMs: 1,
        }]]),
      });

      useViewerStore.getState().resetViewerState();

      const after = useViewerStore.getState();
      assert.equal(after.zoneApportionment.size, 0, 'the cubic metres must go with the model they describe');
      assert.equal(after.zoneAssignments.size, 0, 'as the assignments they were computed from already do');
      // The user-authored SETS persist across a model load, like clash presets;
      // that contract must survive this fix rather than be traded for it.
      assert.equal(after.zoneSets.length, 1, 'the zone sets themselves are not model state');
      useViewerStore.setState({ zoneSets: [] });
    });
  });

  describe('the panel entry points land where they belong', () => {
    it('announces Zones by name instead of falling back to "Analysis"', () => {
      const seen: Array<string | null> = [];
      function Probe() {
        seen.push(useWorkspacePanelControls().workspacePanelLabel);
        return null;
      }
      const host = document.createElement('div');
      document.body.appendChild(host);
      const probeRoot = createRoot(host);
      try {
        act(() => probeRoot.render(<Probe />));
        act(() => { useViewerStore.getState().toggleWorkspacePanel('zones'); });
        assert.equal(seen.at(-1), 'Location Zones');
      } finally {
        act(() => probeRoot.unmount());
        host.remove();
        useViewerStore.getState().showWorkspacePanel('properties');
      }
    });

    it('does not promote a BOTTOM panel into the single-tenant side slot', () => {
      // `openWorkspacePanel` has no `isBottomPanel` early return of its own —
      // `showWorkspacePanel` does — so the unflagged-panel line added for Zones
      // would otherwise dock Lists into the sidebar when a popped-out Lists
      // window re-docks through here.
      useViewerStore.getState().showWorkspacePanel('properties');
      useViewerStore.getState().openWorkspacePanel('lists');
      assert.equal(
        useViewerStore.getState().sidebarActivePanel,
        'properties',
        'a bottom-strip panel must not take the side slot',
      );
      // The control: a side panel with no flag of its own still docks.
      useViewerStore.getState().openWorkspacePanel('zones');
      assert.equal(useViewerStore.getState().sidebarActivePanel, 'zones');
      useViewerStore.getState().showWorkspacePanel('properties');
    });
  });

  describe('no apportionment outlives the zone set it describes', () => {
    const seededEntry = () => ({
      revision: zoneSetRevision(ZONE_SET),
      byElement: new Map([[42, {
        wholeVolumeM3: 7.2,
        shares: [{ zoneId: 'a', zoneName: 'Area A', volumeM3: 2.88, fraction: 0.4 }],
        outsideVolumeM3: 0, outsideFraction: 0, overlapping: false, unreliable: false,
      }]]),
      refused: new Map(),
      computedAt: 0,
      elapsedMs: 1,
    });

    it('removing the set drops its entry', () => {
      // `validEntry` cannot retire this: it is only ever asked about a set that
      // still exists, so an entry for a deleted set is never read AND never
      // freed — one Map per apportioned element, for the session.
      useViewerStore.setState({ zoneSets: [ZONE_SET], zoneApportionment: new Map([['zs1', seededEntry() as never]]) });
      useViewerStore.getState().removeZoneSet('zs1');
      assert.equal(useViewerStore.getState().zoneApportionment.has('zs1'), false);
    });

    it('an import that replaces every set drops what did not come back', () => {
      useViewerStore.setState({
        zoneSets: [ZONE_SET],
        zoneApportionment: new Map([['zs1', seededEntry() as never], ['other', seededEntry() as never]]),
      });
      const json = JSON.stringify(JSON.parse(useViewerStore.getState().exportZoneSetsJSON()));
      const result = useViewerStore.getState().importZoneSetsJSON(json);
      assert.equal(result.ok, true, 'the fixture must be importable, or this test proves nothing');
      const after = useViewerStore.getState().zoneApportionment;
      assert.equal(after.has('other'), false, 'a set that did not come back is orphaned');
      // A set that DID come back keeps its entry; the revision retires it on
      // the next read if its zones changed, which is the case the revision owns.
      assert.equal(after.has('zs1'), true, 'a surviving set keeps its cached split');
      useViewerStore.setState({ zoneSets: [], zoneApportionment: new Map() });
    });

    it('keeps the SAME map when nothing is orphaned', () => {
      const cache = new Map([['zs1', seededEntry() as never]]);
      useViewerStore.setState({ zoneSets: [ZONE_SET, { ...ZONE_SET, id: 'zs2' }], zoneApportionment: cache });
      useViewerStore.getState().removeZoneSet('zs2');
      assert.equal(useViewerStore.getState().zoneApportionment, cache, 'no allocation on the common path');
      useViewerStore.setState({ zoneSets: [], zoneApportionment: new Map() });
    });
  });

  describe('the per-element breakdown never renders a dead end', () => {
    let bcontainer: HTMLDivElement;
    let broot: Root;
    const mount = (globalId: number) => {
      act(() => broot.render(
        <ZoneVolumeBreakdown
          zoneSet={ZONE_SET}
          globalId={globalId}
          quantitySets={[]}
          projectUnits={ProjectUnits.empty()}
          unitDisplayOverrides={{}}
        />,
      ));
    };

    beforeEach(() => {
      bcontainer = document.createElement('div');
      document.body.appendChild(bcontainer);
      broot = createRoot(bcontainer);
      useViewerStore.setState({ zoneSets: [ZONE_SET], zoneApportionment: new Map() });
    });

    afterEach(() => {
      act(() => broot.unmount());
      bcontainer.remove();
      useViewerStore.setState({ zoneSets: [], zoneApportionment: new Map() });
    });

    const entryRefusing = (globalId: number, reason: string) => new Map([['zs1', {
      revision: zoneSetRevision(ZONE_SET),
      byElement: new Map(),
      refused: new Map([[globalId, reason]]),
      computedAt: 0,
      elapsedMs: 1,
    } as never]]);

    it('explains the federation-alignment refusal instead of rendering an empty box', () => {
      useViewerStore.setState({ zoneApportionment: entryRefusing(42, 'rescaled-by-alignment') });
      mount(42);
      const text = bcontainer.textContent ?? '';
      assert.match(text, /Federation alignment rescaled/, text);
      assert.doesNotMatch(text, /Split volume by zone/, 'and the split button stays suppressed');
    });

    it('says SOMETHING for a refusal code it has no sentence for', () => {
      // The Split button is gated on `reason` being falsy, so an unhandled
      // reason renders a box with no explanation and no way forward — the
      // failure mode that adding a third reason without a branch produced.
      useViewerStore.setState({ zoneApportionment: entryRefusing(42, 'some-future-reason' as never) });
      mount(42);
      const text = bcontainer.textContent ?? '';
      assert.match(text, /could not be split \(some-future-reason\)/, text);
    });

    it('does not carry one element\'s refusal onto the next', () => {
      // No renderer in this runner, so clicking Split refuses with
      // `no-geometry` and the refusal is stored LOCALLY (the store entry is
      // written too, but keyed by that element). Selecting a different element
      // must offer its own Split button, not the previous one\'s excuse.
      mount(42);
      const button = [...bcontainer.querySelectorAll('button')].find((b) => /Split volume by zone/.test(b.textContent ?? ''));
      assert.ok(button, 'the first element must offer a split');
      act(() => button.click());
      assert.match(bcontainer.textContent ?? '', /No geometry loaded/, 'it refused, as expected here');

      mount(99);
      const text = bcontainer.textContent ?? '';
      assert.match(text, /Split volume by zone/, `the next element must get its own control: ${text}`);
    });
  });
});

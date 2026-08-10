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
import { ZoneApportionSummary } from './ZoneApportionSummary.js';
import { ZoneVolumeBreakdown } from './ZoneVolumeBreakdown.js';
import { zoneSetRevision } from '@/lib/zones';
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
});

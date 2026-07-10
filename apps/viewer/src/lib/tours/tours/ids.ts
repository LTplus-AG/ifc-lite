/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * IDS validation tour: load a spec, run validation, and chase a failing
 * element down in 3D. The loaded document, the report, and the red/green
 * tint are the user's work products and are kept on finish; only the
 * isolate state is cleaned up (finish and abort). Target: about 3 minutes.
 */

import { activityAnchor, TOUR_ANCHORS } from '../anchors';
import { DEMO_MODEL_NAMES, loadDemoIds, loadDemoProject, waitForModelSettled } from '../demo-kit';
import type { TourDefinition } from '../types';

/** "modelId:expressId" - the idsFailedEntityIds key format (idsSlice). */
function looksLikeEntityKey(value: unknown): boolean {
  return typeof value === 'string' && /:\d+$/.test(value);
}

export const IDS_TOUR: TourDefinition = {
  id: 'ids',
  title: 'Validate your model with IDS',
  description: 'Check the model against an IDS requirements spec and chase failures down in 3D.',
  minutes: 3,
  version: 1,
  panel: 'ids',
  prerequisites: { modelLoaded: true },
  steps: [
    {
      id: 'open-panel',
      kind: 'action',
      anchor: activityAnchor('ids'),
      placement: 'left',
      title: 'Open IDS validation',
      body: 'Open the IDS panel from the sidebar rail, or press Alt+4. IDS checks your model against machine-readable requirements.',
      // No prepare: the user opens the panel themselves. If it is already
      // open the entry-time gate check advances silently, which is fine.
      gate: { predicate: (s) => s.idsPanelVisible },
    },
    {
      id: 'load-spec',
      kind: 'action',
      anchor: TOUR_ANCHORS.idsLoad,
      panel: 'ids',
      placement: 'left',
      title: 'Load a spec',
      body: 'Click Load IDS File and pick a .ids file. No spec handy? Load the demo spec instead.',
      action: {
        label: 'Load demo spec',
        // The demo spec is authored against the demo project; validating an
        // arbitrary user model against it would be noise. Swap in the demo
        // project first when it is not already loaded.
        run: async (store) => {
          const models = [...store.getState().models.values()];
          // Exact kit names only, so a user's own similarly-named file is
          // not mistaken for the demo and the swap is skipped wrongly.
          const demoLoaded = models.some(
            (m) => m.name === DEMO_MODEL_NAMES.base || m.name === DEMO_MODEL_NAMES.revB,
          );
          if (!demoLoaded) {
            await loadDemoProject();
            await waitForModelSettled();
          }
          await loadDemoIds();
        },
      },
      // The demo action may REPLACE the loaded model set; without this the
      // run watcher would treat that as a destructive model change.
      expectsModelLoad: true,
      gate: {
        predicate: (s) => s.idsDocument !== null,
        // Hunting for a file in the OS dialog takes a while; don't nag.
        hintAfterMs: 30_000,
      },
    },
    {
      id: 'run-validation',
      kind: 'action',
      anchor: TOUR_ANCHORS.idsRun,
      panel: 'ids',
      placement: 'left',
      title: 'Run validation',
      body: 'Click Run Validation. Checks run in a background worker, so the viewer stays responsive.',
      // A report may already exist at entry (re-entry, prior run). The step
      // must complete on a NEW report, so baseline the old report's
      // timestamp (a Date; coerced via new Date() in case worker transfer
      // ever downgrades it to a string) and require it to change.
      arm: (state, ctx) => {
        const report = state.idsValidationReport;
        ctx.baseline.hadReport = report ? 1 : 0;
        ctx.baseline.reportTimestamp = report ? new Date(report.timestamp).getTime() : 0;
      },
      gate: {
        predicate: (s, ctx) => {
          const report = s.idsValidationReport;
          if (report === null || s.idsLoading) return false;
          if (ctx.baseline.hadReport === 0) return true;
          return new Date(report.timestamp).getTime() !== ctx.baseline.reportTimestamp;
        },
        // Validating a large model legitimately runs for a while.
        hintAfterMs: 30_000,
      },
    },
    {
      id: 'read-results',
      kind: 'passive',
      anchor: TOUR_ANCHORS.idsSummary,
      panel: 'ids',
      placement: 'left',
      title: 'Read the results',
      body: 'The summary counts checked, passed, and failed elements per specification. Failed elements are already tinted red in 3D.',
    },
    {
      id: 'jump-to-failure',
      kind: 'action',
      anchor: TOUR_ANCHORS.idsResults,
      panel: 'ids',
      placement: 'left',
      title: 'Jump to a failure',
      body: 'Expand a failed specification and click a red element. The viewer selects it and zooms straight to it.',
      gate: {
        // Clicking a FAILED element completes the step; membership rides
        // the cached "modelId:expressId" key set. If that format ever
        // drifts (or the set is empty), degrade to any results click
        // rather than never firing.
        predicate: (s) => {
          const active = s.idsActiveEntityId;
          if (active === null) return false;
          try {
            const failed = s.idsFailedEntityIds;
            const probe = failed.values().next().value;
            if (!looksLikeEntityKey(probe)) return true;
            return failed.has(`${active.modelId}:${active.expressId}`);
          } catch {
            return true;
          }
        },
      },
    },
    {
      id: 'isolate-failed',
      kind: 'action',
      anchor: TOUR_ANCHORS.idsIsolateFailed,
      panel: 'ids',
      placement: 'left',
      title: 'Isolate the failures',
      body: 'Click the crossed-eye button to hide everything that passed. When done, export the report as HTML, JSON, or BCF from this toolbar.',
      gate: { predicate: (s) => s.idsIsolateMode === 'failed' },
      // Isolation must not outlive the tour (finish or abort). Guarded on
      // the IDS isolate being the live one so an isolation the user applied
      // through another feature is never clobbered. The report, document,
      // and red/green tint are deliberately NOT touched.
      cleanup: (store) => {
        const s = store.getState();
        if (s.idsIsolateMode !== null) {
          s.setIsolatedEntities(null);
          s.setIdsIsolateMode(null);
        }
      },
    },
  ],
};

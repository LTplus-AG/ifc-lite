/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Scripting tour: open the bottom-docked Script editor, load the Data
 * quality audit template, run it, and read the output. The audit's
 * colorizeAll recolor is the visible outcome and is KEPT on finish; on
 * abort the snapshot cannot restore color overrides (not a UiSnapshot
 * field), which is accepted, consistent with pre-existing engine behavior -
 * the wrap copy points at the Reset view template as the undo. The
 * template pick creates a persisted saved script; step 3's cleanup removes
 * it again only while it is still an untouched copy of the template.
 * Target: about 3 minutes.
 */

import { activityAnchor, TOUR_ANCHORS } from '../anchors';
import type { TourDefinition } from '../types';

const AUDIT_TEMPLATE_NAME = 'Data quality audit';

/**
 * The audit template's source, resolved lazily in the run-step prepare().
 * A static import of `@/lib/scripts/templates` would drag its Vite `?raw`
 * imports into the registry test's node/tsx module graph, which cannot
 * resolve them - so the tour only touches the module at runtime in the
 * browser, where it is already part of the bundle.
 */
let auditTemplateCode: string | null = null;

async function resolveAuditTemplate(): Promise<void> {
  try {
    const { SCRIPT_TEMPLATES } = await import('@/lib/scripts/templates');
    auditTemplateCode = SCRIPT_TEMPLATES.find((t) => t.name === AUDIT_TEMPLATE_NAME)?.code ?? null;
  } catch (err) {
    console.warn('[tours] script templates unavailable:', err);
    auditTemplateCode = null;
  }
}

export const SCRIPTING_TOUR: TourDefinition = {
  id: 'scripting',
  title: 'Automate with scripts',
  description: 'Run a ready-made audit script against the model and read its scored findings.',
  minutes: 3,
  version: 1,
  panel: 'script',
  prerequisites: { modelLoaded: true },
  steps: [
    {
      id: 'open-panel',
      kind: 'action',
      anchor: activityAnchor('script'),
      placement: 'left',
      title: 'Open the Script editor',
      body: 'Open the Script editor from the sidebar rail, or press Alt+8. It docks at the bottom of the workspace.',
      gate: { predicate: (s) => s.scriptPanelVisible },
    },
    {
      id: 'workbench',
      kind: 'passive',
      anchor: TOUR_ANCHORS.scriptEditor,
      panel: 'script',
      placement: 'top',
      title: 'Your scripting workbench',
      body: 'Scripts run in a sandbox with full model access through the bim API. Type bim. in the editor for autocomplete.',
    },
    {
      id: 'load-example',
      kind: 'action',
      anchor: TOUR_ANCHORS.scriptNew,
      panel: 'script',
      placement: 'top',
      title: 'Load an example',
      body: 'Click the + button and choose Data quality audit. It loads a ready-made script that scores data completeness.',
      arm: (state, ctx) => {
        ctx.baseline.savedScripts = state.savedScripts.length;
        ctx.baseline.hadActive = state.activeScriptId !== null ? 1 : 0;
        // The entry-time active id (a string, so it rides artifacts, not the
        // numeric baseline). The cleanup uses it to tell the tour-created
        // template copy apart from whatever was active before.
        ctx.artifacts.set('entryActiveScriptId', state.activeScriptId);
      },
      prepare: async () => {
        await resolveAuditTemplate();
      },
      gate: {
        // A new saved script whose code IS the audit template. Picking a
        // different template keeps the gate unsatisfied (re-pick or skip).
        // If the template was renamed out from under us, degrade to "any
        // new script became active" instead of never firing.
        predicate: (s, ctx) => {
          if (s.savedScripts.length <= ctx.baseline.savedScripts) return false;
          if (s.activeScriptId === null) return false;
          if (auditTemplateCode === null) return true;
          const active = s.savedScripts.find((x) => x.id === s.activeScriptId);
          return active !== undefined && active.code === auditTemplateCode;
        },
      },
      // The pick persisted a saved script. Remove it on finish/abort ONLY
      // while it is still an untouched copy of the template (an edited
      // script is the user's work), then restore the prior selection.
      cleanup: (store, ctx) => {
        if (auditTemplateCode === null) return;
        const s = store.getState();
        const entryActive = ctx.artifacts.get('entryActiveScriptId');
        // Only ever delete the CURRENTLY ACTIVE script: the tour's pick
        // became active on creation (the gate proved that). Matching by
        // code across all saved scripts could hit a template copy the user
        // saved BEFORE the tour; if they switched scripts afterwards, do
        // nothing rather than guess.
        const created = s.savedScripts.find(
          (x) => x.id === s.activeScriptId && x.code === auditTemplateCode && x.id !== entryActive,
        );
        if (!created) return;
        s.deleteScript(created.id);
        if (typeof entryActive === 'string') {
          const after = store.getState();
          if (after.savedScripts.some((x) => x.id === entryActive)) {
            after.setActiveScriptId(entryActive);
          }
        }
      },
    },
    {
      id: 'run-it',
      kind: 'action',
      anchor: TOUR_ANCHORS.scriptRun,
      panel: 'script',
      placement: 'top',
      title: 'Run it',
      body: 'Click Run or press Ctrl+Enter. The script scans every element and colors the 3D view by data quality.',
      arm: (state, ctx) => {
        ctx.baseline.scriptRunSeq = state.scriptRunSeq;
      },
      gate: {
        predicate: (s, ctx) =>
          s.scriptRunSeq > ctx.baseline.scriptRunSeq && s.scriptExecutionState === 'success',
        // Scanning a large model can legitimately run for a while.
        hintAfterMs: 30_000,
      },
    },
    {
      id: 'read-output',
      kind: 'passive',
      anchor: TOUR_ANCHORS.scriptOutput,
      panel: 'script',
      placement: 'top',
      title: 'Read the results',
      body: 'The Output console shows the completeness score and per-type findings. The script also saved a CSV report to your downloads.',
    },
    {
      id: 'wrap',
      kind: 'passive',
      anchor: TOUR_ANCHORS.scriptChatToggle,
      panel: 'script',
      placement: 'top',
      title: 'Keep going',
      body: 'The AI assistant can write and fix scripts for you. Save with Ctrl+S, or run the Reset view template to clear the audit colors.',
    },
  ],
};

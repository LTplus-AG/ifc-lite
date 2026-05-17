/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Starter `AuthoringPlan` stubs for the Ideas panel.
 *
 * The miner only fires once a user's action log has enough repeats to
 * suggest a recurring workflow. New users start with an empty log;
 * without seed content the Ideas panel reads "no suggestions yet" and
 * gives no sense of what extensions can be.
 *
 * These starters are hand-picked IFC/AEC workflows that map cleanly
 * onto the v1 contribution + capability vocabulary. The Ideas panel
 * shows them tagged "Example" when the mined-pattern list is empty.
 * Clicking one opens the Plan Card with the stub pre-filled — same
 * approval flow as a mined suggestion.
 *
 * Spec: docs/architecture/ai-customization/06-self-improvement.md §3.4.
 */

import type { AuthoringPlan } from '../authoring/plan.js';

export interface StarterIdea {
  /** Stable id for tracking + dedup. */
  id: string;
  /** What category of workflow this exercises. */
  category: 'compliance' | 'export' | 'visualisation' | 'audit' | 'productivity';
  /** Optional emoji used in the Ideas panel list. */
  icon?: string;
  /** The pre-filled plan the PlanCard renders on click. */
  plan: AuthoringPlan;
}

/**
 * Build a "command + toolbar + capability" plan from a few fields.
 * Keeps every starter consistent in shape so the Plan Card renders
 * them all the same way.
 */
function plan(opts: {
  slug: string;
  summary: string;
  rationale: string;
  capabilities: readonly string[];
  contributesToolbar?: boolean;
  contributesLens?: boolean;
  contributesExporter?: boolean;
  triggers?: readonly string[];
  testFixture?: string;
}): AuthoringPlan {
  const commandId = `ext.suggested.${opts.slug}.run`;
  const contributions: AuthoringPlan['contributions'] = [
    { kind: 'command', label: opts.summary, id: commandId, slot: 'commandPalette' },
  ];
  if (opts.contributesToolbar) {
    contributions.push({ kind: 'toolbar', label: `Toolbar: ${opts.summary}`, id: commandId, slot: 'toolbar.right' });
  }
  if (opts.contributesLens) {
    contributions.push({ kind: 'lens', label: `Lens: ${opts.summary}`, id: `lens.${opts.slug}`, slot: 'lensLibrary' });
  }
  if (opts.contributesExporter) {
    contributions.push({ kind: 'exporter', label: `Exporter: ${opts.summary}`, id: `export.${opts.slug}`, slot: 'exportMenu' });
  }
  return {
    summary: opts.summary,
    rationale: opts.rationale,
    contributions,
    capabilities: [...opts.capabilities],
    triggers: [...(opts.triggers ?? [`onCommand:${commandId}`])],
    widgets: [],
    tests: opts.testFixture
      ? [{
          name: `${opts.summary} smoke`,
          fixture: opts.testFixture,
          assertionSummary: 'Tool returns a non-error result for the fixture',
        }]
      : [],
  };
}

/**
 * Curated starter set. Every entry is something an AEC professional
 * recognises as a real workflow — promote-to-tool from one-off
 * scripting habits.
 */
export const STARTER_IDEAS: readonly StarterIdea[] = [
  {
    id: 'starter.fire-rating-audit',
    category: 'compliance',
    icon: '🛡️',
    plan: plan({
      slug: 'fire-rating-audit',
      summary: 'Highlight walls missing Pset_WallCommon.FireRating',
      rationale:
        'BS 9999 / IBC compliance reviews need every fire-rated assembly identified. This tool colors walls red when the FireRating property is missing or empty so the modeller can see the gaps at a glance.',
      capabilities: ['model.read', 'viewer.colorize'],
      contributesToolbar: true,
      contributesLens: true,
      testFixture: 'residential-small',
    }),
  },
  {
    id: 'starter.door-schedule-csv',
    category: 'export',
    icon: '🚪',
    plan: plan({
      slug: 'door-schedule-csv',
      summary: 'Export a door schedule as CSV',
      rationale:
        'Door schedules are a standard contract deliverable. This exporter walks every IfcDoor, pulls name + size + Pset_DoorCommon.FireRating + Pset_DoorCommon.AcousticRating, and emits a CSV ready for the schedule template.',
      capabilities: ['model.read', 'export.create:csv'],
      contributesToolbar: true,
      contributesExporter: true,
      testFixture: 'residential-small',
    }),
  },
  {
    id: 'starter.quantity-takeoff',
    category: 'export',
    icon: '📐',
    plan: plan({
      slug: 'wall-quantity-takeoff',
      summary: 'Wall quantity takeoff (NetSideArea + NetVolume) to CSV',
      rationale:
        'Quantity takeoff for tender pricing. The tool collects Qto_WallBaseQuantities for every IfcWall and groups by type, level, and material, dumping rows ready to paste into the BoQ.',
      capabilities: ['model.read', 'export.create:csv'],
      contributesToolbar: true,
      contributesExporter: true,
      testFixture: 'office-medium',
    }),
  },
  {
    id: 'starter.storey-isolate',
    category: 'productivity',
    icon: '🏢',
    plan: plan({
      slug: 'storey-isolate-keybind',
      summary: 'Cmd+I to isolate the active storey',
      rationale:
        'During floor plan review the modeller flips between storeys constantly. A keybound command that isolates the selected storey (and shows everything else dimmed) saves the hierarchy-panel round trip.',
      capabilities: ['model.read', 'viewer.isolate'],
      triggers: ['onCommand:ext.suggested.storey-isolate-keybind.run'],
    }),
  },
  {
    id: 'starter.classification-lens',
    category: 'visualisation',
    icon: '🎨',
    plan: plan({
      slug: 'uniclass-lens',
      summary: 'Color elements by Uniclass code',
      rationale:
        'COBie / Uniclass adoption audits — color every element by its first classification reference and surface which ones have none. Useful for handover prep and BS 1192-4 checks.',
      capabilities: ['model.read', 'viewer.colorize'],
      contributesToolbar: true,
      contributesLens: true,
      testFixture: 'office-medium',
    }),
  },
  {
    id: 'starter.ids-quick-check',
    category: 'audit',
    icon: '✅',
    plan: plan({
      slug: 'ids-quick-check',
      summary: 'Quick IDS check on selected entity types',
      rationale:
        'Run a focused IDS rule subset against just the entity types currently selected. Faster than the full IDS panel run when iterating on a small change.',
      capabilities: ['model.read'],
      contributesToolbar: true,
    }),
  },
];

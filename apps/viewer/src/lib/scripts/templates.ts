/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Built-in script templates for the script editor.
 *
 * Templates are real .ts files in ./templates/ that are type-checked
 * against the bim-globals.d.ts declaration. They are loaded as raw
 * strings via Vite's ?raw import and served to the sandbox transpiler.
 *
 * Each template targets a specific stakeholder and combines multiple
 * API calls into automated workflows that go beyond what the UI can
 * do through manual clicking.
 */

// Raw source imports — Vite returns the file content as a string
import dataQualityAudit from './templates/data-quality-audit.ts?raw';
import fireSafetyCheck from './templates/fire-safety-check.ts?raw';
import quantityTakeoff from './templates/quantity-takeoff.ts?raw';
import envelopeCheck from './templates/envelope-check.ts?raw';
import mepEquipmentSchedule from './templates/mep-equipment-schedule.ts?raw';
import spaceValidation from './templates/space-validation.ts?raw';
import federationCompare from './templates/federation-compare.ts?raw';
import resetView from './templates/reset-view.ts?raw';
import createBuilding from './templates/create-building.ts?raw';
import constructionSchedule from './templates/construction-schedule.ts?raw';
import costReport from './templates/cost-report.ts?raw';

// Real import (this file, unlike the templates above, runs as normal app
// code — not inside the QuickJS script sandbox) so the `cost-report`
// template's cycle-code check can be injected from the Cost panel's own
// list rather than hand-copied (finding: templates.ts and cost-tree.ts
// must agree on which diagnostic codes count as "cyclic" — see
// templates.test.ts).
import { CYCLE_CODES_LIST } from '../cost/cost-tree';

export interface ScriptTemplate {
  name: string;
  description: string;
  code: string;
}

/** Strip the `export {}` module boundary line that enables type checking */
function stripModuleLine(raw: string): string {
  return raw.replace(/^export \{\}[^\n]*\n\n?/, '');
}

/**
 * Substitute the `cost-report` template's placeholder cycle-code literal
 * with the real, current `CYCLE_CODES_LIST` from `cost-tree.ts` — the
 * script sandbox has no module resolution of its own, so this is the only
 * point where the template and the Cost panel can share one source of
 * truth. Throws if the marker is missing so a future edit to the template
 * can't silently drop the substitution.
 */
function injectCycleCodes(raw: string): string {
  const marker = /const cycleCodes: string\[\] = \[[^\]]*\] \/\/ CYCLE_CODES_INJECT/;
  if (!marker.test(raw)) {
    throw new Error('cost-report.ts: CYCLE_CODES_INJECT marker not found — template/cost-tree.ts sync is broken');
  }
  return raw.replace(marker, `const cycleCodes: string[] = ${JSON.stringify(CYCLE_CODES_LIST)} // CYCLE_CODES_INJECT`);
}

export const SCRIPT_TEMPLATES: ScriptTemplate[] = [
  {
    name: 'Data quality audit',
    description:
      'BIM Manager — scan all entities for missing names, properties, and quantities; score model completeness; color-code by data quality',
    code: stripModuleLine(dataQualityAudit),
  },
  {
    name: 'Fire safety compliance',
    description:
      'Architect — check fire ratings across walls, doors, and slabs; flag load-bearing elements without ratings; export non-compliant list',
    code: stripModuleLine(fireSafetyCheck),
  },
  {
    name: 'Quantity takeoff',
    description:
      'Cost Estimator — aggregate area, volume, and length quantities across all element types; generate material takeoff table and CSV',
    code: stripModuleLine(quantityTakeoff),
  },
  {
    name: 'Envelope & thermal check',
    description:
      'Energy Consultant — identify external elements, check thermal transmittance values, isolate building envelope, flag missing data',
    code: stripModuleLine(envelopeCheck),
  },
  {
    name: 'MEP equipment schedule',
    description:
      'HVAC Engineer — discover all distribution elements, extract equipment properties, generate schedule, isolate and color by system',
    code: stripModuleLine(mepEquipmentSchedule),
  },
  {
    name: 'Space & room validation',
    description:
      'Facility Manager — validate IfcSpace entities for area, volume, naming; generate room schedule with totals; flag incomplete spaces',
    code: stripModuleLine(spaceValidation),
  },
  {
    name: 'Federation comparison',
    description:
      'Project Manager — compare multiple loaded models side by side: entity counts, type coverage, naming consistency, coordination issues',
    code: stripModuleLine(federationCompare),
  },
  {
    name: 'Create building (IFC from scratch)',
    description:
      'Developer — generate a complete IFC file with walls, slab, columns, beams, stair, and parametric timber gridshell roof with diamond lattice',
    code: stripModuleLine(createBuilding),
  },
  {
    name: 'Construction schedule (4D)',
    description:
      'Scheduler — build an IfcWorkSchedule with IfcTasks, IfcRelSequence dependencies, and product assignments that drive the 4D Gantt animation. Accepts a CSV attachment for real task data.',
    code: stripModuleLine(constructionSchedule),
  },
  {
    name: 'Cost report (5D)',
    description:
      'Cost Estimator — read the loaded IfcCostSchedule/IfcCostItem graph via bim.cost, print resolved amounts (or diagnostics for what could not be evaluated), and download the report as JSON. Read-only.',
    code: stripModuleLine(injectCycleCodes(costReport)),
  },
  {
    name: 'Reset view',
    description: 'Utility — remove all color overrides and show all entities',
    code: stripModuleLine(resetView),
  },
];

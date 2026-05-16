/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Plan-stub generator.
 *
 * Turns a mined pattern into an `AuthoringPlan` skeleton that the
 * AI authoring pipeline can take as a starting point. The user sees
 * the stub on the plan card, edits as desired, then approves.
 *
 * Conservative defaults: contributes ONE command + ONE keybinding;
 * capabilities derived from intent → capability mapping; tests as a
 * single fixture-bound smoke test. The LLM authoring step can flesh
 * out the actual contributions.
 *
 * Spec: docs/architecture/ai-customization/06-self-improvement.md §3.2.
 */

import type { AuthoringPlan, PlannedContribution } from '../authoring/plan.js';
import { suggestedCommandId } from '../ids.js';
import type { ActionIntent } from '../log/types.js';
import type { MinedPattern } from './types.js';

/** Conservative capability inference per intent. */
const INTENT_CAPABILITIES: Record<ActionIntent, readonly string[]> = {
  'model.load': ['model.read'],
  'model.unload': [],
  'query.run': ['model.read'],
  'lens.apply': ['viewer.colorize'],
  'lens.clear': ['viewer.colorize'],
  'export.run': ['model.read', 'export.create:*'],
  'script.execute': ['model.read'],
  'chat.message': [],
  'extension.install': [],
  'extension.uninstall': [],
  'extension.enable': [],
  'extension.disable': [],
  'flavor.activate': [],
  'flavor.export': [],
  'flavor.import': [],
  'selection.change': ['viewer.read'],
  'section.apply': ['viewer.section'],
  'view.change': ['viewer.fly'],
};

/**
 * Translate a mined pattern into a starting plan. The caller wires
 * this into the suggestion-acceptance flow that hands the plan to the
 * chat panel for AI authoring.
 */
export function planFromPattern(pattern: MinedPattern): AuthoringPlan {
  const verb = humanVerb(pattern.sequence);
  const caps = unionCaps(pattern.sequence);
  const slug = pattern.sequence.join('-').replace(/[^a-z0-9-]/g, '');
  const commandId = suggestedCommandId(slug);

  const contributions: PlannedContribution[] = [
    {
      kind: 'command',
      label: `One-click "${verb}"`,
      id: commandId,
      slot: 'commandPalette',
    },
    {
      kind: 'toolbar',
      label: `Toolbar button for "${verb}"`,
      id: commandId,
      slot: 'toolbar.right',
    },
  ];

  return {
    summary: `Make a one-click tool for "${verb}"`,
    rationale: humanRationale(pattern, verb),
    contributions,
    capabilities: caps,
    triggers: [`onCommand:${commandId}`],
    widgets: [],
    tests: [{
      name: 'Tool executes against the canonical fixture',
      fixture: 'residential-small',
      assertionSummary: 'Tool returns a non-error result for the residential model',
    }],
    notes: `Suggested from a pattern observed ${pattern.occurrences} times across ${pattern.sessionsTouched} session(s). Last seen ${pattern.lastSeenAt}.`,
  };
}

function humanVerb(sequence: readonly ActionIntent[]): string {
  const last = sequence[sequence.length - 1];
  const head = sequence[0];
  const tail = INTENT_VERBS[last] ?? last;
  const start = INTENT_VERBS[head] ?? head;
  if (sequence.length === 1) return tail;
  return `${start} → ${tail}`;
}

const INTENT_VERBS: Partial<Record<ActionIntent, string>> = {
  'model.load': 'load model',
  'query.run': 'run query',
  'lens.apply': 'apply lens',
  'lens.clear': 'clear lens',
  'export.run': 'export',
  'script.execute': 'run script',
  'selection.change': 'select',
  'section.apply': 'apply section',
  'view.change': 'change view',
};

function humanRationale(pattern: MinedPattern, verb: string): string {
  return (
    `You've performed this sequence ${pattern.occurrences} times across `
    + `${pattern.sessionsTouched} session(s). Wrapping "${verb}" as a `
    + `one-click tool keeps it accessible from the command palette and `
    + `the toolbar without repeating the steps manually.`
  );
}

function unionCaps(sequence: readonly ActionIntent[]): string[] {
  const set = new Set<string>();
  for (const intent of sequence) {
    for (const cap of INTENT_CAPABILITIES[intent] ?? []) set.add(cap);
  }
  return Array.from(set).sort();
}

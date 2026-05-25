/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';
import {
  CURATED_PROMPTS,
  TARGETS,
  runAuthoringBenchmark,
  type BenchmarkPrompt,
} from './authoring-bench.js';
import type { AuthoringMessage, AuthoringTurn } from '../authoring/repair.js';

/**
 * Build a canned bundle response that satisfies a prompt's expect
 * criteria. Used by the stub LLM step to simulate a perfect-recall
 * authoring agent.
 */
function cannedBundleFor(prompt: BenchmarkPrompt): string {
  const id = `ext.example.${prompt.id}`;
  const commandId = `${id}.run`;
  const caps = prompt.expect.capabilities ?? ['model.read'];
  const kinds = prompt.expect.contributesKinds ?? ['commands'];
  const contributes: Record<string, unknown> = {};
  if (kinds.includes('commands')) {
    contributes.commands = [{ id: commandId, title: 'Run' }];
  }
  if (kinds.includes('toolbar')) {
    contributes.toolbar = [{ command: commandId, slot: 'toolbar.right' }];
  }
  if (kinds.includes('keybindings')) {
    contributes.keybindings = [{ command: commandId, key: 'cmd+k' }];
  }
  if (kinds.includes('lenses')) {
    contributes.lenses = [{ id: 'lens.fire-rating', title: 'Fire rating', widget: 'widgets/lens.json' }];
  }
  if (kinds.includes('contextMenu')) {
    contributes.contextMenu = [{ command: commandId, slot: 'contextMenu.entity' }];
  }
  if (kinds.includes('statusBar')) {
    contributes.statusBar = [{ slot: 'statusBar.right', text: 'doors: 0' }];
  }
  if (kinds.includes('dock')) {
    contributes.dock = [{ id: 'dock-panel', slot: 'dock.right', title: 'Panel', widget: 'widgets/dock.json' }];
  }
  const manifest = {
    manifestVersion: 1,
    id,
    name: prompt.id,
    description: prompt.user.slice(0, 60),
    version: '1.0.0',
    engines: { ifcLiteSdk: '>=2.0.0' },
    capabilities: caps,
    activation: [`onCommand:${commandId}`],
    contributes,
    entry: { commands: { [commandId]: 'src/run.js' } },
  };
  return [
    '```ifc-extension-manifest',
    JSON.stringify(manifest, null, 2),
    '```',
    '',
    '```ifc-extension-code path="src/run.js"',
    `async function run(ctx) { return { ok: true }; }`,
    '```',
  ].join('\n');
}

describe('eval: authoring success-rate benchmark', () => {
  it('exposes RFC §07 targets so the suite is self-documenting', () => {
    expect(TARGETS.passRate).toBeGreaterThanOrEqual(0.7);
    expect(TARGETS.averageAttempts).toBeLessThanOrEqual(4);
  });

  it('curated prompt set covers the v1 contribution kinds', () => {
    const kinds = new Set<string>();
    for (const p of CURATED_PROMPTS) {
      for (const kind of p.expect.contributesKinds ?? []) kinds.add(kind);
    }
    // The prompts should exercise at least 5 distinct kinds — enough
    // to surface a regression in any one contribution slot's authoring
    // contract or widget DSL.
    expect(kinds.size).toBeGreaterThanOrEqual(5);
  });

  it('hits ≥70% pass rate with a perfect-recall stub LLM', async () => {
    // Stub: returns the canned bundle on the first turn. The repair
    // loop converges in 1 attempt for every prompt.
    const summary = await runAuthoringBenchmark({
      step: async (conversation: AuthoringMessage[]): Promise<AuthoringTurn> => {
        const userMsg = conversation.find((m) => m.role === 'user');
        const promptId = CURATED_PROMPTS.find((p) => userMsg?.content.includes(p.user))?.id;
        const prompt = CURATED_PROMPTS.find((p) => p.id === promptId);
        if (!prompt) {
          return { response: '(no matching prompt)' };
        }
        return { response: cannedBundleFor(prompt) };
      },
    });
    expect(summary.passRate).toBeGreaterThanOrEqual(TARGETS.passRate);
    expect(summary.averageAttempts).toBeLessThanOrEqual(TARGETS.averageAttempts);
    expect(summary.meetsTargets).toBe(true);
  });

  it('fails honestly when the LLM stub returns junk', async () => {
    const summary = await runAuthoringBenchmark({
      prompts: CURATED_PROMPTS.slice(0, 3),
      step: async () => ({ response: 'I cannot help with that.' }),
      attemptBudgetMs: 1000,
      totalBudgetMs: 5000,
    });
    expect(summary.passRate).toBe(0);
    expect(summary.meetsTargets).toBe(false);
    expect(summary.results.every((r) => !r.passed)).toBe(true);
  });

  it('records per-prompt attempt counts so a regression has detail', async () => {
    let callCount = 0;
    const summary = await runAuthoringBenchmark({
      prompts: CURATED_PROMPTS.slice(0, 1),
      step: async (conversation: AuthoringMessage[]): Promise<AuthoringTurn> => {
        callCount += 1;
        // Return junk on the first call; canned response on the
        // second. The repair loop should converge on attempt 2.
        if (callCount === 1) return { response: 'malformed bundle response' };
        return { response: cannedBundleFor(CURATED_PROMPTS[0]) };
      },
    });
    expect(summary.results[0].passed).toBe(true);
    expect(summary.results[0].attempts).toBe(2);
  });
});

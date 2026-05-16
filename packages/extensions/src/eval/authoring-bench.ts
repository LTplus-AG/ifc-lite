/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Authoring success-rate benchmark harness (P2 gate).
 *
 * The RFC §07 acceptance bar:
 *   - **≥ 70%** of labelled prompts produce a bundle that:
 *     1. Validates manifest + widgets + code + cross-references
 *     2. Installs without rollback
 *     3. Passes its declared tests
 *   - **≤ 4 repair iterations** average across the set
 *
 * This module ships the harness shape: a fixture set + a driver
 * function. Callers plug in an `AuthoringStep` (the LLM callback) and
 * a runtime; the harness reports per-prompt outcome + aggregate
 * stats.
 *
 * The fixture prompts are deliberately scoped to v1 contributions
 * (commands, toolbar, lenses, exporters) and avoid widgets to keep
 * the harness fast and offline-runnable in CI smoke tests.
 *
 * Spec: docs/architecture/ai-customization/04-ai-authoring.md §8.
 */

import { runRepairLoop, type AuthoringMessage, type AuthoringStep, type RepairResult } from '../authoring/repair.js';

export interface BenchmarkPrompt {
  /** Stable id for this prompt — used in result reporting. */
  id: string;
  /** The user-side instruction that seeds the authoring turn. */
  user: string;
  /** Optional system-side preamble (the authoring contract is added by the caller). */
  system?: string;
  /** Tags for slicing the report (e.g. ['toolbar', 'exporter']). */
  tags?: readonly string[];
  /** Acceptance criteria for the produced bundle. */
  expect: {
    /** Manifest id pattern the bundle should declare. */
    manifestId?: RegExp;
    /** Required capability strings. */
    capabilities?: readonly string[];
    /** Contribution kinds that must appear in the manifest. */
    contributesKinds?: readonly ('commands' | 'toolbar' | 'dock' | 'contextMenu' | 'keybindings' | 'lenses' | 'exporters' | 'idsValidators' | 'statusBar')[];
  };
}

export interface BenchmarkResult {
  promptId: string;
  /** True iff the repair loop converged AND the bundle met the prompt's expect criteria. */
  passed: boolean;
  /** Attempts the repair loop used. */
  attempts: number;
  /** Reason the run failed, when passed === false. */
  reason?: string;
  /** Wall-clock duration in ms. */
  durationMs: number;
}

export interface BenchmarkSummary {
  results: BenchmarkResult[];
  passed: number;
  failed: number;
  passRate: number;
  averageAttempts: number;
  totalDurationMs: number;
  /** True iff thresholds are met (≥70% pass, ≤4 mean attempts). */
  meetsTargets: boolean;
}

/**
 * Curated prompt set — small, scoped, prompts that the rule-based
 * classifier reliably routes to 'authoring' and that the v1 authoring
 * contract can answer. Expand cautiously: every prompt added here
 * runs through every benchmark invocation.
 */
export const CURATED_PROMPTS: readonly BenchmarkPrompt[] = [
  {
    id: 'one-click-wall-export',
    user: 'Make a one-click button that exports a CSV of every IfcWall with its Pset_WallCommon properties.',
    tags: ['toolbar', 'exporter'],
    expect: {
      manifestId: /^ext\./,
      capabilities: ['model.read'],
      contributesKinds: ['commands'],
    },
  },
  {
    id: 'fire-rating-lens',
    user: 'Add a lens that colours walls red when Pset_WallCommon.FireRating is missing.',
    tags: ['lens'],
    expect: {
      capabilities: ['model.read', 'viewer.colorize'],
      contributesKinds: ['lenses'],
    },
  },
  {
    id: 'door-count-status-bar',
    user: 'Add a status-bar widget that shows the current door count.',
    tags: ['statusBar'],
    expect: {
      capabilities: ['model.read'],
      contributesKinds: ['statusBar'],
    },
  },
  {
    id: 'isolate-storey-keybind',
    user: 'Bind Cmd+I to isolate the currently-selected storey.',
    tags: ['keybinding', 'command'],
    expect: {
      capabilities: ['model.read', 'viewer.isolate'],
      contributesKinds: ['commands', 'keybindings'],
    },
  },
  {
    id: 'context-menu-fly-to',
    user: 'Add a right-click menu item on entities to fly to the selection.',
    tags: ['contextMenu'],
    expect: {
      capabilities: ['viewer.fly'],
      contributesKinds: ['commands', 'contextMenu'],
    },
  },
  {
    id: 'json-export-quantities',
    user: 'One-click exporter that dumps every IfcSlab\'s GrossArea to JSON.',
    tags: ['exporter'],
    expect: {
      capabilities: ['model.read', 'export.create:json'],
      contributesKinds: ['commands'],
    },
  },
  {
    id: 'storey-toolbar-button',
    user: 'Add a toolbar button that lists storeys in the dock panel.',
    tags: ['toolbar', 'dock'],
    expect: {
      capabilities: ['model.read'],
      contributesKinds: ['commands', 'toolbar'],
    },
  },
  {
    id: 'reset-color-command',
    user: 'Create a command "Reset colors" that clears every colorize.',
    tags: ['command'],
    expect: {
      capabilities: ['viewer.colorize'],
      contributesKinds: ['commands'],
    },
  },
  {
    id: 'wall-area-quantity-export',
    user: 'Export NetSideArea for every IfcWall as a CSV.',
    tags: ['exporter'],
    expect: {
      capabilities: ['model.read', 'export.create:csv'],
      contributesKinds: ['commands'],
    },
  },
  {
    id: 'section-shortcut',
    user: 'Add Cmd+Shift+S to apply a horizontal section plane at the current camera target.',
    tags: ['keybinding'],
    expect: {
      capabilities: ['viewer.section'],
      contributesKinds: ['commands', 'keybindings'],
    },
  },
];

/** RFC §07 targets. */
export const TARGETS = {
  passRate: 0.7,
  averageAttempts: 4,
} as const;

export interface RunBenchmarkOptions {
  prompts?: readonly BenchmarkPrompt[];
  step: AuthoringStep;
  /** Override the per-attempt budget. Default 90 s. */
  attemptBudgetMs?: number;
  /** Override total budget per prompt. Default 6 min. */
  totalBudgetMs?: number;
  /** Optional clock for deterministic tests. */
  now?: () => number;
}

/**
 * Drive the benchmark. For each prompt:
 *   1. Run the repair loop with the prompt as the initial user turn.
 *   2. Inspect the produced bundle against the prompt's expect.
 *   3. Record pass/fail + attempts + duration.
 *
 * The harness does NOT call into Anthropic — the caller injects
 * `step` to either point at a real LLM, a fixture-replay, or a stub.
 * CI uses a stub that returns canned bundles; product owners run the
 * real-LLM variant before each release.
 */
export async function runAuthoringBenchmark(
  opts: RunBenchmarkOptions,
): Promise<BenchmarkSummary> {
  const prompts = opts.prompts ?? CURATED_PROMPTS;
  const results: BenchmarkResult[] = [];
  const overallStart = (opts.now ?? (() => Date.now()))();

  for (const prompt of prompts) {
    const startedAt = (opts.now ?? (() => Date.now()))();
    const initial: AuthoringMessage[] = [];
    if (prompt.system) initial.push({ role: 'system', content: prompt.system });
    initial.push({ role: 'user', content: prompt.user });

    let repair: RepairResult;
    try {
      repair = await runRepairLoop(initial, opts.step, {
        maxAttempts: 4,
        attemptBudgetMs: opts.attemptBudgetMs ?? 90_000,
        totalBudgetMs: opts.totalBudgetMs ?? 6 * 60_000,
        now: opts.now,
      });
    } catch (err) {
      results.push({
        promptId: prompt.id,
        passed: false,
        attempts: 0,
        reason: err instanceof Error ? err.message : String(err),
        durationMs: (opts.now ?? (() => Date.now()))() - startedAt,
      });
      continue;
    }

    const expectFail = checkExpect(repair, prompt);
    results.push({
      promptId: prompt.id,
      passed: repair.ok && !expectFail,
      attempts: repair.attempts,
      reason: !repair.ok
        ? `repair: ${repair.diagnostics[0]?.message ?? 'unknown'}`
        : expectFail,
      durationMs: (opts.now ?? (() => Date.now()))() - startedAt,
    });
  }

  const passed = results.filter((r) => r.passed).length;
  const failed = results.length - passed;
  const passRate = results.length === 0 ? 0 : passed / results.length;
  const averageAttempts = results.length === 0
    ? 0
    : results.reduce((n, r) => n + r.attempts, 0) / results.length;

  return {
    results,
    passed,
    failed,
    passRate,
    averageAttempts,
    totalDurationMs: (opts.now ?? (() => Date.now()))() - overallStart,
    meetsTargets:
      passRate >= TARGETS.passRate && averageAttempts <= TARGETS.averageAttempts,
  };
}

function checkExpect(
  repair: RepairResult,
  prompt: BenchmarkPrompt,
): string | undefined {
  if (!repair.ok || !repair.manifest) {
    return 'no manifest produced';
  }
  const m = repair.manifest;
  if (prompt.expect.manifestId && !prompt.expect.manifestId.test(m.id)) {
    return `manifest id ${m.id} did not match ${prompt.expect.manifestId}`;
  }
  if (prompt.expect.capabilities) {
    for (const cap of prompt.expect.capabilities) {
      if (!m.capabilities.includes(cap)) {
        return `missing capability ${cap}`;
      }
    }
  }
  if (prompt.expect.contributesKinds && m.contributes) {
    const kinds = m.contributes as Record<string, unknown>;
    for (const kind of prompt.expect.contributesKinds) {
      const list = kinds[kind];
      if (!Array.isArray(list) || list.length === 0) {
        return `no ${kind} contribution`;
      }
    }
  }
  return undefined;
}

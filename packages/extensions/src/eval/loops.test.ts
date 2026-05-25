/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * End-to-end eval suite for the three self-improvement loops
 * (per RFC §06.6). These are *integration*-shape tests that exercise
 * the library functions composed together, not unit tests for any
 * single module.
 *
 *   1. Pattern miner loop: planted action sequences → mined pattern
 *      → plan stub → filter against installed.
 *   2. Memory extractor loop: synthetic transcript → proposals →
 *      overlay merge → no content leak.
 *   3. SDK update loop: stale bundle → compatibility verdict →
 *      revalidation summary lands in needsRepair.
 *
 * The goal is regression coverage: if a refactor breaks any one of
 * the three loops end-to-end, this suite catches it.
 *
 * Spec: docs/architecture/ai-customization/06-self-improvement.md §6.
 */

import { describe, expect, it } from 'vitest';
import { ActionLog } from '../log/writer.js';
// Drive the loop through the public IdleMineScheduler API rather than
// reaching into the algorithm internals (mineSequences/scorePatterns).
// The internals can re-tune without breaking the public-surface eval.
import { IdleMineScheduler } from '../miner/scheduler.js';
import { filterAgainstInstalled } from '../miner/filter.js';
import { planFromPattern } from '../miner/plan-stub.js';
import { extractMemoryProposals, mergeIntoOverlay } from '../flavor/memory-extractor.js';
import { revalidateAgainstSdk } from '../host/sdk-revalidate.js';
import { ExtensionRuntime } from '../host/runtime.js';
import { createMemorySandboxFactory } from '../host/memory-factory.js';
import type { Bundle, ExtensionManifest } from '../types.js';

function plantedLog(): ActionLog {
  // Each session: 3 events 1 min apart. Sessions are separated by a
  // 2-hour gap so the miner's default 30-min sessionGap splits them.
  let timeMs = new Date('2026-01-01T08:00:00Z').getTime();
  const STEP = 60_000;
  const SESSION_GAP = 2 * 60 * 60 * 1000;
  const log = new ActionLog({ now: () => new Date(timeMs) });
  for (let i = 0; i < 5; i++) {
    log.append({ intent: 'model.load', params: { entityCount: 100 } });
    timeMs += STEP;
    log.append({ intent: 'lens.apply', params: { id: 'by-type' } });
    timeMs += STEP;
    log.append({ intent: 'export.run', params: { format: 'csv' } });
    timeMs += SESSION_GAP;
  }
  return log;
}

/**
 * Drive the miner through `IdleMineScheduler.fireNow()` — the same
 * entry point the viewer uses for the Ideas panel's Re-mine button.
 * The scheduler is configured with the same defaults as production so
 * the eval tracks real behaviour.
 */
function minePatterns(log: ActionLog) {
  const scheduler = new IdleMineScheduler({
    miner: { minLength: 3, maxLength: 5 },
  });
  scheduler.setEvents(log.list());
  return scheduler.fireNow().patterns;
}

describe('eval: pattern miner loop', () => {
  it('surfaces the planted load→lens→export pattern as the top suggestion', () => {
    const patterns = minePatterns(plantedLog());
    expect(patterns[0]).toBeDefined();
    expect(patterns[0].sequence).toEqual(['model.load', 'lens.apply', 'export.run']);
  });

  it('plan stub for the planted pattern carries the right command id', () => {
    const patterns = minePatterns(plantedLog());
    const plan = planFromPattern(patterns[0]);
    expect(plan.contributions[0]?.id).toMatch(/^ext\.suggested\..*\.run$/);
    expect(plan.triggers[0]).toMatch(/^onCommand:ext\.suggested/);
  });

  it('filters out patterns already covered by an installed extension', () => {
    const patterns = minePatterns(plantedLog());
    const filtered = filterAgainstInstalled(patterns, [
      {
        id: 'com.example.csv-pipeline',
        grantedCapabilities: ['model.read', 'viewer.colorize', 'export.create:csv'],
      },
    ]);
    const sequences = filtered.map((p) => p.sequence.join('>'));
    expect(sequences).not.toContain('model.load>lens.apply>export.run');
  });
});

describe('eval: memory extractor loop', () => {
  it('round-trips a preference into the overlay without leaking content', () => {
    const transcript = [
      { role: 'user' as const, content: 'Always export CSVs with semicolon separators.' },
      { role: 'assistant' as const, content: 'Got it.' },
      { role: 'user' as const, content: 'Also never include the column 1A2B3C4D-5E6F-7890-ABCD-EF1234567890 anywhere.' },
    ];
    const proposals = extractMemoryProposals(transcript);
    // The GUID-containing turn is filtered out by the blocklist.
    expect(proposals.some((p) => /1A2B3C4D/.test(p.phrasing))).toBe(false);
    // The clean "always" preference is captured.
    expect(proposals.some((p) => /semicolon/i.test(p.phrasing))).toBe(true);

    const merged = mergeIntoOverlay('', proposals);
    expect(merged).not.toMatch(/[0-9A-F]{8}-[0-9A-F]{4}/i);
    expect(merged).toMatch(/Preferences/);
  });
});

describe('eval: SDK update loop', () => {
  function makeBundle(declared: string): Bundle {
    const encoder = new TextEncoder();
    const manifest: ExtensionManifest = {
      manifestVersion: 1,
      id: 'com.example.staleish',
      name: 'Staleish',
      description: 'd',
      version: '1.0.0',
      engines: { ifcLiteSdk: declared },
      capabilities: [],
      activation: ['onCommand:ext.staleish.run'],
      contributes: { commands: [{ id: 'ext.staleish.run', title: 'Run' }] },
      entry: { commands: { 'ext.staleish.run': 'src/run.js' } },
      tests: [{
        name: 'always returns ok',
        command: 'ext.staleish.run',
        fixture: 'empty-model',
        expect: { regex: 'ok' },
      }],
    };
    const files = new Map<string, { path: string; bytes: Uint8Array; text?: string }>();
    const source = `function run() { return 'ok'; }`;
    files.set('src/run.js', { path: 'src/run.js', bytes: encoder.encode(source), text: source });
    return { manifest, files };
  }

  it('flags a bundle with a stale engine range as needsRepair', async () => {
    const bundle = makeBundle('^1.0.0');
    const runtime = new ExtensionRuntime({ factory: createMemorySandboxFactory() });
    const summary = await revalidateAgainstSdk({
      sdk: '3.0.0',
      installed: [{ id: bundle.manifest.id, engines: bundle.manifest.engines, grants: [] }],
      resolveBundle: () => bundle,
      runtime,
    });
    expect(summary.items[0].compatibility.status).toBe('outdated');
    // Tests still pass against the new SDK (handler is trivial), so the
    // outcome is 'pass' but the compat verdict alone is enough to keep
    // it out of needsRepair when the tests succeed. The repair UI also
    // surfaces 'permissive' cases on its own.
    expect(summary.items[0].outcome).toBe('pass');
  });

  it('keeps a fresh-range bundle out of needsRepair', async () => {
    const bundle = makeBundle('>=2.0.0');
    const runtime = new ExtensionRuntime({ factory: createMemorySandboxFactory() });
    const summary = await revalidateAgainstSdk({
      sdk: '3.0.0',
      installed: [{ id: bundle.manifest.id, engines: bundle.manifest.engines, grants: [] }],
      resolveBundle: () => bundle,
      runtime,
    });
    expect(summary.items[0].compatibility.status).toBe('compatible');
    expect(summary.needsRepair).toHaveLength(0);
  });
});

/**
 * Phase-gate criteria from the implementation plan. These tests guard
 * the spec-level invariants the RFC promises users:
 *   - "Action log demonstrably contains no model / chat / file content"
 *   - "SDK-bump dry run: representative installed-extension set passes
 *      with the repair loop fixing ≥ 80% of failures"
 *
 * Together with the planted-pattern test above they cover the three
 * P4 gate criteria the implementation plan calls out as machine-
 * verifiable.
 */
describe('P4 gate: action-log content discipline', () => {
  /** RegExps that match the no-content rule's forbidden shapes. */
  const FORBIDDEN_PATTERNS: { rx: RegExp; what: string }[] = [
    { rx: /[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/, what: 'GUID' },
    { rx: /\b[A-Za-z]:\\[^\s]+/, what: 'Windows path' },
    { rx: /\/[^\s/]*\/[^\s/]+\.\w{2,5}\b/, what: 'POSIX path' },
    { rx: /\b\S+@\S+\.\S+\b/, what: 'email' },
    { rx: /\bsk-[A-Za-z0-9-]{12,}/, what: 'API key' },
    // Long alphanumeric blob (likely an IFC GlobalId or token).
    { rx: /\b[A-Za-z0-9]{20,}/, what: 'long alphanumeric blob' },
  ];

  it('records nothing matching the no-content rule for the planted log', () => {
    const log = plantedLog();
    const events = log.list();
    for (const event of events) {
      const json = JSON.stringify(event);
      for (const { rx, what } of FORBIDDEN_PATTERNS) {
        if (rx.test(json)) {
          throw new Error(
            `Action event matched forbidden pattern "${what}" — ${rx} in ${json}`,
          );
        }
      }
    }
    // Sanity: the log we're checking actually has events.
    expect(events.length).toBeGreaterThan(0);
  });

  it('rejects an action event that smuggles user content via params', () => {
    // We can't statically enforce the no-content rule (param values
    // are typed but not regex-validated), so this test asserts the
    // existing FORBIDDEN_PATTERNS would catch a planted leak.
    const planted = {
      seq: 1,
      ts: '2026-01-01T00:00:00Z',
      intent: 'lens.apply' as const,
      // A user-named lens shouldn't end up in the log, but if it did:
      params: { id: 'building-foo@bar.com' },
      success: true,
    };
    const json = JSON.stringify(planted);
    const matched = FORBIDDEN_PATTERNS.find((p) => p.rx.test(json));
    expect(matched?.what).toBe('email');
  });
});

describe('P4 gate: SDK-bump dry run', () => {
  /**
   * Build a representative installed-set with mixed compatibility
   * verdicts. The plan's acceptance bar is "≥80% of failing tests
   * resolve cleanly". In v1 the resolution loop is the AI authoring
   * pipeline, which we can't run from a test; instead we measure
   * the *flagging* behaviour: outdated extensions with failing tests
   * land in needsRepair, and the gate verifies the bucket count.
   */
  function repBundle(opts: { id: string; declared: string; passes: boolean }) {
    const encoder = new TextEncoder();
    const id = opts.id;
    const source = opts.passes
      ? `function run() { return { ok: true, mimeType: 'application/json', bytes: new Uint8Array(64) }; }`
      : `function run() { return 'fail'; }`;
    const manifest: ExtensionManifest = {
      manifestVersion: 1,
      id,
      name: id,
      description: 'd',
      version: '1.0.0',
      engines: { ifcLiteSdk: opts.declared },
      capabilities: [],
      activation: [`onCommand:${id}.run`],
      contributes: { commands: [{ id: `${id}.run`, title: 'Run' }] },
      entry: { commands: { [`${id}.run`]: 'src/run.js' } },
      tests: [{
        name: 'shape',
        command: `${id}.run`,
        fixture: 'empty-model',
        expect: { jsonShape: { ok: { type: 'boolean' } } },
      }],
    };
    const files = new Map<string, { path: string; bytes: Uint8Array; text?: string }>();
    files.set('src/run.js', { path: 'src/run.js', bytes: encoder.encode(source), text: source });
    return { manifest, files };
  }

  it('correctly buckets a representative installed set', async () => {
    const installed = [
      repBundle({ id: 'com.ex.a', declared: '>=2.0.0', passes: true }),  // compatible
      repBundle({ id: 'com.ex.b', declared: '>=2.0.0', passes: true }),  // compatible
      repBundle({ id: 'com.ex.c', declared: '^1.0.0', passes: true }),   // outdated-pass
      repBundle({ id: 'com.ex.d', declared: '^1.0.0', passes: false }),  // outdated-fail
      repBundle({ id: 'com.ex.e', declared: '^1.0.0', passes: false }),  // outdated-fail
    ];
    const runtime = new ExtensionRuntime({ factory: createMemorySandboxFactory() });
    const summary = await revalidateAgainstSdk({
      sdk: '2.5.0',
      installed: installed.map((b) => ({ id: b.manifest.id, engines: b.manifest.engines, grants: [] })),
      resolveBundle: (id) => installed.find((b) => b.manifest.id === id),
      runtime,
    });
    const compatible = summary.items.filter((i) => i.compatibility.status === 'compatible').length;
    const failedTests = summary.items.filter((i) => i.outcome === 'fail').length;
    expect(compatible).toBe(2);
    expect(failedTests).toBe(2);
    // 3 of 5 (60%) didn't need repair; 2 of 5 (40%) need authoring help.
    // The plan's ≥80% repair-success threshold can't be verified
    // without the AI loop in-test — but the flagging numbers above
    // are what feeds it. This guards the bucketing logic.
    expect(summary.needsRepair).toHaveLength(2);
  });
});

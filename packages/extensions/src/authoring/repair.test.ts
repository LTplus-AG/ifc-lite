/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it, vi } from 'vitest';
import { runRepairLoop, validateBundleResponse } from './repair.js';

const VALID_MANIFEST = {
  manifestVersion: 1,
  id: 'com.example.demo',
  name: 'Demo',
  description: 'A demo.',
  version: '1.0.0',
  engines: { ifcLiteSdk: '>=2.0.0' },
  capabilities: ['model.read'],
  activation: ['onCommand:ext.example.demo.run'],
  contributes: { commands: [{ id: 'ext.example.demo.run', title: 'Demo' }] },
  entry: { commands: { 'ext.example.demo.run': 'src/commands/run.js' } },
};

const VALID_HANDLER = `async function run(ctx) { return ctx.bim.query.byType('IfcWall'); }`;

function validResponse(): string {
  return [
    '```ifc-extension-manifest',
    JSON.stringify(VALID_MANIFEST, null, 2),
    '```',
    '',
    '```ifc-extension-code path="src/commands/run.js"',
    VALID_HANDLER,
    '```',
  ].join('\n');
}

describe('validateBundleResponse', () => {
  it('accepts a clean response', () => {
    const r = validateBundleResponse(validResponse());
    expect(r.ok).toBe(true);
    expect(r.manifest?.id).toBe('com.example.demo');
  });

  it('flags missing handler path even if declared in manifest', () => {
    const noCode = validResponse().replace(/```ifc-extension-code[\s\S]+?```\s*/, '');
    const r = validateBundleResponse(noCode);
    expect(r.ok).toBe(false);
  });

  it('rejects banned globals in handler code', () => {
    const tainted = validResponse().replace(VALID_HANDLER, 'function run(ctx) { return globalThis.window; }');
    const r = validateBundleResponse(tainted);
    expect(r.ok).toBe(false);
  });

  it('flags invalid manifest fields', () => {
    const bad = validResponse().replace('"version": "1.0.0"', '"version": "not-semver"');
    const r = validateBundleResponse(bad);
    expect(r.ok).toBe(false);
  });
});

describe('runRepairLoop', () => {
  it('returns ok on first-shot valid output', async () => {
    const step = vi.fn().mockResolvedValue({ response: validResponse() });
    const r = await runRepairLoop([{ role: 'system', content: 'sys' }], step, {
      maxAttempts: 3,
      attemptBudgetMs: 5000,
      totalBudgetMs: 30_000,
    });
    expect(r.ok).toBe(true);
    expect(r.attempts).toBe(1);
  });

  it('retries on failure and converges', async () => {
    const broken = '```ifc-extension-manifest\n{ broken json\n```';
    const step = vi.fn()
      .mockResolvedValueOnce({ response: broken })
      .mockResolvedValueOnce({ response: validResponse() });
    const r = await runRepairLoop([{ role: 'system', content: 'sys' }], step, {
      maxAttempts: 3,
      attemptBudgetMs: 5000,
      totalBudgetMs: 30_000,
    });
    expect(r.ok).toBe(true);
    expect(r.attempts).toBe(2);
    // Conversation grew: initial + assistant + user-repair + assistant
    expect(step.mock.calls[1][0]).toHaveLength(3);
  });

  it('respects maxAttempts', async () => {
    const broken = '```ifc-extension-manifest\n{ broken json\n```';
    const step = vi.fn().mockResolvedValue({ response: broken });
    const r = await runRepairLoop([{ role: 'system', content: 'sys' }], step, {
      maxAttempts: 2,
      attemptBudgetMs: 5000,
      totalBudgetMs: 30_000,
    });
    expect(r.ok).toBe(false);
    expect(r.attempts).toBe(2);
    expect(r.budgetExhausted).toBe('attempts');
  });

  it('respects total wall-clock budget', async () => {
    let nowMs = 0;
    const step = vi.fn().mockImplementation(async () => {
      nowMs += 5000;
      return { response: '```ifc-extension-manifest\n{ broken\n```' };
    });
    const r = await runRepairLoop([{ role: 'system', content: 'sys' }], step, {
      maxAttempts: 10,
      attemptBudgetMs: 30_000,
      totalBudgetMs: 7000,
      now: () => nowMs,
    });
    expect(r.ok).toBe(false);
    expect(r.budgetExhausted).toBe('wallclock');
  });
});

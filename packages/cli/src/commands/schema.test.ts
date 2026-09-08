/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `ifc-lite schema` must not present its reduced built-in fallback as the
 * real API surface.
 *
 * The command exists so tools (and LLM agents) can discover the SDK. When
 * `@ifc-lite/sandbox/schema` can't be imported — package not built, a
 * version skew after a partial install — the command falls back to a small
 * hand-maintained subset and prints it on stdout as valid JSON. Nothing
 * distinguishes that from the full schema, so the consumer concludes the
 * missing namespaces do not exist. The fallback stays; the silence goes.
 */

import { describe, expect, it, vi, afterEach } from 'vitest';

// Stand in for a sandbox build whose schema export can't be read (stale or
// partial `dist/`). A throwing getter reproduces the failure at the same
// point the real one does — inside the command's `try` — while keeping the
// module shape the command touches (`.NAMESPACE_SCHEMAS`) intact.
vi.mock('@ifc-lite/sandbox/schema', () => ({
  get NAMESPACE_SCHEMAS(): unknown {
    throw new Error('sandbox schema export unavailable');
  },
}));

const { schemaCommand } = await import('./schema.js');

afterEach(() => {
  vi.restoreAllMocks();
});

function captureStdio(): { out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
    out.push(String(chunk));
    return true;
  });
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
    err.push(String(chunk));
    return true;
  });
  return { out, err };
}

describe('schemaCommand with the sandbox schema unavailable', () => {
  it('warns on stderr that the emitted schema is the reduced fallback', async () => {
    const { out, err } = captureStdio();

    await schemaCommand([]);

    // stdout stays pure JSON — the fallback is still emitted.
    const parsed = JSON.parse(out.join(''));
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed.length).toBeGreaterThan(0);

    const warning = err.join('');
    expect(warning, 'expected a stderr warning about the degraded schema').toContain('Warning');
    expect(warning).toContain('reduced');
    // The caught error must be named, not dropped.
    expect(warning).toContain('sandbox schema export unavailable');
  });

  it('sets a non-zero exit code, since stderr alone is a channel a `schema | jq` caller discards', async () => {
    const { out } = captureStdio();
    const previousExitCode = process.exitCode;
    try {
      process.exitCode = 0;

      await schemaCommand([]);

      // stdout is still pure, well-formed JSON of the same shape — the exit
      // code is the only thing that tells a piping caller the schema is
      // truncated, not the real one.
      expect(() => JSON.parse(out.join(''))).not.toThrow();
      expect(process.exitCode).toBe(1);
    } finally {
      // Restore: this is the test *runner's* own exit-status flag, not a
      // per-test sandbox — leaking `1` here would fail the whole vitest run.
      process.exitCode = previousExitCode;
    }
  });
});

/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The third state of `@ifc-lite/sandbox/schema`: present, but unusable.
 *
 * `schema.test.ts` covers the import *throwing* and `schema.success.test.ts`
 * covers it resolving correctly. Between them sits a partial or version-skewed
 * `dist/` that resolves the module with `NAMESPACE_SCHEMAS` absent or the wrong
 * shape. The import succeeds, so the `catch` never fires — and `schemas.map()`
 * runs outside the `try`, so the command died on an uncaught TypeError with no
 * fallback schema, no stderr warning and no exit code (maintainer finding on
 * #2100).
 *
 * That is strictly worse than the silence this command was fixed for: the
 * fallback, the warning and the non-zero exit are all bypassed at once.
 *
 * NOTE ON THE MOCK SHAPE, because the obvious one tests nothing. Mocking the
 * module as `{}` makes vitest throw on access to an undefined export, so the
 * `catch` fires for a reason that does not exist in Node ESM — where a missing
 * named export simply reads as `undefined`. The test would then pass against
 * the unfixed command. `{ NAMESPACE_SCHEMAS: undefined }` is what reproduces
 * the real failure.
 */

import { describe, expect, it, vi, afterEach } from 'vitest';

vi.mock('@ifc-lite/sandbox/schema', () => ({ NAMESPACE_SCHEMAS: undefined }));

const { schemaCommand } = await import('./schema.js');

afterEach(() => {
  vi.restoreAllMocks();
});

describe('schemaCommand when the schema export is present but unusable', () => {
  it('falls back, warns and exits non-zero instead of throwing', async () => {
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

    const previousExitCode = process.exitCode;
    try {
      process.exitCode = 0;

      // Must not throw — before the guard this rejected with
      // "Cannot read properties of undefined (reading 'map')".
      await expect(schemaCommand([])).resolves.toBeUndefined();

      // All three signals the fallback path owes the caller.
      expect(err.join('')).toContain('reduced');
      expect(process.exitCode).toBe(1);

      // stdout is still pure, well-formed JSON — the reduced schema.
      const parsed = JSON.parse(out.join(''));
      expect(Array.isArray(parsed)).toBe(true);
      expect(parsed.length).toBeGreaterThan(0);
    } finally {
      process.exitCode = previousExitCode;
    }
  });
});

/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `ifc-lite ask <file> "<question>" --json` must not exit 0 when the matched
 * recipe throws.
 *
 * `askCommand`'s recipe-execution catch (ask.ts) branches on `--json`: the
 * non-JSON path calls `fatal()`, which hard-exits 1; the JSON path prints
 * `{ error }` and falls through with no exit code set at all, so the process
 * exits 0 — a build pipeline reading only the exit code sees success on a
 * question that could not be answered. Same shape as the `ids --json`
 * always-exit-0 defect.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const createHeadlessContext = vi.hoisted(() => vi.fn());
vi.mock('../loader.js', () => ({ createHeadlessContext }));

const { askCommand, RECIPES } = await import('./ask.js');

function recipe(name: string) {
  const r = RECIPES.find((r) => r.name === name);
  if (!r) throw new Error(`recipe not found: ${name}`);
  return r;
}

describe('ask recipes — blank/whitespace name falls through to "(unnamed)"', () => {
  /**
   * Regression: a present-but-blank/whitespace `IfcBuilding.Name` was
   * chained with `buildings[0]?.name ?? '(unnamed)'`, which only falls
   * through on null/undefined, so the `answer:` string rendered
   * `Building: ` (or `Building:    `) instead of `Building: (unnamed)`.
   */
  it('building-name: blank Name falls through to "(unnamed)"', () => {
    const bim = { query: () => ({ byType: () => ({ toArray: () => [{ name: '' }] }) }) };
    const result = recipe('building-name').execute(bim, {});
    expect(result.answer).toBe('Building: (unnamed)');
    expect(result.name).toBe('(unnamed)');
  });

  it('building-name: whitespace-only Name falls through to "(unnamed)"', () => {
    const bim = { query: () => ({ byType: () => ({ toArray: () => [{ name: '   ' }] }) }) };
    const result = recipe('building-name').execute(bim, {});
    expect(result.answer).toBe('Building: (unnamed)');
  });

  it('building-name: a genuine name is returned unchanged (control)', () => {
    const bim = { query: () => ({ byType: () => ({ toArray: () => [{ name: 'Main Building' }] }) }) };
    const result = recipe('building-name').execute(bim, {});
    expect(result.answer).toBe('Building: Main Building');
  });

  it('tallest-storey: blank storey Name falls through to "(unnamed)"', () => {
    const bim = { storeys: () => [{ ref: 1, name: '' }], contains: () => [{}, {}] };
    const result = recipe('tallest-storey').execute(bim, {});
    expect(result.answer).toBe('Largest storey: (unnamed) with 2 elements');
    expect(result.storey).toBe('(unnamed)');
  });

  it('tallest-storey: a genuine storey Name is returned unchanged (control)', () => {
    const bim = { storeys: () => [{ ref: 1, name: 'Level 1' }], contains: () => [{}] };
    const result = recipe('tallest-storey').execute(bim, {});
    expect(result.storey).toBe('Level 1');
  });

  it('largest-element: blank element Name falls through to "(unnamed)" in the answer', () => {
    const bim = { query: () => ({ byType: () => ({ toArray: () => [{ ref: 1, name: '', globalId: 'G1' }] }) }), quantities: () => [{ name: 'Qto_WallBaseQuantities', quantities: [{ name: 'GrossSideArea', value: 5 }] }] };
    const result = recipe('largest-element').execute(bim, {}, ['largest wall', 'wall'] as unknown as RegExpMatchArray);
    expect(result.answer).toContain('"(unnamed)"');
    expect(result.answer).not.toContain('""');
  });

  it('smallest-element: blank element Name falls through to "(unnamed)" in the answer', () => {
    const bim = { query: () => ({ byType: () => ({ toArray: () => [{ ref: 1, name: '', globalId: 'G1' }] }) }), quantities: () => [{ name: 'Qto_WallBaseQuantities', quantities: [{ name: 'GrossSideArea', value: 5 }] }] };
    const result = recipe('smallest-element').execute(bim, {}, ['smallest wall', 'wall'] as unknown as RegExpMatchArray);
    expect(result.answer).toContain('"(unnamed)"');
    expect(result.answer).not.toContain('""');
  });
});

describe('askCommand when the matched recipe throws', () => {
  let stdout: string;
  let stderr: string;
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let previousExitCode: number | string | null | undefined;

  beforeEach(() => {
    stdout = '';
    stderr = '';
    previousExitCode = process.exitCode;
    process.exitCode = 0;
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
      stdout += String(chunk);
      return true;
    });
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
      stderr += String(chunk);
      return true;
    });
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((): never => {
      throw new Error('process.exit called');
    });
    // A recipe throwing mid-execution (e.g. a backend/geometry failure) is
    // exactly what the shared try/catch in askCommand is there for; a `bim`
    // whose `query()` throws reaches it the same way a real failure would.
    createHeadlessContext.mockResolvedValue({
      bim: {
        query: () => {
          throw new Error('backend query failed');
        },
      },
      store: { schemaVersion: 'IFC4' },
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.exitCode = previousExitCode;
  });

  it('the human path hard-exits non-zero', async () => {
    await expect(askCommand(['model.ifc', 'how many walls'])).rejects.toThrow('process.exit called');
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('the --json path must also report failure via the exit code', async () => {
    await askCommand(['model.ifc', 'how many walls', '--json']);

    const parsed = JSON.parse(stdout);
    expect(parsed.error).toBeTruthy();
    // This is the assertion the current code fails: nothing sets
    // process.exitCode (and process.exit is never called) on the --json path.
    expect(process.exitCode).not.toBe(0);
  });
});

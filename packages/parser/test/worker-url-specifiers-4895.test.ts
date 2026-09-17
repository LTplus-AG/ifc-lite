/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Issue #4895 — the published `dist/worker-parser.js` asked for
 * `./parser.worker.ts`, a file the tarball does not contain, so
 * `new WorkerParser()` rejected for every npm consumer and `vite build` failed
 * outright while resolving the literal.
 *
 * The build now rewrites those specifiers and then verifies the result. Both
 * halves are exercised here against synthetic file contents and a synthetic
 * "does this file exist" answer — never against this checkout's own `dist`,
 * which a future build change could make vacuously green.
 *
 * The verifier is tested INDEPENDENTLY of the rewrite on purpose. #633 already
 * rewrote geometry's worker URLs and #637 still had to ship, because the
 * rewrite named the files to touch, missed one, and nothing checked the
 * output. A rewrite that quietly does nothing has to fail the build.
 */

import { describe, expect, it } from 'vitest';

import { rewriteWorkerUrls } from '../scripts/rewrite-worker-urls.mjs';
import { findUnshippedTargets } from '../scripts/verify-dist-worker-urls.mjs';

/** The line tsc emits into `dist/worker-parser.js` from `src/worker-parser.ts`. */
const EMITTED_LINE =
  "    : new Worker(new URL('./parser.worker.ts', import.meta.url), { type: 'module' });";

const emitted = (name: string) => name === './parser.worker.js';

describe('#4895 — the build rewrites worker specifiers to the file tsc emitted', () => {
  it('turns the .ts specifier into the .js sibling that dist actually holds', () => {
    const { text, rewritten, left } = rewriteWorkerUrls(EMITTED_LINE, emitted);

    expect(text).toContain("new URL('./parser.worker.js', import.meta.url)");
    expect(text).not.toContain('parser.worker.ts');
    expect(rewritten).toEqual(['./parser.worker.ts -> ./parser.worker.js']);
    expect(left).toEqual([]);
  });

  it('keeps the double-quoted form quoted the same way', () => {
    const { text } = rewriteWorkerUrls(
      'new Worker(new URL("./parser.worker.ts", import.meta.url))',
      emitted,
    );

    expect(text).toBe('new Worker(new URL("./parser.worker.js", import.meta.url))');
  });

  it('rewrites every specifier in the file, not the first one', () => {
    const { rewritten } = rewriteWorkerUrls(
      `${EMITTED_LINE}\nconst fallback = new URL('./parser.worker.ts', import.meta.url);`,
      emitted,
    );

    expect(rewritten).toHaveLength(2);
  });

  it('leaves a specifier alone when no sibling was emitted, and reports it', () => {
    const { text, rewritten, left } = rewriteWorkerUrls(
      "new Worker(new URL('./ghost.worker.ts', import.meta.url))",
      emitted,
    );

    // Rewriting this would swap one missing file for another and hide the
    // real problem from the verifier, which fails on it next.
    expect(text).toContain('./ghost.worker.ts');
    expect(rewritten).toEqual([]);
    expect(left).toEqual(['./ghost.worker.ts']);
  });

  it('does not touch a URL that is not resolved against import.meta.url', () => {
    const source = "fetch(new URL('./parser.worker.ts', base));";

    expect(rewriteWorkerUrls(source, emitted).text).toBe(source);
  });
});

describe('#4895 — the verifier fails on a specifier the package does not ship', () => {
  const ships = (specifier: string) => specifier === './parser.worker.js';

  it('reports the unrewritten .ts specifier that shipped in 6.5.0 and 7.0.0', () => {
    const { checked, missing } = findUnshippedTargets(EMITTED_LINE, ships);

    expect(checked).toEqual(['./parser.worker.ts']);
    expect(missing).toEqual(['./parser.worker.ts']);
  });

  it('passes once the specifier points at the emitted worker', () => {
    const { missing } = findUnshippedTargets(
      "new Worker(new URL('./parser.worker.js', import.meta.url))",
      ships,
    );

    expect(missing).toEqual([]);
  });

  it('catches a missing .js target too, which the rewrite would never look at', () => {
    // #637's failure mode: the rewrite ran, reported success, and left a dist
    // file pointing at something absent. The verifier re-derives the answer
    // from the emitted files instead of trusting the rewrite, so it still
    // fails here.
    const { missing } = findUnshippedTargets(
      "new Worker(new URL('./dropped-by-the-build.js', import.meta.url))",
      ships,
    );

    expect(missing).toEqual(['./dropped-by-the-build.js']);
  });

  it('counts what it inspected, so a scan that found nothing is distinguishable', () => {
    const { checked, missing } = findUnshippedTargets('export const x = 1;', ships);

    expect(checked).toEqual([]);
    expect(missing).toEqual([]);
  });
});

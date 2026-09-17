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
 * filesystem — never against this checkout's own `dist`, which a future build
 * change could make vacuously green.
 *
 * The verifier is tested INDEPENDENTLY of the rewrite on purpose. #633 already
 * rewrote geometry's worker URLs and #637 still had to ship, because the
 * rewrite named the files to touch, missed one, and nothing checked the
 * output. A rewrite that quietly does nothing has to fail the build.
 *
 * The `classifyTarget` block exists because review of #4900 found the first
 * spelling of this change had no test for the one thing that touched a
 * filesystem: both halves took an injected "does this exist" predicate, and
 * every test stubbed it. The stub was correct and the real predicate
 * (`existsSync`) was not, so nothing here could fail. Those cases are now
 * driven through the real classifier with a synthetic `inspect`.
 *
 * The build-pipeline block is the same gap one level up, also from that
 * review: every assertion here calls the two functions directly, so dropping
 * either step from the `build` script leaves this file green while the
 * published `dist` goes back to naming a file the tarball does not carry.
 * It reads `package.json` as configuration data, not as source text.
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

type TargetKind = 'file' | 'directory' | 'missing';
type TargetVerdict = 'shipped' | 'outside-dist' | 'not-a-file' | 'missing';

type RewriteWorkerUrls = (
  text: string,
  emitsSibling: (jsSpecifier: string) => boolean,
) => { text: string; rewritten: string[]; left: string[] };

type FindUnshippedTargets = (
  text: string,
  classify: (specifier: string) => TargetVerdict,
) => { checked: string[]; problems: { specifier: string; verdict: TargetVerdict }[] };

type ClassifyTarget = (args: {
  distRoot: string;
  fileDir: string;
  specifier: string;
  inspect: (absolutePath: string) => TargetKind;
}) => TargetVerdict;

/**
 * The three build scripts are loaded, not imported.
 *
 * `scripts/check-test-revert-oracle.mjs` reverts the production hunk and
 * requires the changed tests to go red BY ASSERTION. A static import of a file
 * the revert deleted kills this module at load instead, no assertion runs, and
 * the oracle reports INCONCLUSIVE / REVERT-BROKE-BUILD — which is what it did
 * on the first push of this branch. Loading them this way turns the same
 * situation into an ordinary failed expectation naming the missing file.
 */
async function lade(pfad: string): Promise<Record<string, unknown> | null> {
  try {
    return (await import(/* @vite-ignore */ pfad)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

const [modulLib, modulRewrite, modulVerify] = await Promise.all([
  lade('../scripts/lib/shipped-target.mjs'),
  lade('../scripts/rewrite-worker-urls.mjs'),
  lade('../scripts/verify-dist-worker-urls.mjs'),
]);

function hole<T>(modul: Record<string, unknown> | null, name: string, datei: string): T {
  if (!modul) {
    expect.fail(`${datei} is absent, so the build step this file covers is gone`);
  }
  if (typeof modul[name] !== 'function') {
    expect.fail(`${datei} no longer exports ${name}`);
  }
  return modul[name] as T;
}

const classifyTarget: ClassifyTarget = (args) =>
  hole<ClassifyTarget>(modulLib, 'classifyTarget', 'scripts/lib/shipped-target.mjs')(args);

const rewriteWorkerUrls: RewriteWorkerUrls = (text, emitsSibling) =>
  hole<RewriteWorkerUrls>(
    modulRewrite, 'rewriteWorkerUrls', 'scripts/rewrite-worker-urls.mjs',
  )(text, emitsSibling);

const findUnshippedTargets: FindUnshippedTargets = (text, classify) =>
  hole<FindUnshippedTargets>(
    modulVerify, 'findUnshippedTargets', 'scripts/verify-dist-worker-urls.mjs',
  )(text, classify);

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

  it('matches a ../ specifier too, which the first pattern skipped entirely', () => {
    const { rewritten } = rewriteWorkerUrls(
      "new Worker(new URL('../parser.worker.ts', import.meta.url))",
      (name) => name === '../parser.worker.js',
    );

    expect(rewritten).toEqual(['../parser.worker.ts -> ../parser.worker.js']);
  });

  it('leaves a specifier alone when no sibling is shipped, and reports it', () => {
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
  const ships = (specifier: string) =>
    specifier === './parser.worker.js' ? ('shipped' as const) : ('missing' as const);

  it('reports the unrewritten .ts specifier that shipped in 6.5.0 and 7.0.0', () => {
    const { checked, problems } = findUnshippedTargets(EMITTED_LINE, ships);

    expect(checked).toEqual(['./parser.worker.ts']);
    expect(problems).toEqual([{ specifier: './parser.worker.ts', verdict: 'missing' }]);
  });

  it('passes once the specifier points at the emitted worker', () => {
    const { problems } = findUnshippedTargets(
      "new Worker(new URL('./parser.worker.js', import.meta.url))",
      ships,
    );

    expect(problems).toEqual([]);
  });

  it('catches a missing .js target too, which the rewrite would never look at', () => {
    // #637's failure mode: the rewrite ran, reported success, and left a dist
    // file pointing at something absent. The verifier re-derives the answer
    // from the emitted files instead of trusting the rewrite.
    const { problems } = findUnshippedTargets(
      "new Worker(new URL('./dropped-by-the-build.js', import.meta.url))",
      ships,
    );

    expect(problems).toEqual([
      { specifier: './dropped-by-the-build.js', verdict: 'missing' },
    ]);
  });

  it('inspects ../ specifiers, which the first pattern did not match', () => {
    const { checked } = findUnshippedTargets(
      "new Worker(new URL('../src/parser.worker.ts', import.meta.url))",
      ships,
    );

    expect(checked).toEqual(['../src/parser.worker.ts']);
  });

  it('counts what it inspected, so a scan that found nothing is distinguishable', () => {
    const { checked, problems } = findUnshippedTargets('export const x = 1;', ships);

    expect(checked).toEqual([]);
    expect(problems).toEqual([]);
  });
});

describe('#4895 — what counts as shipped (review of #4900)', () => {
  const DIST = '/repo/packages/parser/dist';

  /** A synthetic dist: one emitted worker, one subdirectory, one source file outside. */
  const inspect = (path: string) => {
    if (path === `${DIST}/parser.worker.js`) return 'file' as const;
    if (path === `${DIST}/subdir`) return 'directory' as const;
    if (path === '/repo/packages/parser/src/parser.worker.ts') return 'file' as const;
    return 'missing' as const;
  };

  const verdictFor = (specifier: string, fileDir = DIST) =>
    classifyTarget({ distRoot: DIST, fileDir, specifier, inspect });

  it('accepts a regular file inside dist', () => {
    expect(verdictFor('./parser.worker.js')).toBe('shipped');
  });

  it('rejects a target that climbs out of dist, even though the file exists', () => {
    // `files` is ["dist", "README.md"], so the real source file this resolves
    // to exists for a developer and is absent from the tarball. `existsSync`
    // answered yes here, which is the defect review found.
    expect(verdictFor('./../src/parser.worker.ts')).toBe('outside-dist');
    expect(verdictFor('../src/parser.worker.ts')).toBe('outside-dist');
  });

  it('rejects dist itself', () => {
    expect(verdictFor('./..', `${DIST}/subdir`)).toBe('outside-dist');
  });

  it('rejects a directory, which is not a loadable worker', () => {
    expect(verdictFor('./subdir')).toBe('not-a-file');
  });

  it('reports a target that is simply absent', () => {
    expect(verdictFor('./never-emitted.js')).toBe('missing');
  });

  it('resolves relative to the file holding the specifier, not to dist', () => {
    expect(verdictFor('../parser.worker.js', `${DIST}/subdir`)).toBe('shipped');
  });
});

describe('#4895 — the build schedules both steps (review of #4900)', () => {
  const manifest = JSON.parse(
    readFileSync(
      resolve(dirname(fileURLToPath(import.meta.url)), '..', 'package.json'),
      'utf8',
    ),
  ) as { scripts?: Record<string, string> };

  const steps = String(manifest.scripts?.build ?? '')
    .split('&&')
    .map((step) => step.trim());

  const indexOfStep = (script: string) =>
    // @source-text-assertion-ok the read file is package.json, configuration rather than a source file, and the build pipeline IS the subject: nothing else can show that the two steps are still scheduled
    steps.findIndex((step) => step.includes(`scripts/${script}`));

  it('emits before it rewrites', () => {
    // @source-text-assertion-ok same subject as above: the assertion is on the build pipeline read from package.json, not on any source file's text
    expect(steps[0]).toContain('tsc');
  });

  it('runs the rewrite, or dist keeps the .ts specifier tsc copied in', () => {
    expect(indexOfStep('rewrite-worker-urls.mjs')).toBeGreaterThan(0);
  });

  it('runs the verifier, or a rewrite that did nothing still ships', () => {
    expect(indexOfStep('verify-dist-worker-urls.mjs')).toBeGreaterThan(0);
  });

  it('verifies after rewriting, since the other order can only fail', () => {
    expect(indexOfStep('verify-dist-worker-urls.mjs')).toBeGreaterThan(
      indexOfStep('rewrite-worker-urls.mjs'),
    );
  });
});

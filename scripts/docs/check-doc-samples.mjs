#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Guard: every ```typescript / ```ts snippet in the docs typechecks
 * against the real workspace API. Docs used to drift silently — a
 * renamed export or changed signature would only surface when a reader
 * copy-pasted a broken snippet.
 *
 * How it works:
 *   1. Extract every fenced ts/typescript block from a fixed list of
 *      docs (README + guides + tutorials).
 *   2. Write each block to a temp dir as its own module.
 *   3. Typecheck them all with the workspace TypeScript, resolving
 *      `@ifc-lite/*` to each package's `src/` via tsconfig `paths` so no
 *      build is required.
 *
 * The snippets do not have to be runnable — free variables like `store`
 * or `canvas` come from a shared ambient globals.d.ts with REAL types —
 * but every API name and signature they use is checked for real.
 *
 * Opt-out (use sparingly, prefer fixing the snippet):
 *   - a fence with an info string attribute, e.g. ```ts title="app.ts"
 *   - an HTML comment `<!-- docs-check: skip -->` on the line directly
 *     above the opening fence
 *
 * Run via `pnpm docs:check-samples`.
 */

import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
  existsSync,
  rmSync,
} from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const GLOBALS_SRC = join(HERE, 'doc-samples-globals.d.ts');
const EXTERNALS_SRC = join(HERE, 'doc-samples-externals.d.ts');

/** Docs whose ts/typescript snippets are typechecked. */
function targetDocs() {
  const files = ['README.md'];
  for (const dir of ['guide', 'tutorials']) {
    const abs = join(ROOT, 'docs', dir);
    for (const f of readdirSync(abs).sort()) {
      if (f.endsWith('.md')) files.push(join('docs', dir, f));
    }
  }
  return files;
}

/**
 * Extract fenced ts/typescript blocks from one file. Returns
 * { code, startLine (1-based doc line of the first code line), skipped }.
 */
function extractBlocks(relPath) {
  const abs = join(ROOT, relPath);
  const lines = readFileSync(abs, 'utf-8').split('\n');
  const blocks = [];
  let fenceIndex = 0;
  let i = 0;
  while (i < lines.length) {
    const open = lines[i].match(/^```(\s*)(ts|typescript)(\s+(.*))?$/);
    if (!open) {
      i += 1;
      continue;
    }
    const infoTail = (open[4] ?? '').trim();
    const prev = i > 0 ? lines[i - 1].trim() : '';
    const skipped =
      infoTail.length > 0 || prev === '<!-- docs-check: skip -->';
    const startLine = i + 2; // 1-based line of the first code line
    const body = [];
    let j = i + 1;
    while (j < lines.length && !/^```\s*$/.test(lines[j])) {
      body.push(lines[j]);
      j += 1;
    }
    blocks.push({
      file: relPath,
      fenceIndex,
      startLine,
      code: body.join('\n'),
      skipped,
    });
    fenceIndex += 1;
    i = j + 1;
  }
  return blocks;
}

/** Build the tsconfig `paths` map for @ifc-lite packages to their src. */
function buildPaths() {
  const paths = {};
  const packagesDir = join(ROOT, 'packages');
  for (const dir of readdirSync(packagesDir).sort()) {
    const pkgJson = join(packagesDir, dir, 'package.json');
    if (!existsSync(pkgJson)) continue;
    const pkg = JSON.parse(readFileSync(pkgJson, 'utf-8'));
    if (pkg.private === true || !pkg.name) continue;
    // @ifc-lite/wasm ships a committed .d.ts (no src/index.ts).
    if (pkg.name === '@ifc-lite/wasm') {
      paths['@ifc-lite/wasm'] = ['packages/wasm/pkg/ifc-lite.d.ts'];
      paths['@ifc-lite/wasm/*'] = ['packages/wasm/pkg/*'];
      continue;
    }
    const entry = join(packagesDir, dir, 'src', 'index.ts');
    if (!existsSync(entry)) continue;
    paths[pkg.name] = [`packages/${dir}/src/index.ts`];
    // Subpath exports whose source file differs from the subpath name
    // (e.g. "@ifc-lite/clash/bcf" -> src/bcf-bridge.ts) need explicit
    // entries derived from the package's `exports` map; the trailing
    // wildcard below only covers same-named src files.
    const exportsMap =
      pkg.exports &&
      typeof pkg.exports === 'object' &&
      Object.keys(pkg.exports).every((k) => k.startsWith('.'))
        ? pkg.exports
        : {};
    for (const [key, target] of Object.entries(exportsMap)) {
      if (key === '.' || key.includes('*')) continue;
      let t = target;
      while (t && typeof t === 'object') {
        t = t.types ?? t.import ?? t.default;
      }
      if (typeof t !== 'string') continue;
      const rel = t
        .replace(/^\.\//, '')
        .replace(/^dist\//, 'src/')
        .replace(/\.d\.ts$/, '.ts')
        .replace(/\.js$/, '.ts');
      if (!existsSync(join(packagesDir, dir, rel))) continue;
      paths[`${pkg.name}/${key.slice(2)}`] = [`packages/${dir}/${rel}`];
    }
    paths[`${pkg.name}/*`] = [`packages/${dir}/src/*`];
  }
  return paths;
}

const argv = process.argv.slice(2);
const KEEP = argv.includes('--keep');

const allBlocks = targetDocs().flatMap(extractBlocks);
const checked = allBlocks.filter((b) => !b.skipped);
const skippedCount = allBlocks.length - checked.length;

if (checked.length === 0) {
  console.error('❌ No ts/typescript snippets found to check.');
  process.exit(1);
}

const tmp = mkdtempSync(join(tmpdir(), 'ifc-doc-samples-'));
try {
  // Shared ambient declarations are copied into the program root.
  // - globals: real-typed conventional free vars (a module: has `export {}`)
  // - externals: `declare module` stubs for third-party imports (a script:
  //   ambient module declarations only register from a non-module file)
  writeFileSync(join(tmp, 'doc-samples-globals.d.ts'), readFileSync(GLOBALS_SRC, 'utf-8'));
  writeFileSync(join(tmp, 'doc-samples-externals.d.ts'), readFileSync(EXTERNALS_SRC, 'utf-8'));

  const byTmpName = new Map();
  const fileNames = ['doc-samples-globals.d.ts', 'doc-samples-externals.d.ts'];
  checked.forEach((block, idx) => {
    const name = `snippet-${String(idx).padStart(3, '0')}.ts`;
    // Append `export {}` so every snippet is a module: isolated scope (no
    // cross-snippet redeclare collisions) and top-level await allowed.
    writeFileSync(join(tmp, name), `${block.code}\nexport {};\n`);
    byTmpName.set(name, block);
    fileNames.push(name);
  });

  const tsconfig = {
    compilerOptions: {
      target: 'ES2022',
      module: 'ESNext',
      moduleResolution: 'bundler',
      lib: ['ES2022', 'DOM', 'DOM.Iterable', 'ESNext.Disposable'],
      strict: false,
      noImplicitAny: false,
      noUnusedLocals: false,
      noUnusedParameters: false,
      skipLibCheck: true,
      resolveJsonModule: true,
      esModuleInterop: true,
      allowSyntheticDefaultImports: true,
      forceConsistentCasingInFileNames: true,
      noEmit: true,
      ignoreDeprecations: '6.0',
      baseUrl: ROOT,
      paths: buildPaths(),
      types: [],
    },
    files: fileNames.map((n) => join(tmp, n)),
  };
  writeFileSync(join(tmp, 'tsconfig.json'), `${JSON.stringify(tsconfig, null, 2)}\n`);

  const tsc = join(ROOT, 'node_modules', '.bin', 'tsc');
  const res = spawnSync(tsc, ['--noEmit', '-p', join(tmp, 'tsconfig.json'), '--pretty', 'false'], {
    cwd: ROOT,
    encoding: 'utf-8',
    maxBuffer: 64 * 1024 * 1024,
  });

  const out = `${res.stdout ?? ''}${res.stderr ?? ''}`;
  // Only diagnostics in the snippet files are in scope: a doc snippet's use
  // of the API. Errors inside the imported package SOURCE (e.g. a missing
  // WebGPU ambient in @ifc-lite/renderer, a `?url` import) are that package's
  // concern — it has its own `turbo typecheck` lane — so they are ignored
  // here. Diagnostics in our own support files or the generated tsconfig do
  // fail: they mean this harness is misconfigured.
  const snippetRe = /(?:^|[/\\])(snippet-\d{3})\.ts\((\d+),(\d+)\):\s*(error\s+TS\d+:\s*.*)$/;
  const supportRe = /(?:^|[/\\])(doc-samples-globals\.d\.ts|doc-samples-externals\.d\.ts|tsconfig\.json)(?:\((\d+),(\d+)\))?:\s*(error\s+TS\d+:\s*.*)$/;
  const failures = [];
  const supportFailures = [];
  for (const line of out.split('\n')) {
    const m = line.match(snippetRe);
    if (m) {
      const block = byTmpName.get(`${m[1]}.ts`);
      if (!block) continue;
      const docLine = block.startLine + (Number(m[2]) - 1);
      failures.push({
        file: block.file,
        fenceIndex: block.fenceIndex,
        docLine,
        message: m[4],
      });
      continue;
    }
    const s = line.match(supportRe);
    if (s) supportFailures.push(`${s[1]}: ${s[4]}`);
  }

  if (supportFailures.length > 0) {
    console.error('❌ The doc-samples typecheck harness is misconfigured:\n');
    for (const f of supportFailures) console.error(`   ${f}`);
    console.error('\nFix scripts/docs/doc-samples-globals.d.ts or doc-samples-externals.d.ts.');
    process.exit(1);
  }

  if (failures.length > 0) {
    console.error(
      `\n❌ Doc code samples failed to typecheck (${failures.length} error${failures.length === 1 ? '' : 's'}):\n`,
    );
    for (const f of failures) {
      console.error(`   ${f.file}:${f.docLine} (fence #${f.fenceIndex})`);
      console.error(`      ${f.message}\n`);
    }
    console.error(
      `Fix the snippet against the real API (verify against the package source),\n` +
        `or, only for deliberately illustrative pseudo-code, opt it out with a\n` +
        `\`<!-- docs-check: skip -->\` comment on the line above the fence.\n`,
    );
    process.exit(1);
  }

  console.log(
    `✅ Doc code samples typecheck clean (${checked.length} snippet${checked.length === 1 ? '' : 's'} across ${targetDocs().length} docs, ${skippedCount} skipped).`,
  );
} finally {
  if (!KEEP) rmSync(tmp, { recursive: true, force: true });
  else console.error(`(kept temp dir: ${tmp})`);
}

#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Write the per-rule IDS lint pages (docs/guide/ids-lint/*) and the
 * matching mkdocs nav block from the rule metadata (IDS-053).
 *
 *   pnpm --filter @ifc-lite/ids-authoring build
 *   node packages/ids-authoring/scripts/generate-lint-docs.mjs [--check]
 *
 * --check exits 1 when a page or the nav block is stale. The package test
 * `src/lint/docs.test.ts` performs the same check in CI.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const dist = new URL('../dist/lint/', import.meta.url);
const { LINT_RULES } = await import(new URL('rules/index.js', dist).href);
const { LINT_DOCS_DIR, NAV_BEGIN, NAV_END, renderLintDocs, renderLintNav } = await import(new URL('docs.js', dist).href);

const check = process.argv.includes('--check');
const dir = join(root, LINT_DOCS_DIR);
const pages = renderLintDocs(LINT_RULES);
const stale = [];

if (!check) mkdirSync(dir, { recursive: true });
for (const [name, content] of pages) {
  const path = join(dir, name);
  const current = existsSync(path) ? readFileSync(path, 'utf8') : undefined;
  if (current === content) continue;
  stale.push(`${LINT_DOCS_DIR}/${name}`);
  if (!check) writeFileSync(path, content);
}
for (const name of existsSync(dir) ? readdirSync(dir) : []) {
  if (pages.has(name)) continue;
  stale.push(`${LINT_DOCS_DIR}/${name} (orphan)`);
  if (!check) rmSync(join(dir, name));
}

const mkdocsPath = join(root, 'mkdocs.yml');
const mkdocs = readFileSync(mkdocsPath, 'utf8');
const begin = mkdocs.indexOf(NAV_BEGIN);
const end = mkdocs.indexOf(NAV_END);
if (begin < 0 || end < 0) {
  console.error(`mkdocs.yml has no "${NAV_BEGIN}" … "${NAV_END}" block`);
  process.exit(1);
}
const lineStart = mkdocs.lastIndexOf('\n', begin) + 1;
const indent = mkdocs.slice(lineStart, begin);
const lineEnd = mkdocs.indexOf('\n', end);
const next = mkdocs.slice(0, lineStart) + renderLintNav(LINT_RULES, indent) + mkdocs.slice(lineEnd);
if (next !== mkdocs) {
  stale.push('mkdocs.yml (ids-lint nav)');
  if (!check) writeFileSync(mkdocsPath, next);
}

if (check && stale.length) {
  console.error(`IDS lint docs are stale; run node packages/ids-authoring/scripts/generate-lint-docs.mjs:\n  ${stale.join('\n  ')}`);
  process.exit(1);
}
console.log(check ? `IDS lint docs up to date (${pages.size} pages)` : `IDS lint docs: ${stale.length ? stale.join(', ') : 'nothing to update'}`);

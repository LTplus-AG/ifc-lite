/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** The committed docs/guide/ids-lint pages and mkdocs nav match the catalogue (IDS-053). */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { LINT_DOCS_DIR, NAV_BEGIN, NAV_END, renderLintDocs, renderLintNav } from './docs.js';
import { LINT_RULES } from './rules/index.js';

const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const FIX = 'run `pnpm --filter @ifc-lite/ids-authoring build && node packages/ids-authoring/scripts/generate-lint-docs.mjs`';

describe('generated lint docs', () => {
  const pages = renderLintDocs(LINT_RULES);

  it('has one page per rule plus the index, and nothing else', () => {
    const dir = join(ROOT, LINT_DOCS_DIR);
    expect(existsSync(dir), FIX).toBe(true);
    expect(readdirSync(dir).sort(), FIX).toEqual([...pages.keys()].sort());
  });

  it('every committed page is current', () => {
    for (const [name, content] of pages) {
      expect(readFileSync(join(ROOT, LINT_DOCS_DIR, name), 'utf8'), `${name}: ${FIX}`).toBe(content);
    }
  });

  it('the mkdocs nav block lists every page', () => {
    const mkdocs = readFileSync(join(ROOT, 'mkdocs.yml'), 'utf8');
    const begin = mkdocs.indexOf(NAV_BEGIN);
    const end = mkdocs.indexOf(NAV_END);
    expect(begin, 'mkdocs.yml lacks the ids-lint nav block').toBeGreaterThan(0);
    const lineStart = mkdocs.lastIndexOf('\n', begin) + 1;
    const block = mkdocs.slice(lineStart, mkdocs.indexOf('\n', end));
    expect(block, FIX).toBe(renderLintNav(LINT_RULES, mkdocs.slice(lineStart, begin)));
  });

  it('the package README rule table matches the catalogue', () => {
    const readme = readFileSync(join(ROOT, 'packages/ids-authoring/README.md'), 'utf8');
    for (const r of LINT_RULES) expect(readme, r.code).toContain(`| \`${r.code}\` | ${r.defaultSeverity} | ${r.title} | ${r.fix ? 'yes' : 'no'} |`);
  });

  it('links each docs URL to an existing page', () => {
    for (const r of LINT_RULES) expect(pages.has(`${r.code.toLowerCase()}.md`)).toBe(true);
  });
});

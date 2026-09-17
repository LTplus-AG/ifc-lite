#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Every Markdown page under docs/ must be reachable from the site: listed in
 * mkdocs.yml `nav`, or matched by its `not_in_nav` declaration (#4912).
 *
 * WHY THIS EXISTS. The docs site is built with `mkdocs build --strict`, where
 * `validation.nav.omitted_files: warn` turns an unlisted page into a hard
 * failure. #4875 added docs/guide/cost-panel.md without a nav entry; no PR lane
 * built the site, so it merged green and then stopped the nightly production
 * deploy (the ifclite.dev project builds the docs strictly). The CI `docs-site`
 * job now runs the real build; this check is the fast, Python-free half that
 * also runs in `Node tests` and names the page and the fix directly.
 *
 * Deliberately narrow: it reads only the `nav:` page paths and the
 * `not_in_nav:` patterns (mkdocs gitignore-style `dir/**` and exact paths —
 * the only shapes mkdocs.yml uses). A pattern shape it does not understand is
 * a failure, never a silent pass.
 *
 * Usage: node scripts/docs/check-mkdocs-nav.mjs [--root <repo>]
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

/** @param {string} text mkdocs.yml */
export function navPages(text) {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((l) => /^nav:\s*$/.test(l));
  if (start === -1) throw new Error('mkdocs.yml has no top-level `nav:` block');
  const pages = new Set();
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    if (/^\S/.test(line)) break; // next top-level key
    const m = /^\s*-\s*(?:[^:]*:\s*)?([^\s:]+\.md)\s*$/.exec(line);
    if (m) pages.add(m[1]);
  }
  return pages;
}

/** @param {string} text mkdocs.yml */
export function notInNavPatterns(text) {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((l) => /^not_in_nav:\s*\|\s*$/.test(l));
  if (start === -1) return [];
  const patterns = [];
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === '') continue;
    if (!/^\s+/.test(line)) break;
    patterns.push(line.trim());
  }
  return patterns;
}

/** @param {string} page docs-relative, forward slashes @param {string[]} patterns */
export function isExcluded(page, patterns) {
  return patterns.some((pattern) => {
    if (pattern.endsWith('/**') && !pattern.slice(0, -3).includes('*')) {
      return page.startsWith(`${pattern.slice(0, -3)}/`);
    }
    if (!pattern.includes('*')) return page === pattern;
    throw new Error(`not_in_nav pattern "${pattern}" has a shape this check does not understand; extend check-mkdocs-nav.mjs`);
  });
}

/** Markdown pages mkdocs builds from `docsDir` (theme overrides are templates, not pages). */
export function docPages(docsDir) {
  const out = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'overrides') continue;
        walk(full);
      } else if (entry.name.endsWith('.md')) {
        out.push(relative(docsDir, full).split('\\').join('/'));
      }
    }
  };
  walk(docsDir);
  return out.sort();
}

/** @returns {string[]} pages neither in nav nor declared not_in_nav */
export function omittedPages(root) {
  const text = readFileSync(join(root, 'mkdocs.yml'), 'utf8');
  const nav = navPages(text);
  const patterns = notInNavPatterns(text);
  return docPages(join(root, 'docs')).filter((page) => !nav.has(page) && !isExcluded(page, patterns));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const rootIndex = process.argv.indexOf('--root');
  const root = rootIndex !== -1 ? process.argv[rootIndex + 1] : join(dirname(fileURLToPath(import.meta.url)), '..', '..');
  if (!existsSync(join(root, 'mkdocs.yml'))) {
    console.error(`❌ ${join(root, 'mkdocs.yml')} not found`);
    process.exit(1);
  }
  const omitted = omittedPages(root);
  if (omitted.length > 0) {
    console.error(
      `❌ ${omitted.length} docs page(s) are not in mkdocs.yml \`nav\` and not declared \`not_in_nav\`:\n` +
        omitted.map((p) => `  - ${p}`).join('\n') +
        '\n\n`mkdocs build --strict` (the ifclite.dev deploy) fails on these. Add each page to `nav`,' +
        '\nor, if it is deliberately unlisted, to `not_in_nav` with the reason.',
    );
    process.exit(1);
  }
  console.log('✔ every docs page is in mkdocs.yml nav or declared not_in_nav');
}

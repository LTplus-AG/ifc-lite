#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Guard: nothing may land in apps/viewer/public that no code, markup or
 * manifest anywhere in the repo actually points at.
 *
 * BACKGROUND (#4111). Five favicon variants sat in apps/viewer/public for
 * months, 1.885 MiB shipped to every visitor for nothing — dead weight that
 * a lone `grep` in a maintainer's issue found and #4114 deleted. Nothing
 * caught that they were dead when they were added, and nothing would catch
 * the next one. This is that check: it fails when apps/viewer/public gains a
 * file that no other tracked text file in the repo references.
 *
 * WHAT COUNTS AS A REFERENCE. A substring search, not a parsed reference
 * graph — see scripts/lib/asset-usage.mjs's findUnreferencedAssets for the
 * exact candidates it tries (basename, the scan-relative path, and that path
 * with a leading "/"). It scans EVERY tracked text file, not just app
 * source: apps/viewer/index.html, apps/viewer/public/manifest.json, root
 * vercel.json, docs, and E2E specs all count as consumers. Deliberately
 * permissive — a missed dead file is a much smaller problem than a live one
 * flagged as dead and deleted by a future PR that trusts this gate.
 *
 * WHAT IT CANNOT SEE. It is lexical: a path built at runtime by string
 * concatenation or a template literal (`` `/favicon-${size}.png` ``) only
 * matches if the literal pieces happen to contain a whole candidate string.
 * None of the current viewer code does this (checked by hand when this gate
 * was added), but a future refactor that introduces one would need an
 * ALLOWLIST entry, same as any other false positive.
 *
 * ALLOWLIST. Some files are fetched by convention — a browser or crawler
 * requests them by a fixed name with no in-repo link ever pointing at them
 * (favicon.ico, apple-touch-icon.png, robots.txt). Those get an explicit,
 * reasoned row below instead of silently passing or permanently failing.
 * Adding a row is a real claim a reviewer can see and question, exactly
 * like the module-size gate's ALLOWLIST — it is not a way to make the gate
 * stop looking, it is a way to say "this one has a reason".
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';
import { findUnreferencedAssets, TEXT_EXTENSIONS } from './lib/asset-usage.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// Scoped to apps/viewer/public per #4111 — the SPA that actually shipped the
// dead favicons. Not generalized to every app's static directory: apps/landing
// and docs/assets are plain static trees with no build step to silently
// accumulate unreviewed output into, and widening scope without a concrete
// second incident to point at is exactly the kind of speculative generality
// AGENTS.md asks gates to avoid.
const SCAN_DIR = 'apps/viewer/public';

// TEXT_EXTENSIONS lives in ./lib/asset-usage.mjs so check-asset-usage.test.mjs
// can assert on it directly instead of round-tripping through a real git
// checkout.

// Convention-fetched paths (relative to SCAN_DIR) that legitimately have no
// in-repo reference. Each row needs a reason a reviewer can check.
const ALLOWLIST = [
  // Browsers request /favicon.ico directly, with no <link> tag required.
  // This repo's index.html happens to link it too, but that is not
  // guaranteed to stay true, and the request happens either way.
  'favicon.ico',
  // iOS Safari (and other UAs) request this exact path when a page is
  // added to the home screen, independent of any <link rel="apple-touch-icon">.
  'apple-touch-icon.png',
  // Crawlers request /robots.txt by convention; nothing in-repo ever needs
  // to spell its name. Not present today, allowlisted for when it lands.
  'robots.txt',
  // Same convention as robots.txt: crawlers and IDEs fetch it by fixed name.
  'sitemap.xml',
];

function git(args) {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf-8', maxBuffer: 64 * 1024 * 1024 });
}

function listTrackedFiles(pathspec) {
  const args = ['ls-files', '-z'];
  if (pathspec) args.push('--', pathspec);
  const raw = git(args);
  return raw.split('\0').filter(Boolean);
}

const assetFiles = listTrackedFiles(SCAN_DIR);
if (assetFiles.length === 0) {
  console.error(`❌ ${SCAN_DIR} has no tracked files (or does not exist). This check's scan dir
   is stale — fix SCAN_DIR in scripts/check-asset-usage.mjs, don't ignore this.`);
  process.exit(1);
}

const assetPaths = assetFiles.map((p) => relative(SCAN_DIR, p));

const allFiles = listTrackedFiles();
const corpusFiles = [];
for (const p of allFiles) {
  const dot = p.lastIndexOf('.');
  const ext = dot === -1 ? '' : p.slice(dot);
  if (!TEXT_EXTENSIONS.has(ext)) continue;
  let content;
  try {
    content = readFileSync(join(ROOT, p), 'utf-8');
  } catch {
    continue; // deleted-but-still-in-index, a symlink, or non-utf8 — skip, don't crash the gate
  }
  corpusFiles.push({ path: p, content });
}

const { unreferenced, allowlisted } = findUnreferencedAssets({ assetPaths, corpusFiles, allowlist: ALLOWLIST });

if (unreferenced.length === 0) {
  console.log(`✅ Every tracked file under ${SCAN_DIR} (${assetPaths.length} files) is referenced somewhere in the repo` +
    (allowlisted.length > 0 ? `, except ${allowlisted.length} allowlisted convention-fetched file(s): ${allowlisted.join(', ')}.` : '.'));
  process.exit(0);
}

console.error(`❌ ${unreferenced.length} file(s) under ${SCAN_DIR} have no reference anywhere in the repo:
${unreferenced.map((p) => `   - ${p}`).join('\n')}

If genuinely dead, delete the file(s) (this is what #4111/#4114 did for five
leftover favicons). If it is fetched by convention (favicon.ico, robots.txt,
a manifest icon) with no in-repo link, add a reasoned row to ALLOWLIST in
scripts/check-asset-usage.mjs instead of ignoring this.`);

process.exit(1);

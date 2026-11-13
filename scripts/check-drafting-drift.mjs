#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Report which vendored drafting-core files changed upstream since the pin.
 *
 * Reads apps/viewer/src/lib/drafting-core/provenance.json, fetches each
 * file's upstream path at the upstream repository's default-branch head, and
 * compares its sha256 with the one recorded at the pinned commit. For
 * `adapted: true` files that is the upstream original we trimmed from, so a
 * change there means "upstream moved; review whether to port it", not that our
 * copy is wrong. The offline twin, provenance.test.ts, checks our own bytes.
 *
 * @unwired-by-design it needs the network and reports upstream movement, which is a maintainer's call, not a CI verdict
 *
 * Usage: node scripts/check-drafting-drift.mjs [--ref <branch|sha>]
 * Exit: 0 when every file matches, 1 when any changed or is missing upstream,
 * 2 on a network or input error.
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const MANIFEST = join(ROOT, 'apps/viewer/src/lib/drafting-core/provenance.json');

function parseArgs(argv) {
  const i = argv.indexOf('--ref');
  if (i < 0) return { ref: null };
  const ref = argv[i + 1];
  if (!ref || ref.startsWith('--')) {
    console.error('check-drafting-drift: --ref needs a value (a branch, tag or commit)');
    process.exit(2);
  }
  return { ref };
}

async function fetchText(url, accept) {
  const res = await fetch(url, { headers: { 'User-Agent': 'ifc-lite-drafting-drift', Accept: accept } });
  return { status: res.status, body: res.ok ? Buffer.from(await res.arrayBuffer()) : null };
}

async function main() {
  const { ref: refArg } = parseArgs(process.argv.slice(2));
  const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8'));
  const slug = new URL(manifest.repository).pathname.replace(/^\/|\.git$/g, '');

  let ref = refArg;
  let head = null;
  if (!ref) {
    const repo = await fetchText(`https://api.github.com/repos/${slug}`, 'application/vnd.github+json');
    if (!repo.body) throw new Error(`GitHub API ${repo.status} for ${slug}`);
    ref = JSON.parse(repo.body.toString('utf8')).default_branch;
  }
  const commit = await fetchText(`https://api.github.com/repos/${slug}/commits/${ref}`, 'application/vnd.github+json');
  if (commit.body) head = JSON.parse(commit.body.toString('utf8')).sha;

  console.log(`upstream ${slug} ${ref}${head ? ` @ ${head}` : ''}; pinned ${manifest.commit}`);
  let drifted = 0;
  for (const f of manifest.files) {
    const raw = await fetchText(`https://raw.githubusercontent.com/${slug}/${head ?? ref}/${f.upstream}`, '*/*');
    const tag = f.adapted ? 'adapted' : 'pinned';
    if (!raw.body) {
      drifted++;
      console.log(`  MISSING   ${f.path} (${tag}): ${f.upstream} -> HTTP ${raw.status}`);
      continue;
    }
    const sha = createHash('sha256').update(raw.body).digest('hex');
    if (sha === f.sha256) {
      console.log(`  unchanged ${f.path} (${tag})`);
    } else {
      drifted++;
      console.log(`  CHANGED   ${f.path} (${tag}): ${f.sha256.slice(0, 12)} -> ${sha.slice(0, 12)}`);
    }
  }
  console.log(drifted === 0 ? 'no upstream drift' : `${drifted} file(s) differ upstream`);
  process.exitCode = drifted === 0 ? 0 : 1;
}

main().catch((err) => {
  console.error(`check-drafting-drift: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 2;
});

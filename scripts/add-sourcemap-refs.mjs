/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Append a `//# sourceMappingURL=` comment to every built chunk that has a
 * sibling `.map`, so PostHog's CLI can pair the two before uploading.
 *
 * Why this exists: the viewer builds with rolldown-vite, which writes the map
 * files but does NOT emit the trailing sourceMappingURL comment. posthog-cli
 * documents that it locates maps through that comment — see its
 * `--public-path-prefix` flag ("we need to ignore it while searching for
 * them") — so without it the upload may find no maps to pair. Adding the
 * comment makes the pairing true by construction rather than relying on an
 * unverified filename-convention fallback.
 *
 * `posthog-cli sourcemap process --delete-after` strips these comments (and
 * deletes the maps) after uploading, so nothing ships to users with a dangling
 * reference. The build script also sweeps any leftover `.map` regardless.
 *
 * Idempotent: a chunk that already carries a reference is skipped, so running
 * twice cannot double-append.
 *
 * Usage:
 *   node scripts/add-sourcemap-refs.mjs <dir>            add references
 *   node scripts/add-sourcemap-refs.mjs <dir> --strip    remove references
 *
 * `--strip` is the cleanup path for when the upload did not run or failed: the
 * build sweeps the `.map` files out of the output either way, and a chunk left
 * pointing at a map that is no longer there makes browsers with devtools open
 * 404 on every asset. Stripping removes ANY sourceMappingURL comment, including
 * the ones the bundler emitted itself, which is correct once no maps remain.
 */

import fs from 'node:fs';
import path from 'node:path';

const dir = process.argv[2];
const strip = process.argv.includes('--strip');
if (!dir) {
  console.error('usage: node scripts/add-sourcemap-refs.mjs <dir> [--strip]');
  process.exit(1);
}
if (!fs.existsSync(dir)) {
  console.error(`[sourcemap-refs] directory not found: ${dir}`);
  process.exit(1);
}

// Match a sourceMappingURL comment at the start of any line, so a chunk that
// already has one (from a bundler that does emit it) is left untouched.
const HAS_REF = /^\/\/# sourceMappingURL=/m;

let added = 0;
let skipped = 0;

function walk(current) {
  for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
    const full = path.join(current, entry.name);
    if (entry.isDirectory()) {
      walk(full);
      continue;
    }
    if (!entry.name.endsWith('.js')) continue;

    if (strip) {
      const src = fs.readFileSync(full, 'utf8');
      if (!HAS_REF.test(src)) {
        skipped++;
        continue;
      }
      fs.writeFileSync(full, src.replace(/\n?^\/\/# sourceMappingURL=.*$\n?/gm, '\n'));
      added++;
      continue;
    }

    if (!fs.existsSync(`${full}.map`)) continue;
    if (HAS_REF.test(fs.readFileSync(full, 'utf8'))) {
      skipped++;
      continue;
    }
    // Relative to the chunk, so it resolves regardless of the asset base path.
    fs.appendFileSync(full, `\n//# sourceMappingURL=${entry.name}.map\n`);
    added++;
  }
}

walk(dir);
console.log(
  strip
    ? `[sourcemap-refs] stripped ${added} reference(s), ${skipped} had none`
    : `[sourcemap-refs] added ${added} reference(s), ${skipped} already present`,
);

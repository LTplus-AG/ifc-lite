/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Pure detection logic for check-asset-usage.mjs, split out so it can be
 * tested against synthetic fixtures instead of this checkout's own state
 * (the module-size and refwalk gates split the same way, for the same
 * reason: the CLI wrapper drives real `git ls-files`, the test drives this).
 *
 * An asset under the scanned directory (apps/viewer/public, at the call
 * site) is "referenced" if some OTHER tracked text file in the repo — any
 * file, not just source: index.html, manifest.json, vercel.json, docs,
 * CSS, E2E specs all count — contains the asset's basename, its
 * scan-relative path, or that path with a leading "/" (the root-absolute
 * form a static-asset directory is served under). That is a substring
 * search, not a parsed reference graph: it is deliberately permissive, so
 * the gate's failure mode is a missed dead file, never a live one flagged
 * as dead.
 */

/**
 * Extensions worth reading as text for the substring search. Deliberately
 * broad — docs (.md), configs (.json/.yml/.toml), markup (.html) and styles
 * (.css) have all been real consumers in this repo's history. `.mts`/`.cts`
 * are TypeScript too (tools/demo-kit/derive-variants.mts builds
 * apps/viewer/public/samples/* paths at lines ~116-120) — omitting them left
 * a live-asset-flagged-dead trap: the only thing stopping a false positive
 * today is that those sample names are also spelled out in
 * apps/viewer/src/lib/tours/demo-kit.ts and AGENTS.md, both already-covered
 * extensions. `.sh`/`.py`/`.rs` are deliberately NOT added here: none of
 * them reference a path under apps/viewer/public today (checked by grepping
 * this repo's tracked .sh/.py/.rs files for every current asset's basename),
 * so adding them would only cost scan time for extensions this scan dir has
 * no current consumer in.
 */
export const TEXT_EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts',
  '.json', '.html', '.htm', '.css', '.scss',
  '.md', '.mdx', '.yml', '.yaml', '.txt', '.xml', '.toml',
]);

/**
 * @param {object} args
 * @param {string[]} args.assetPaths - paths relative to the scanned
 *   directory, e.g. "favicon.ico", "oauth/bcf/callback.html".
 * @param {{path: string, content: string}[]} args.corpusFiles - every other
 *   tracked text file in the repo, `path` repo-relative, for substring search.
 * @param {Iterable<string>} args.allowlist - scan-relative asset paths that
 *   are exempt (convention-fetched: favicon.ico, robots.txt, etc).
 * @returns {{ unreferenced: string[], allowlisted: string[] }}
 */
export function findUnreferencedAssets({ assetPaths, corpusFiles, allowlist }) {
  const allowSet = new Set(allowlist);
  const unreferenced = [];
  const allowlisted = [];

  for (const relPath of assetPaths) {
    const basename = relPath.split('/').pop();
    const candidates = [basename, `/${relPath}`, relPath];
    const referenced = corpusFiles.some((f) => candidates.some((c) => f.content.includes(c)));
    if (referenced) continue;
    if (allowSet.has(relPath)) {
      allowlisted.push(relPath);
    } else {
      unreferenced.push(relPath);
    }
  }

  return { unreferenced, allowlisted };
}

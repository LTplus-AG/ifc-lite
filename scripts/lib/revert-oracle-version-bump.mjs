/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The automated changesets release PR (`chore: version packages`) touches
 * only `package.json` `"version"` fields, the workspace `Cargo.toml`'s own
 * `version = "..."` and the matching version literal on each internal
 * `ifc-lite-*` path-dependency line, plus generated `CHANGELOG.md` /
 * `.changeset/*.md` (already `ignored` by `classifyPath`). No test can
 * observe a version literal, so `check-test-revert-oracle.mjs` aborts every
 * release cycle with "changes production code and adds/changes NO test
 * file" — a standing false positive, not a real finding (see the release-PR
 * cluster: #3357, #4018 both failed here; #3950 needed a manual
 * `revert-oracle-exempt` label to get through).
 *
 * THE DANGER THIS MODULE IS WRITTEN AGAINST. `package.json` and `Cargo.toml`
 * also carry dependency versions, `scripts`, and `exports` — a change to any
 * of those IS production and must keep counting. In particular Cargo.toml
 * writes plenty of external deps in the same `{ version = "...", features =
 * [...] }` table form as the internal path deps (axum, tokio, serde, ...), so
 * "only a version literal changed on this line" is NOT enough by itself: an
 * external dependency bump (axum 0.8 -> 0.9) has the exact same line shape as
 * an internal workspace crate bump (ifc-lite-core 9.3.0 -> 9.4.0). The
 * discriminator is `path = "..."` on the same line: only the workspace's own
 * crates are referenced via a path dependency, so a line lacking `path =` is
 * never treated as version-only here.
 *
 * Pure functions over diff text, same shape as `revert-oracle.mjs`, so this
 * is tested against synthetic fixtures without touching git.
 */

const NPM_MANIFEST_RE = /(^|\/)package\.json$/;
const CARGO_MANIFEST_RE = /(^|\/)Cargo\.toml$/;

/** Split zero-context (`git diff -U0`) output into per-hunk removed/added line groups. */
function extractHunks(diffText) {
  const hunks = [];
  let removed = [];
  let added = [];
  const flush = () => {
    if (removed.length > 0 || added.length > 0) hunks.push({ removed, added });
    removed = [];
    added = [];
  };
  for (const line of diffText.split('\n')) {
    if (line.startsWith('@@')) {
      flush();
      continue;
    }
    if (line.startsWith('--- ') || line.startsWith('+++ ')) continue;
    if (line.startsWith('-')) removed.push(line.slice(1));
    else if (line.startsWith('+')) added.push(line.slice(1));
  }
  flush();
  return hunks;
}

/** `"version": "1.40.0"` -> `"version": "1.40.1"`, nothing else on the line. */
function npmVersionOnly(oldLine, newLine) {
  const RE = /^(\s*"version":\s*")([^"]*)("\s*,?\s*)$/;
  const om = oldLine.match(RE);
  const nm = newLine.match(RE);
  if (!om || !nm) return false;
  return om[1] === nm[1] && om[3] === nm[3];
}

/** A bare `version = "9.3.0"` line (the workspace's own `[workspace.package]` version). */
function cargoBareVersionOnly(oldLine, newLine) {
  const RE = /^(\s*)version(\s*=\s*")([^"]*)("\s*)$/;
  const om = oldLine.match(RE);
  const nm = newLine.match(RE);
  if (!om || !nm) return false;
  return om[1] === nm[1] && om[2] === nm[2] && om[4] === nm[4];
}

/**
 * A `name = { version = "9.3.0", path = "...", ... }` line. Requires `path =`
 * on the SAME line — the discriminator that keeps a real external dependency
 * bump (which never carries `path =`) from matching.
 */
function cargoPathVersionOnly(oldLine, newLine) {
  const PATH_RE = /\bpath\s*=\s*"/;
  const VERSION_KV = /version\s*=\s*"[^"]*"/;
  if (!PATH_RE.test(oldLine) || !PATH_RE.test(newLine)) return false;
  if (!VERSION_KV.test(oldLine) || !VERSION_KV.test(newLine)) return false;
  const oldNorm = oldLine.replace(VERSION_KV, 'version = "#"');
  const newNorm = newLine.replace(VERSION_KV, 'version = "#"');
  return oldNorm === newNorm;
}

/**
 * @param {string} path repo-relative path of the changed file
 * @param {string} diffText `git diff -U0 <base> <head> -- <path>` output
 * @returns {boolean} true only if every changed line is a version-literal
 *   substitution in a position this module recognizes as the file's own (or,
 *   for Cargo.toml, a path-dependency's) version — never a dependency add/
 *   remove, script, export, or any other field.
 */
export function isVersionOnlyManifestDiff(path, diffText) {
  const isNpm = NPM_MANIFEST_RE.test(path);
  const isCargo = CARGO_MANIFEST_RE.test(path);
  if (!isNpm && !isCargo) return false;
  const hunks = extractHunks(diffText);
  if (hunks.length === 0) return false;
  for (const { removed, added } of hunks) {
    if (removed.length === 0 || added.length === 0) return false;
    if (removed.length !== added.length) return false;
    for (let i = 0; i < removed.length; i++) {
      const ok = isNpm
        ? npmVersionOnly(removed[i], added[i])
        : cargoBareVersionOnly(removed[i], added[i]) || cargoPathVersionOnly(removed[i], added[i]);
      if (!ok) return false;
    }
  }
  return true;
}

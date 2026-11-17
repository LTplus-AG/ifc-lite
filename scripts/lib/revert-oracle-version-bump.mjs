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
 * One narrower carve-out is a maintainer policy, not an unobservability claim:
 * `isDependencyVersionOnlyPackageJson` (bottom of this file) ignores a
 * package.json whose parsed JSON differs only in `dependencies`,
 * `devDependencies` or `optionalDependencies` version specs. Reverting the
 * manifest without its (ignored) lockfile is not a coherent experiment, so the
 * build and test lanes judge such a bump (#10492, #10562). Peer ranges are a
 * published contract and stay production.
 *
 * Pure functions over diff text, same shape as `revert-oracle.mjs`, so this
 * is tested against synthetic fixtures without touching git.
 */

const NPM_MANIFEST_RE = /(^|\/)package\.json$/;
const CARGO_MANIFEST_RE = /(^|\/)Cargo\.toml$/;
const RUST_MAJOR_OFFSET_PATH = 'rust-major-offset.json';
const LEGACY_RUST_MAJOR_OFFSET_KEYS = ['$comment', 'majorOffset', 'reason', 'refs'];
const RUST_MAJOR_OFFSET_KEYS = ['$comment', 'majorOffset', 'reason', 'latestBreak', 'refs'];

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

/** Parse the repository's canonical JSON form, rejecting duplicate keys. */
function parseCanonicalJson(text) {
  if (typeof text !== 'string') return null;
  try {
    const value = JSON.parse(text);
    if (JSON.stringify(value, null, 2) + '\n' !== text) return null;
    return value;
  } catch (error) {
    if (error instanceof SyntaxError) return null;
    throw error;
  }
}

/** A complete, narrowly validated crate-major-offset increment. */
function rustMajorOffsetOnly(beforeText, afterText) {
  const before = parseCanonicalJson(beforeText);
  const after = parseCanonicalJson(afterText);
  if (!before || !after || Array.isArray(before) || Array.isArray(after)) return false;
  const beforeKeys = Object.keys(before).join('\0');
  if (beforeKeys !== LEGACY_RUST_MAJOR_OFFSET_KEYS.join('\0')
    && beforeKeys !== RUST_MAJOR_OFFSET_KEYS.join('\0')) return false;
  if (Object.keys(after).join('\0') !== RUST_MAJOR_OFFSET_KEYS.join('\0')) return false;
  if (before.$comment !== after.$comment) return false;
  if (!Number.isSafeInteger(before.majorOffset) || before.majorOffset < 0) return false;
  if (!Number.isSafeInteger(after.majorOffset) || after.majorOffset !== before.majorOffset + 1) return false;
  if (typeof before.reason !== 'string' || typeof after.reason !== 'string') return false;
  const expectedReason = 'latestBreak' in before
    ? `${before.reason} ${before.latestBreak}`
    : before.reason;
  if (after.reason !== expectedReason) return false;
  if (typeof after.latestBreak !== 'string' || after.latestBreak.trim().length === 0) return false;
  if ('latestBreak' in before
    && (typeof before.latestBreak !== 'string'
      || before.latestBreak.trim() === after.latestBreak.trim())) return false;
  if (!Array.isArray(before.refs) || !Array.isArray(after.refs)) return false;
  if (after.refs.length <= before.refs.length) return false;
  if (!before.refs.every((ref, i) => typeof ref === 'string' && after.refs[i] === ref)) return false;
  return after.refs.slice(before.refs.length).every((ref) => typeof ref === 'string' && /^#\d+$/.test(ref));
}

/**
 * @param {string} path repo-relative path of the changed file
 * @param {string} diffText `git diff -U0 <base> <head> -- <path>` output
 * @param {{ beforeText?: string, afterText?: string }} [contents] complete
 *   merge-base/head contents, required for rust-major-offset.json
 * @returns {boolean} true only if every change is a version increment
 *   substitution in a position this module recognizes as the file's own (or,
 *   for Cargo.toml, a path-dependency's) version — never a dependency add/
 *   remove, script, export, or any other field.
 */
export function isVersionOnlyManifestDiff(path, diffText, contents = {}) {
  if (path === RUST_MAJOR_OFFSET_PATH) {
    return extractHunks(diffText).length > 0
      && rustMajorOffsetOnly(contents.beforeText, contents.afterText);
  }
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

// Not `peerDependencies`: a peer range is a published consumer contract, and
// tests assert on it (sdk-peer-contract.test.ts, template-peer-ranges.test.ts).
const DEPENDENCY_FIELDS = new Set(['dependencies', 'devDependencies', 'optionalDependencies']);
const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

function parseObject(text) {
  const value = parseCanonicalJson(text);
  return isPlainObject(value) ? value : null;
}

/** A semver version or x-range: `1`, `1.2`, `1.x`, `1.2.x`, `1.2.3-rc.1+b`. Never a tag, path or URL. */
const VERSION_RE = /^(?:0|[1-9]\d*)(?:\.(?:0|[1-9]\d*)(?:\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?|\.[xX*])?|\.[xX*](?:\.[xX*])?)?$/;
const COMPARATOR_RE = new RegExp(`^(?:[~^]|[<>]=?|=)?${VERSION_RE.source.slice(1)}`);

/**
 * A numeric registry version range: comparator sets joined by `||`, or a
 * `a - b` hyphen range. Anything else (`npm:` alias, `workspace:`, `file:`,
 * git URL, a path, a tarball, a dist-tag such as `next15` or `*`) changes
 * WHAT is installed or floats, and stays production.
 */
const isVersionSpec = (value) => typeof value === 'string' && value.trim() === value
  && value.split('||').every((part) => {
    const tokens = part.trim().split(/\s+/);
    return tokens.length === 3 && tokens[1] === '-'
      ? VERSION_RE.test(tokens[0]) && VERSION_RE.test(tokens[2])
      : tokens.every((token) => COMPARATOR_RE.test(token));
  });

/** Same dependency names in the same order; a changed value is a version spec on both sides. */
function sameDependencyNames(before, after) {
  if (!isPlainObject(before) || !isPlainObject(after)) return false;
  const names = Object.keys(before);
  return names.join('\0') === Object.keys(after).join('\0')
    && names.every((name) => typeof before[name] === 'string' && (before[name] === after[name]
      || (isVersionSpec(before[name]) && isVersionSpec(after[name]))));
}

/**
 * A Dependabot-shaped package.json bump: decided from the parsed merge-base and
 * head JSON, not from diff lines. `dependencies`, `devDependencies` and
 * `optionalDependencies` may differ only in version specs; every other field,
 * `peerDependencies` included, must be identical (key order included, since
 * `exports` is order-sensitive). Adding or removing a dependency, or any edit
 * to `scripts`, `exports`, `main`, ... is production. Fail-closed: an unreadable, unparseable or non-canonical side
 * (which also rejects duplicate keys) returns false.
 *
 * @param {string} path repo-relative path of the changed file
 * @param {(path: string) => { before?: string, after?: string }} readSides merge-base/head text
 */
export function isDependencyVersionOnlyPackageJson(path, readSides) {
  if (!NPM_MANIFEST_RE.test(path)) return false;
  const sides = readSides(path);
  const before = parseObject(sides?.before);
  const after = parseObject(sides?.after);
  if (!before || !after) return false;
  const keys = Object.keys(before);
  if (keys.join('\0') !== Object.keys(after).join('\0')) return false;
  return keys.every((key) => DEPENDENCY_FIELDS.has(key)
    ? sameDependencyNames(before[key], after[key])
    : JSON.stringify(before[key]) === JSON.stringify(after[key]));
}

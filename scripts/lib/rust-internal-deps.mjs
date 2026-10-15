/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Scanning and rewriting the internal `ifc-lite-*` dependency declarations in
 * the Rust manifests. Split out of `rust-major-offset.mjs` (module-size
 * ratchet): that file owns the version arithmetic and the workspace scan, this
 * one owns "which manifests declare which internal dependency, and how".
 * `sync-versions.js` (writer) and `check-rust-major-offset.mjs` (checker) both
 * go through it, so the two halves read the same set of declarations.
 */

/** An error carrying a machine-readable reason, so a caller can print WHY it
 * refused rather than a bare stack. */
export function offsetError(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

/** The crate directories whose manifests declare internal `ifc-lite-*`
 * dependencies: by inheriting the root `[workspace.dependencies]` literal, or
 * (a legacy shape the gate still polices) by carrying an explicit
 * `version = "…"` of their own. Kept here, next to the pattern, so
 * `sync-versions.js` (which rewrites explicit literals) and
 * `check-rust-major-offset.mjs` (which checks them and counts the inherited
 * ones) cannot drift apart into "the writer skipped a file the checker never
 * looked at". */
export const RUST_MEMBER_DIRS = ['core', 'geometry', 'processing', 'clash', 'export', 'ffi', 'wasm-bindings', 'landxml'];

/** The internal crate names that carry a `version = "…"` requirement. */
const INTERNAL_CRATE = '(?:core|geometry|processing|clash|export|wasm|landxml)';

/** A fresh `/g` regex each call — a shared one carries `lastIndex` between
 * callers and silently skips matches.
 *
 * Matches the WHOLE inline table, not `name = { version = "…"` — key order in
 * a TOML inline table is free, and a pattern that demanded `version` first
 * read `{ path = "../core", version = "1.2.3" }` as no declaration at all.
 * That was invisible to BOTH halves the same way: `sync-versions.js` left the
 * literal at the previous release and `check-rust-major-offset.mjs` printed a
 * count of the literals it HAD seen as though it were the whole set. Cargo
 * catches the resulting mismatch, so nothing shipped wrong — but a gate
 * reporting agreement over a region it never examined is the vacuity shape
 * this repo has been clearing, and it is the reason the count is now
 * cross-checked below. */
export function internalDepPattern() {
  return new RegExp(`(ifc-lite-${INTERNAL_CRATE})\\s*=\\s*\\{([^{}]*)\\}`, 'g');
}

/** A dotted-key inheritance, `ifc-lite-core.workspace = true`. It carries no
 * version of its own (it agrees through the root literal, which is checked), so
 * it is not an {@link internalDepPattern} match; the gate counts it as an
 * inherited declaration so a manifest that inherits is still "inspected". */
export function inheritedInternalDepPattern() {
  return new RegExp(`^\\s*(ifc-lite-${INTERNAL_CRATE})\\.workspace\\s*=\\s*true`, 'gm');
}

/** Just the `name = {` opener. Every opener MUST turn into a parsed
 * declaration; the gap between the two counts is what a nested inline table
 * (which `internalDepPattern`'s `[^{}]*` body cannot span) would open, and
 * silently dropping such a declaration is the same defect by another route. */
export function internalDepOpenerPattern() {
  return new RegExp(`ifc-lite-${INTERNAL_CRATE}\\s*=\\s*\\{`, 'g');
}

/** The `version = "…"` requirement inside an inline-table body, at any
 * position among the other keys. */
export function versionInDepBodyPattern() {
  return /(version\s*=\s*")([^"]+)(")/;
}

/**
 * Every internal dependency declaration in one manifest, in source order.
 *
 * `version` is `null` for a declaration that carries none — `{ workspace =
 * true }` and a bare `{ path = "…" }` are legitimate and are neither counted
 * nor rewritten. Throws `UNPARSED_DEP` rather than returning a short list if
 * any declaration could not be parsed, so the checker's count and the writer's
 * rewrite always cover the same set.
 */
export function scanInternalDeps(label, text) {
  return scanInternalDepsDetailed(label, text).deps;
}

/** {@link scanInternalDeps} plus the declarations that inherit from the root
 * table: `inherited` lists the names declared as `name.workspace = true` or as
 * an inline table with `workspace = true` (and no `version`). */
export function scanInternalDepsDetailed(label, text) {
  // Two spellings this scan cannot see: a `[dependencies.ifc-lite-x]` table
  // header and a dotted `ifc-lite-x.version = "…"` key. Both are valid TOML and
  // both would carry a literal that neither the gate nor the writer reads, so
  // refuse them by name instead of reporting agreement over them.
  const unsupported = new RegExp(
    `^\\s*(?:\\[[^\\]\\n]*dependencies\\.ifc-lite-${INTERNAL_CRATE}\\]|ifc-lite-${INTERNAL_CRATE}\\.(?!workspace\\b)[\\w-]+\\s*=)`,
    'm'
  ).exec(text);
  if (unsupported) {
    throw offsetError(
      'UNPARSED_DEP',
      `${label} declares an internal dependency as \`${unsupported[0].trim()}\`, a spelling this scan does not read. Use an inline table (\`ifc-lite-x = { version = "…", path = "…" }\`) or \`ifc-lite-x.workspace = true\`.`
    );
  }
  const openers = text.match(internalDepOpenerPattern())?.length ?? 0;
  const deps = [];
  const pattern = internalDepPattern();
  let m;
  while ((m = pattern.exec(text)) !== null) {
    const version = versionInDepBodyPattern().exec(m[2]);
    deps.push({ name: m[1], body: m[2], version: version ? version[2] : null });
  }
  if (deps.length !== openers) {
    throw offsetError(
      'UNPARSED_DEP',
      `${label} declares ${openers} internal dependenc(ies) but only ${deps.length} could be parsed. An inline table with a nested \`{…}\` is the usual cause; both the writer and this scan would otherwise skip it silently.`
    );
  }
  const inherited = [];
  for (const dep of deps) {
    if (dep.version === null && /(^|[\s,])workspace\s*=\s*true/.test(dep.body)) inherited.push(dep.name);
  }
  const dotted = inheritedInternalDepPattern();
  while ((m = dotted.exec(text)) !== null) inherited.push(m[1]);
  return { deps, inherited };
}

/** Rewrite every internal dependency's `version = "…"` to `version`, leaving
 * key order and every other key untouched. The writer's half of
 * {@link scanInternalDeps}, so a declaration the checker counts is a
 * declaration the writer updates. */
export function rewriteInternalDeps(label, text, version) {
  scanInternalDeps(label, text);
  return text.replace(internalDepPattern(), (whole, name, body) =>
    versionInDepBodyPattern().test(body)
      ? `${name} = {${body.replace(versionInDepBodyPattern(), `$1${version}$3`)}}`
      : whole
  );
}

/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * SOURCE-DERIVED Rust public-API extraction for scripts/check-rust-api-surface.mjs
 * (issue #4192).
 *
 * WHY. #4178 added `pub triangle_count: usize` to `OpeningDiagnostic`, a
 * `pub` struct re-exported at the `ifc-lite-geometry` crate root with every
 * field `pub` and no `#[non_exhaustive]`. That is a struct-literal-breaking
 * addition for any external constructor — `cargo-semver-checks` correctly
 * demanded a major — but nothing said so until the RELEASE PR
 * (`scripts/check-rust-semver.mjs`), by which point the only remedies left
 * were revert the field or raise the crate's major by hand. #4192 asks for
 * the same PR-time signal `scripts/check-api-surface.mjs` already gives the
 * TypeScript side: a committed snapshot, diffed on every PR, no build.
 *
 * WHAT THIS DOES NOT DO, and cannot without a real build: it does not run
 * `cargo-semver-checks` or read rustdoc JSON, so it cannot see a changed
 * function signature, a trait's defaultless method, a lost trait impl, or
 * anything reachable only behind a non-default feature. It is a TEXT parse
 * of each crate's `src/lib.rs` and the modules under it, aimed squarely at the
 * shape #4178 was: a field or variant added to a `pub`, non-`#[non_exhaustive]`
 * struct/enum that is reachable from the crate root. That is exactly the
 * class issue #4192 names (~42 such items in `ifc-lite-geometry` alone).
 *
 * SCOPE, stated as a rule so a gap reads as a documented limitation rather
 * than a silent hole:
 *
 *   A crate's tracked surface is:
 *     (a) every name in a crate-root `pub use path::{...};` statement in
 *         `src/lib.rs` (nested groups, `as` aliases, and multi-line groups
 *         all handled — this repo's lib.rs files write these mid-line and
 *         multi-line both), and
 *     (b) every `pub fn` / `pub struct` / `pub enum` / `pub trait` /
 *         `pub type` / `pub const` / `pub static` declared DIRECTLY in
 *         `src/lib.rs` (e.g. `ifc-lite-geometry`'s
 *         `LARGE_COORD_THRESHOLD_METERS`).
 *
 *   NOT tracked: an item reachable only through a `pub mod`'s own path
 *   (`crate::modname::Item`) that is not ALSO re-exported from the crate
 *   root. Several of this repo's `pub mod`s exist for exactly that direct
 *   path (see the module-visibility comment in `rust/geometry/src/lib.rs`),
 *   so this is a real, documented gap, not an oversight — closing it needs a
 *   real module-tree walk, which the source-derived approach can add later
 *   without changing the snapshot shape.
 *
 * RESOLUTION. A re-exported name whose `pub use` path's first segment is a
 * module declared locally (`mod foo;` anywhere in `src/lib.rs`, any
 * visibility) is resolved by searching every `.rs` file under the crate's
 * `src/` for a `pub struct NAME` or `pub enum NAME` declaration:
 *   - exactly one match  -> full field/variant detail (see below)
 *   - zero matches        -> not a local struct/enum; recorded by best-effort
 *                            kind (fn/const/trait/type/static) or "unknown"
 *   - more than one match -> AMBIGUOUS; recorded as "ambiguous" rather than
 *                            guessing, so a future name collision fails
 *                            loudly instead of silently picking one file.
 * A path whose first segment is NOT a locally declared module (`nalgebra`,
 * `std`, …) is an EXTERNAL re-export: recorded by name only, no field detail
 * — this crate does not own that type's shape.
 *
 * DETAIL, per resolved struct/enum (see `./rust-item-shape.mjs`):
 *   - `#[non_exhaustive]` is read from the attribute lines immediately
 *     preceding the declaration (comments/blank lines skipped, so a doc
 *     comment between the attribute and the item does not hide it).
 *   - A struct or enum ALREADY `#[non_exhaustive]` is recorded by name +
 *     kind only. Adding a field/variant there is not the semver break this
 *     gate exists to catch — cargo-semver-checks agrees, and the point of
 *     `#[non_exhaustive]` is that the type NAME is stable while its shape is
 *     allowed to move. Field/variant-level detail would just be diff noise.
 *   - A struct or enum NOT `#[non_exhaustive]` gets its full field or
 *     variant list, because that shape *is* the API contract external
 *     constructors and match arms rely on — this is #4178's exact case.
 *   - A field/variant list that cannot be confidently split (an entry that
 *     does not match the expected `name: type` / variant shape after
 *     attributes are stripped) marks the WHOLE item "fields: unparsed"
 *     rather than reporting a partial list — a partial list understates the
 *     surface, which is the false-green shape this repo's gates refuse.
 *   - A NAMED struct's fields, and an enum's variants, are sorted before
 *     being joined into the descriptor string (see `rust-item-shape.mjs`'s
 *     `parseNamedFields`/`describeEnumBody`) — a pure reorder of either is
 *     INVISIBLE to this gate. That is deliberate, not an oversight: reorder
 *     alone cannot break a caller that constructs by field name or matches
 *     an enum by variant name, which is how safe Rust uses both. A TUPLE
 *     struct/variant's fields are the opposite: declaration order IS the
 *     shape (a positional constructor breaks on reorder), so those are left
 *     unsorted — see `parseTupleFields`'s own comment.
 *
 * Reuses `lex()` from `./rust-source-text-detect.mjs` (already masks Rust
 * comments and string/char literals to spaces, keeping every offset and
 * brace/paren/bracket/angle-bracket structural character in place) so this
 * file does not carry a second Rust lexer.
 */

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';
import { lex } from './rust-source-text-detect.mjs';
import { collectDefinitions, describeDefinition, splitTopLevel } from './rust-item-shape.mjs';

/** `mod NAME;` / `pub(...) mod NAME { ... }` declarations anywhere in `masked`. */
function localModuleNames(masked) {
  const names = new Set();
  const re = /\bmod\s+([A-Za-z_][A-Za-z0-9_]*)/g;
  let m;
  while ((m = re.exec(masked)) !== null) names.add(m[1]);
  return names;
}

/**
 * One `pub use ...;` statement's re-exported `{ name, resolveName, firstSeg }`
 * entries (recurses into nested `{...}` groups, accumulating the FULL path
 * prefix so far — `pathPrefix` is `a::bar` two levels into
 * `pub use a::{bar::{Baz}};`, not just the innermost `bar`, which is what
 * `firstSeg` (the module-locality check) needs).
 *
 * `name` is the LOCAL surface key (post-`as`); `resolveName` is the actual
 * declared identifier an aliased re-export (`Dup as DupToo`) must be looked
 * up by — the definition search below never heard of `DupToo`.
 */
function parseUseItems(pathPrefix, groupText) {
  const out = [];
  for (const raw of splitTopLevel(groupText)) {
    const item = raw.trim();
    if (item.length === 0 || item === 'self') continue;
    const braceIdx = item.indexOf('{');
    if (braceIdx !== -1 && item.endsWith('}')) {
      const segment = item.slice(0, braceIdx).replace(/::$/, '');
      const subPrefix = pathPrefix ? `${pathPrefix}::${segment}` : segment;
      out.push(...parseUseItems(subPrefix, item.slice(braceIdx + 1, -1)));
      continue;
    }
    const asMatch = item.match(/^(.+?)\s+as\s+([A-Za-z_][A-Za-z0-9_]*)$/);
    const sourceName = asMatch ? asMatch[1].trim() : item;
    const localName = asMatch ? asMatch[2] : item.split('::').pop();
    if (localName === '*' || localName.length === 0) continue; // glob re-export — out of scope
    const segs = sourceName.split('::').filter(Boolean);
    const fullPath = pathPrefix ? `${pathPrefix}::${sourceName}` : sourceName;
    const firstSeg = fullPath.split('::').filter(Boolean)[0] ?? segs[0];
    out.push({ name: localName, resolveName: segs[segs.length - 1] ?? localName, firstSeg });
  }
  return out;
}

/**
 * Brace-nesting depth (curly braces only — the unit that scopes an inline
 * `mod { ... }` block) at every offset in `masked`, so a caller can tell a
 * crate-root statement from one buried inside an inline module.
 */
function braceDepths(masked) {
  const depths = new Int32Array(masked.length);
  let depth = 0;
  for (let i = 0; i < masked.length; i++) {
    depths[i] = depth;
    const c = masked[i];
    if (c === '{') depth++;
    else if (c === '}') depth = Math.max(0, depth - 1);
  }
  return depths;
}

/**
 * All root-level `pub use` re-exports declared in `lib.rs` (masked plane, so
 * multi-line groups are one statement).
 *
 * Scoped to brace-depth 0: a `pub use` inside an inline `pub mod sub { ... }`
 * block sits at depth 1+ and is deliberately skipped — the SCOPE rule above
 * tracks only what a crate root itself re-exports, and an item declared
 * inside an inline module is reachable only via that module's own path
 * (`crate::sub::X`), not the crate root, exactly like the file-module case
 * already documented above. Without this check, an inline module's `pub use`
 * folds into the flat root surface and can silently displace a genuine
 * root-level item declared under the same name (first-wins dedup below),
 * recording the wrong shape with no warning. No crate's `src/lib.rs` in this
 * repo currently uses an inline `pub mod { ... }` block (all are `pub mod
 * name;`), so this is a dormant correctness fix, not a live one.
 */
function collectRootUses(masked) {
  const items = [];
  const depths = braceDepths(masked);
  const re = /\bpub\s+use\s+/g;
  let m;
  while ((m = re.exec(masked)) !== null) {
    if (depths[m.index] !== 0) continue; // nested inside a `pub mod { ... }` block — not root
    let end = m.index + m[0].length;
    let depth = 0;
    while (end < masked.length) {
      const c = masked[end];
      if (c === '{' || c === '(') depth++;
      else if (c === '}' || c === ')') depth--;
      else if (c === ';' && depth <= 0) break;
      end++;
    }
    const stmt = masked.slice(m.index + m[0].length, end);
    const braceIdx = stmt.indexOf('{');
    if (braceIdx !== -1) {
      const prefix = stmt.slice(0, braceIdx).replace(/::\s*$/, '');
      const closeBrace = stmt.lastIndexOf('}');
      items.push(...parseUseItems(prefix, stmt.slice(braceIdx + 1, closeBrace === -1 ? undefined : closeBrace)));
    } else {
      items.push(...parseUseItems('', stmt));
    }
  }
  return items;
}

/**
 * Direct `pub fn|struct|enum|trait|type|const|static NAME` declarations in
 * `lib.rs` itself. `fn` alone carries pre-`fn` qualifiers (`const`, `async`,
 * `unsafe`, `extern "C"`, in any Rust-legal order) — `rust/ffi/src/lib.rs`'s
 * whole surface is `pub unsafe extern "C" fn ifc_lite_parse(...)`, so
 * missing these would silently empty that crate's snapshot.
 */
function collectRootDirectItems(masked) {
  const items = [];
  // `lex()` blanks a string literal's quotes AND contents to spaces, so
  // `extern "C"` reads here as `extern` followed by run of blank space —
  // there is no quote character left to match against.
  const fnRe = /\bpub\s+(?:(?:const|async|unsafe|extern)\s+)*(fn)\s+([A-Za-z_][A-Za-z0-9_]*)/g;
  // Negative lookahead on the name: `pub const fn foo` must be read as (fn,
  // foo) by fnRe above, never as (const, "fn") here.
  const otherRe = /\bpub\s+(struct|enum|trait|type|const|static)\s+(?:mut\s+)?(?!fn\b)([A-Za-z_][A-Za-z0-9_]*)/g;
  for (const re of [fnRe, otherRe]) {
    let m;
    while ((m = re.exec(masked)) !== null) items.push({ name: m[2], kind: m[1] });
  }
  return items;
}

/** Recursively list `.rs` files under `dir`. */
function listRsFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) out.push(...listRsFiles(full));
    else if (entry.endsWith('.rs')) out.push(full);
  }
  return out;
}

/**
 * Extract one crate's root-reachable public API surface.
 *
 * @param {string} crateDir absolute path to the crate root (containing `src/lib.rs`)
 * @returns {{ surface: Record<string,string>, warnings: string[], pubUseCount: number }}
 */
export function extractCrateSurface(crateDir) {
  const libPath = join(crateDir, 'src', 'lib.rs');
  if (!existsSync(libPath)) {
    throw new Error(`NO_LIB_RS: ${libPath} does not exist`);
  }
  const libText = readFileSync(libPath, 'utf8');
  const { masked: libMasked } = lex(libText);
  const localMods = localModuleNames(libMasked);
  const rootUses = collectRootUses(libMasked);
  const directItems = collectRootDirectItems(libMasked);

  if (rootUses.length === 0 && directItems.length === 0) {
    throw new Error(`EMPTY_SURFACE: no \`pub use\` or direct \`pub\` item found in ${libPath}`);
  }

  const srcDir = join(crateDir, 'src');
  const files = listRsFiles(srcDir).map((path) => ({
    path: relative(crateDir, path),
    masked: lex(readFileSync(path, 'utf8')).masked,
  }));
  const defs = collectDefinitions(files);

  const surface = {};
  const warnings = [];

  const resolve = (name) => {
    const found = defs.get(name);
    if (!found || found.length === 0) return null;
    if (found.length > 1) {
      warnings.push(`AMBIGUOUS: ${name} is defined in ${found.length} places (${found.map((f) => f.path).join(', ')})`);
      return 'ambiguous';
    }
    const def = found[0];
    return describeDefinition(files.find((f) => f.path === def.path).masked, def);
  };

  for (const { name, resolveName, firstSeg } of rootUses) {
    if (name in surface) continue; // duplicate re-export path — first wins
    const local = firstSeg && (localMods.has(firstSeg) || firstSeg === 'crate' || firstSeg === 'self');
    if (!local) {
      surface[name] = 'external re-export';
      continue;
    }
    const detail = resolve(resolveName);
    surface[name] = detail ?? 'unresolved (not a local struct/enum — fn/const/trait/type or unknown)';
  }
  for (const { name, kind } of directItems) {
    if (name in surface) continue;
    if (kind === 'struct' || kind === 'enum') {
      const detail = resolve(name);
      surface[name] = detail ?? `${kind} (unresolved)`;
    } else {
      surface[name] = kind;
    }
  }

  return { surface, warnings, pubUseCount: rootUses.length };
}

/** crate name ("ifc-lite-geometry") -> absolute crate directory, from each rust/<dir>/Cargo.toml's `name = "..."`. */
export function discoverCrateDirs(rustRoot, crateNames) {
  const wanted = new Set(crateNames);
  const found = new Map();
  for (const entry of readdirSync(rustRoot)) {
    const dir = join(rustRoot, entry);
    const cargoToml = join(dir, 'Cargo.toml');
    if (!existsSync(cargoToml)) continue;
    const text = readFileSync(cargoToml, 'utf8');
    const m = text.match(/^name\s*=\s*"([^"]+)"/m);
    if (m && wanted.has(m[1])) found.set(m[1], dir);
  }
  return found;
}

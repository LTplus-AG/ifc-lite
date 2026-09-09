/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Struct/enum SHAPE half of `./rust-public-api.mjs` (issue #4192), split out
 * so that file stays under the module-size ratchet's 400-line budget rather
 * than earning an allowlist row for a brand-new file. See that module's
 * docblock for the WHY and the overall design; this one is the part that,
 * given a masked Rust file and the byte offset of a `pub struct`/`pub enum`
 * declaration, renders its field or variant list — or "unparsed" the moment
 * an entry does not fit the expected shape, rather than a partial list.
 */

const OPEN = { '(': ')', '[': ']', '{': '}' };

/** Index of the delimiter matching the one at `open` (masked plane). */
export function matchDelim(masked, open) {
  const close = OPEN[masked[open]];
  if (!close) return -1;
  let depth = 0;
  for (let k = open; k < masked.length; k++) {
    if (masked[k] === masked[open]) depth++;
    else if (masked[k] === close) {
      depth--;
      if (depth === 0) return k;
    }
  }
  return -1;
}

/**
 * From `start`, find the character that opens a struct/enum BODY — the
 * first top-level `{`, `(`, or `;`.
 *
 * Only `<...>` (generics) is skipped UNCONDITIONALLY: a bare `(` at angle
 * depth 0 is the thing being searched for whenever it is a TUPLE STRUCT's
 * own field list (`struct Pair(f64, f64);`), so it must not be swallowed as
 * "nested". A `where`-bound can also carry a `(...)` before the body
 * (`struct Foo<F> where F: Fn() -> T { ... }`), which DOES have to be
 * skipped — the two are told apart by whether a `where` keyword has been
 * seen yet at this depth: before `where`, the first bare `(`/`{`/`;` IS the
 * body; after it, `(`/`[` nest until their close, same as generics.
 */
export function findBodyOpen(masked, start) {
  let angle = 0;
  let skip = 0; // paren/bracket nesting depth, only counted after `where`
  let seenWhere = false;
  for (let k = start; k < masked.length; k++) {
    const c = masked[k];
    if (c === '<') {
      angle++;
      continue;
    }
    if (c === '>') {
      angle = Math.max(0, angle - 1);
      continue;
    }
    if (angle > 0) continue;
    if (skip > 0) {
      if (c === '(' || c === '[') skip++;
      else if (c === ')' || c === ']') skip--;
      continue;
    }
    if (!seenWhere && /[A-Za-z_]/.test(c) && masked.slice(k, k + 5) === 'where' && !/[A-Za-z0-9_]/.test(masked[k + 5] ?? '')) {
      seenWhere = true;
      continue;
    }
    if (seenWhere && (c === '(' || c === '[')) {
      skip = 1;
      continue;
    }
    if (c === '{' || c === '(' || c === ';') return k;
  }
  return -1;
}

/** Split `text` on top-level commas, respecting `()[]{}<>` nesting. */
export function splitTopLevel(text) {
  const parts = [];
  let depth = 0;
  let last = 0;
  for (let k = 0; k < text.length; k++) {
    const c = text[k];
    if (c === '<' || c === '(' || c === '[' || c === '{') depth++;
    else if (c === '>' || c === ')' || c === ']' || c === '}') depth = Math.max(0, depth - 1);
    else if (c === ',' && depth === 0) {
      parts.push(text.slice(last, k));
      last = k + 1;
    }
  }
  parts.push(text.slice(last));
  return parts.map((p) => p.trim()).filter((p) => p.length > 0);
}

/** Strip leading `#[...]` attributes off one field/variant entry. */
function stripAttrs(entry) {
  let s = entry;
  for (;;) {
    const m = s.match(/^\s*#\s*\[[^\]]*\]\s*/);
    if (!m) break;
    s = s.slice(m[0].length);
  }
  return s.trim();
}

const FIELD_RE = /^(pub(?:\([^)]*\))?\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.+)$/s;

/**
 * Parse a `{ ... }` struct/enum-struct-variant body into `"name: Type"`
 * strings for PUBLIC fields only (`requirePub`). Returns `null` (rather than
 * a partial list) the moment one entry cannot be parsed.
 */
export function parseNamedFields(body, requirePub) {
  const out = [];
  for (const raw of splitTopLevel(body)) {
    const entry = stripAttrs(raw);
    if (entry.length === 0) continue;
    const m = entry.match(FIELD_RE);
    if (!m) return null;
    const isPub = m[1] !== undefined && m[1].trim() === 'pub';
    if (requirePub && !isPub) continue;
    out.push(`${m[2]}: ${m[3].replace(/\s+/g, ' ').trim()}`);
  }
  return out.sort();
}

/** Parse a `(...)` tuple body into `"Type"` strings, in order (position is part of the shape, so not sorted). */
export function parseTupleFields(body) {
  const out = [];
  for (const raw of splitTopLevel(body)) {
    const entry = stripAttrs(raw);
    if (entry.length === 0) continue;
    // A tuple field may itself carry `pub`/`pub(crate)`; strip it for the type text.
    out.push(entry.replace(/^pub(?:\([^)]*\))?\s+/, '').replace(/\s+/g, ' ').trim());
  }
  return out;
}

/** Does an attribute-run immediately above `declStart` (masked plane) carry `#[non_exhaustive]`? */
export function hasNonExhaustive(masked, declStart) {
  const before = masked.slice(0, declStart);
  const lines = before.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (line.length === 0) continue;
    if (/^#\s*\[[^\]]*\]$/.test(line)) {
      if (/non_exhaustive/.test(line)) return true;
      continue; // keep scanning further attributes stacked above
    }
    break; // first non-blank, non-attribute line — stop
  }
  return false;
}

/**
 * Find every `pub struct NAME` / `pub enum NAME` declaration across a set of
 * already-read `{ path, masked }` files. Returns `Map<name, detail[]>` so a
 * caller can detect ambiguity (more than one definition for the same name).
 */
export function collectDefinitions(files) {
  const defs = new Map();
  const declRe = /\bpub\s+(struct|enum)\s+([A-Za-z_][A-Za-z0-9_]*)/g;
  for (const { path, masked } of files) {
    let m;
    while ((m = declRe.exec(masked)) !== null) {
      const [full, kind, name] = m;
      const nameEnd = m.index + full.length;
      const bodyOpen = findBodyOpen(masked, nameEnd);
      if (bodyOpen === -1) continue; // malformed / truncated — skip rather than guess
      const nonExhaustive = hasNonExhaustive(masked, m.index);
      const list = defs.get(name) ?? [];
      list.push({ path, kind, nonExhaustive, bodyOpenChar: masked[bodyOpen], bodyOpen });
      defs.set(name, list);
    }
  }
  return defs;
}

/** Render one resolved struct/enum definition into its snapshot descriptor string. */
export function describeDefinition(masked, def) {
  const { kind, nonExhaustive, bodyOpenChar, bodyOpen } = def;
  if (nonExhaustive) return `${kind} (non_exhaustive)`;
  if (bodyOpenChar === ';') return `${kind} (unit)`;
  const close = matchDelim(masked, bodyOpen);
  if (close === -1) return `${kind} (unparsed)`;
  const body = masked.slice(bodyOpen + 1, close);
  if (kind === 'struct') {
    if (bodyOpenChar === '(') return `struct(${parseTupleFields(body).join(', ')})`;
    const fields = parseNamedFields(body, true);
    return fields === null ? 'struct (fields: unparsed)' : `struct { ${fields.join('; ')} }`;
  }
  return describeEnumBody(body);
}

function describeEnumBody(body) {
  const variants = [];
  for (const raw of splitTopLevel(body)) {
    const entry = stripAttrs(raw);
    if (entry.length === 0) continue;
    const nameMatch = entry.match(/^([A-Za-z_][A-Za-z0-9_]*)/);
    if (!nameMatch) return 'enum (variants: unparsed)';
    const vName = nameMatch[1];
    const rest = entry.slice(vName.length).trim();
    if (rest.length === 0) {
      variants.push(vName);
    } else if (rest.startsWith('(')) {
      variants.push(`${vName}(${parseTupleFields(rest.slice(1, rest.lastIndexOf(')'))).join(', ')})`);
    } else if (rest.startsWith('{')) {
      const fields = parseNamedFields(rest.slice(1, rest.lastIndexOf('}')), false);
      if (fields === null) return 'enum (variants: unparsed)';
      variants.push(`${vName} { ${fields.join('; ')} }`);
    } else {
      return 'enum (variants: unparsed)';
    }
  }
  return `enum { ${variants.sort().join('; ')} }`;
}

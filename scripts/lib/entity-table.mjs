/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { generatedNames } from './rust-schema-names.mjs';

export { generatedNames };

/**
 * Parse an IFC entity table emitted by the generator. The generated modules
 * hold the table as one encoded string literal (`const ENCODED_ENTITIES_* =
 * "..."`), decoded here by `decodeEncodedTable` below; a source with
 * object-literal rows (the generator's earlier form, still used by tests)
 * is matched row by row.
 *
 * Zero entities is an error, never an empty table: it means the generated
 * format changed under this parser (#9840: the tables became one encoded
 * string and every caller silently read nothing). `label` names the caller's
 * source in the error.
 */
export function parseEntityTable(tsSource, label = 'entity table') {
  const table = parseRows(tsSource);
  if (table.size === 0) {
    throw new Error(
      `${label}: no entities parsed (ZERO rows) — the generated table's format no longer matches ` +
        `scripts/lib/entity-table.mjs; fix the parser, the real count is never zero.`,
    );
  }
  return table;
}

function parseRows(tsSource) {
  const encoded = tsSource.match(/const ENCODED_[A-Z0-9_]+ = ("(?:[^"\\]|\\.)*");/);
  if (encoded) return toEntityMap(decodeEncodedTable(JSON.parse(encoded[1])));
  const out = new Map();
  const re =
    /\{ name: "([^"]+)", parent: (?:"([^"]+)"|undefined), abstract: (true|false), predefinedTypes: \[[^\]]*\], attributes: \[([^\]]*)\]/g;
  for (const m of tsSource.matchAll(re)) {
    out.set(m[1], {
      name: m[1],
      parent: m[2] ?? undefined,
      isAbstract: m[3] === 'true',
      attributes: m[4] ? m[4].split(',').map((s) => s.trim().replace(/^"|"$/g, '')) : [],
    });
  }
  return out;
}

function toEntityMap(rows) {
  const out = new Map();
  for (const row of rows) {
    out.set(row.name, {
      name: row.name,
      parent: row.parent ?? undefined,
      isAbstract: row.abstract === true,
      attributes: [...row.attributes],
    });
  }
  return out;
}

/**
 * `decodeSchemaTable` from `packages/data/src/ifc-schema/table-codec.ts`, in
 * plain JavaScript: the ledger generator runs without a TypeScript loader
 * (#8019), so it cannot import the `.ts` codec. `generate-coverage-ledger.test.mjs`
 * checks that both decoders give the same rows for every generated table.
 */
export function decodeEncodedTable(text) {
  const table = JSON.parse(text);
  const s = table.s;
  const shapes = table.k.map((keys) => keys.map((i) => s[i]));
  const decode = (x) => {
    if (typeof x === 'number') {
      if (x >= 0) return s[x];
      return x === -1 ? true : x === -2 ? false : x === -3 ? undefined : null;
    }
    const tag = x[0];
    if (tag === -1) return x[1];
    if (tag === 0) return x.slice(1).map(decode);
    const keys = shapes[tag - 1];
    const out = {};
    for (let i = 0; i < keys.length; i++) out[keys[i]] = decode(x[i + 1]);
    return out;
  };
  return decode(table.v);
}

/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { generatedNames } from './rust-schema-names.mjs';

export { generatedNames };

/** Parse the fixed-shape rows emitted by the IFC entity-table generator. */
export function parseEntityTable(tsSource) {
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

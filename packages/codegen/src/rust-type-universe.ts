/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { ExpressSchema } from './express-parser.js';

/**
 * Keep the newest schema authoritative for shared names, then append entities
 * removed from it but present in another supported schema. This extends the
 * stable Rust discriminant universe without pretending one release's
 * positional attributes are valid for another release.
 */
export function mergeTypeUniverse(
  canonical: ExpressSchema,
  supplemental: readonly ExpressSchema[]
): ExpressSchema {
  const entities = [...canonical.entities];
  const names = new Set(entities.map((entity) => entity.name.toUpperCase()));
  for (const schema of supplemental) {
    for (const entity of schema.entities) {
      if (!names.has(entity.name.toUpperCase())) {
        entities.push(entity);
        names.add(entity.name.toUpperCase());
      }
    }
  }
  return {
    ...canonical,
    name: [canonical, ...supplemental].map((item) => item.name).join(' + '),
    entities,
  };
}

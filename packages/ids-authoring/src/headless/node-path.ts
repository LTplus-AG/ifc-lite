/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { locateNode } from '../document/node-index.js';
import type { StudioDocument } from '../document/types.js';
import type { Uuid } from '../uuid.js';

/**
 * A path a person can find in the XML, for node `id`:
 * `specifications[2].requirements[1].baseName`. Headless output prints
 * this next to (or instead of) the node UUID, which means nothing outside
 * the Studio. `undefined` for an id the document does not hold.
 */
export function nodePath(doc: StudioDocument, id: Uuid): string | undefined {
  const loc = locateNode(doc, id);
  if (!loc) return undefined;
  if (loc.kind === 'document') return 'info';
  const spec = `specifications[${loc.specIndex}]`;
  if (loc.kind === 'spec') return spec;
  const facet = loc.section === 'applicability' ? `${spec}.applicability[${loc.facetIndex}]` : `${spec}.requirements[${loc.facetIndex}]`;
  // Field names carry the facet type (`property.baseName`); the path already has it.
  return loc.kind === 'constraint' ? `${facet}.${loc.field.slice(loc.field.indexOf('.') + 1)}` : facet;
}

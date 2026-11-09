/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { CopyContext } from './copy-product.js';
import type { SourceAttributes } from './duplicate.js';
import { resolveDuplicateSource } from './resolve-source.js';

/** Edited sets travel through cloneEffectiveMetadata after the product graph.
 * Do not also replay their saved definitions, including aggregate members (#9296). */
export function resolveCopySource(ctx: CopyContext, sourceId: number): SourceAttributes {
  const source = resolveDuplicateSource(ctx.store, sourceId, ctx.editor);
  const view = ctx.editor.getMutationView();
  if (!view.hasChanges(sourceId)) return source;
  const properties = new Set<string>(), quantities = new Set<string>();
  for (const change of view.getEffectiveChanges()) {
    if (change.entityId !== sourceId || change.setName === undefined) continue;
    if (change.kind === 'property') properties.add(change.setName);
    if (change.kind === 'quantity') quantities.add(change.setName);
  }
  if (!properties.size && !quantities.size) return source;
  return { ...source, associations: source.associations?.flatMap(association => {
    if (association.relType.toUpperCase() !== 'IFCRELDEFINESBYPROPERTIES') return [association];
    const ids = (association.relatingExpressIds ?? [association.relatingExpressId]).filter(id => {
      const definition = ctx.read(id), name = definition?.attributes[2];
      return typeof name !== 'string' || !(definition?.type.toUpperCase() === 'IFCELEMENTQUANTITY'
        ? quantities : properties).has(name);
    });
    return ids.length ? [{ ...association, relatingExpressId: ids[0], relatingExpressIds: ids.length > 1 ? ids : undefined }] : [];
  }) };
}

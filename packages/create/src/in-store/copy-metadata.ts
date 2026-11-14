/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { CopyContext } from './copy-product.js';
import type { SourceAttributes } from './duplicate.js';
import { resolveDuplicateSource } from './resolve-source.js';

/** Keep distinct definitions, including same-named ones. A separate copied
 * relationship per definition lets export replace only the edited definition. */
export function resolveCopySource(ctx: CopyContext, sourceId: number): SourceAttributes {
  const source = resolveDuplicateSource(ctx.store, sourceId, ctx.editor, ctx.sourceScope);
  return { ...source, associations: source.associations?.flatMap(association => {
    if (association.relType.toUpperCase() !== 'IFCRELDEFINESBYPROPERTIES') return [association];
    return (association.relatingExpressIds ?? [association.relatingExpressId]).map(id => ({
      ...association, relatingExpressId: id, relatingExpressIds: undefined,
    }));
  }) };
}

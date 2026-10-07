/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useEffect, useState } from 'react';
import type { ProjectedCRS } from '@ifc-lite/parser';
import { resolveProjection } from './reproject';
import { isGeographicProj4 } from './proj4-utils';

export type ProjectionKind = 'projected' | 'geographic' | 'unresolved';

/** Null means pending; absent or refused metadata is explicitly unresolved.
 * The primitive key invalidates previous results during render. */
export function useProjectionKind(crs: ProjectedCRS | undefined): ProjectionKind | null {
  const key = crs ? JSON.stringify(crs) : null;
  const [resolved, setResolved] = useState<{ key: string; kind: ProjectionKind } | null>(null);
  useEffect(() => {
    if (!key) return;
    let cancelled = false;
    const source: ProjectedCRS = JSON.parse(key);
    resolveProjection(source).then(definition => {
      if (!cancelled) setResolved({ key, kind: definition
        ? isGeographicProj4(definition) ? 'geographic' : 'projected'
        : 'unresolved' });
    }).catch(error => {
      console.warn('[georeference] projection classification failed', error);
      if (!cancelled) setResolved({ key, kind: 'unresolved' });
    });
    return () => { cancelled = true; };
  }, [key]);
  if (!key) return 'unresolved';
  return resolved?.key === key ? resolved.kind : null;
}

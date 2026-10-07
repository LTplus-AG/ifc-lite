/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useEffect, useState } from 'react';
import type { ProjectedCRS } from '@ifc-lite/parser';
import { resolveProjection } from './reproject';
import { isGeographicProj4 } from './proj4-utils';

export type ProjectionKind = 'projected' | 'geographic';

/** Pending, absent and unresolved metadata fail closed. The primitive key also
 * invalidates a previous result during render, before the effect runs. */
export function useProjectionKind(crs: ProjectedCRS | undefined): ProjectionKind | null {
  const key = crs ? JSON.stringify(crs) : null;
  const [resolved, setResolved] = useState<{ key: string; kind: ProjectionKind | null } | null>(null);
  useEffect(() => {
    if (!key) return;
    let cancelled = false;
    const source: ProjectedCRS = JSON.parse(key);
    resolveProjection(source).then(definition => {
      if (!cancelled) setResolved({ key, kind: definition
        ? isGeographicProj4(definition) ? 'geographic' : 'projected'
        : null });
    }).catch(error => {
      console.warn('[georeference] projection classification failed', error);
      if (!cancelled) setResolved({ key, kind: null });
    });
    return () => { cancelled = true; };
  }, [key]);
  return resolved?.key === key ? resolved.kind : null;
}

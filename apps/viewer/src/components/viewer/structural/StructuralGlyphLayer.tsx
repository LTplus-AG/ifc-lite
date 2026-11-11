/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Gate for the structural glyph overlay (#9668). Mounted in the viewport's
 * scene-overlay root; loads `StructuralGlyphOverlay` (and the parser's glyph
 * builder with it) only while the toggle is on and a loaded model has a
 * structural connection or action. A model without structural data costs one
 * pass over its type-index keys.
 */

import { lazy, Suspense, useMemo } from 'react';
import type { IfcDataStore } from '@ifc-lite/parser';
import { useViewerStore } from '@/store';

const StructuralGlyphOverlay = lazy(() => import('./StructuralGlyphOverlay'));

/** `IFCSTRUCTURALPOINTCONNECTION`, `IFCSTRUCTURALLINEARACTION`, ...: what can draw a support or a load. */
const GLYPH_TYPE = /^IFCSTRUCTURAL\w*(CONNECTION|ACTION)\w*$/;

function hasGlyphTypes(store: IfcDataStore | null | undefined): boolean {
  // @raw-entity-enumeration-ok presence test over source type keys; the overlay reads the effective records
  for (const key of store?.entityIndex.byType.keys() ?? []) if (GLYPH_TYPE.test(key)) return true;
  return false;
}

export function StructuralGlyphLayer() {
  const enabled = useViewerStore((s) => s.typeVisibility.structuralGlyphs);
  const models = useViewerStore((s) => s.models);
  const legacyStore = useViewerStore((s) => s.ifcDataStore);
  const present = useMemo(
    () => enabled && ([...models.values()].some((m) => hasGlyphTypes(m.ifcDataStore)) || (models.size === 0 && hasGlyphTypes(legacyStore))),
    [enabled, models, legacyStore],
  );
  if (!present) return null;
  return (
    <Suspense fallback={null}>
      <StructuralGlyphOverlay />
    </Suspense>
  );
}

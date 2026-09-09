/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { useEffect, type RefObject } from 'react';
import type { Renderer } from '@ifc-lite/renderer';
import { useViewerStore } from '@/store';
import { toast } from '@/components/ui/toast';
import { connectAppearanceReferences } from '@/lib/appearance/reference-runtime/connect.js';

/** Reference lifetime belongs to the viewport, including when its editing dock
 * is closed. The bridge owns no IFC IDs and performs no model ingestion. */
export function useAppearanceReferences(rendererRef: RefObject<Renderer | null>, initialized: boolean): void {
  useEffect(() => {
    const renderer = rendererRef.current;
    if (!initialized || !renderer) return;
    return connectAppearanceReferences(renderer, useViewerStore, diagnostic => {
      if (diagnostic.status === 'error') toast.error(diagnostic.message ?? 'Could not display the drawing reference.');
    });
  }, [rendererRef, initialized]);
}

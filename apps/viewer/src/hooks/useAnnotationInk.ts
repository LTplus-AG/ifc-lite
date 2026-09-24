/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useEffect, useMemo, type RefObject } from 'react';
import type { Renderer } from '@ifc-lite/renderer';
import type { ThemeMode } from '@/store/slices/uiSlice';
import type { AnnotationText3D } from '@/hooks/symbolic-rich-channels';
import { annotationLineInk, legibleAnnotationTextColor } from '@/lib/annotation-ink';

/** Recolour IfcAnnotation / grid labels for the theme. See `lib/annotation-ink`. */
export function inkAnnotationTexts(texts: readonly AnnotationText3D[], theme: ThemeMode): AnnotationText3D[] {
  return texts.map((t) => ({ ...t, color: legibleAnnotationTextColor(t.color, theme) }));
}

/**
 * Keep the overlay line colour and the IfcAnnotation label upload in step with
 * the theme (#5388). Owns the label upload so the colour and the text can never
 * be uploaded under two different themes.
 */
export function useAnnotationInk(
  rendererRef: RefObject<Renderer | null>,
  isInitialized: boolean,
  theme: ThemeMode,
  annotationTexts3D: readonly AnnotationText3D[],
): void {
  useEffect(() => {
    const renderer = rendererRef.current;
    if (!renderer || !isInitialized) return;
    renderer.setOverlayLineColor(annotationLineInk(theme));
    renderer.requestRender();
  }, [theme, isInitialized, rendererRef]);

  const inked = useMemo(() => inkAnnotationTexts(annotationTexts3D, theme), [annotationTexts3D, theme]);
  useEffect(() => {
    const renderer = rendererRef.current;
    if (!renderer || !isInitialized) return;
    renderer.uploadAnnotationTexts3D(inked);
  }, [inked, isInitialized, rendererRef]);
}

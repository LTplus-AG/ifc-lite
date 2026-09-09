/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { DrawingLine2D } from '@ifc-lite/renderer';
import type { ParseResult, AnnotationsForStorey, AnnotationText2D, AnnotationFill2D } from '@/lib/overlay-parse/symbolic-shapes';
import { toRenderTranslation, type Translation } from './translation';

/** Translate a cached symbolic parse without changing the shared source cache.
 * All three consumers (3D lines, 3D text/fills, 2D drawings) read this same view. */
export function placedSymbols(source: ParseResult | undefined, translation: Translation, fallbackY: number): ParseResult | undefined {
  if (!source || translation.every((value) => value === 0)) return source;
  const [dx, dy, dz] = toRenderTranslation(translation);
  const line = (item: DrawingLine2D): DrawingLine2D => ({ ...item, line: {
    start: { x: item.line.start.x + dx, y: item.line.start.y + dz },
    end: { x: item.line.end.x + dx, y: item.line.end.y + dz },
  } });
  const text = (item: AnnotationText2D): AnnotationText2D => ({ ...item, x: item.x + dx, y: item.y + dz });
  const fill = (item: AnnotationFill2D): AnnotationFill2D => ({ ...item,
    points: item.points.map((value, index) => value + (index % 2 === 0 ? dx : dz)) });
  const bucket = (item: AnnotationsForStorey): AnnotationsForStorey => ({ ...item,
    storeyElevation: (item.storeyElevation ?? fallbackY) + dy,
    lines: item.lines.map(line), texts: item.texts.map(text), fills: item.fills.map(fill) });
  const buckets = (input: Map<number, AnnotationsForStorey>, lines: DrawingLine2D[], texts: AnnotationText2D[], fills: AnnotationFill2D[]) => {
    const result = new Map([...input].map(([id, value]) => [id, bucket(value)]));
    // Give loose geometry an explicit elevation so its translated fallback is
    // used by clipping as well as rendering. The key is internal to this view.
    if (lines.length || texts.length || fills.length) {
      let key = -1; while (result.has(key)) key--;
      result.set(key, bucket({ storeyId: key, storeyElevation: fallbackY, lines, texts, fills }));
    }
    return result;
  };
  return { byStorey: buckets(source.byStorey, source.loose, source.looseTexts, source.looseFills),
    gridByStorey: buckets(source.gridByStorey, source.gridLoose, source.gridLooseTexts, source.gridLooseFills),
    loose: [], looseTexts: [], looseFills: [], gridLoose: [], gridLooseTexts: [], gridLooseFills: [] };
}

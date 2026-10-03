/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { localIsoDate } from '@/lib/document/bindings';
import { useEffect, useState } from 'react';
import { resolveBlocks, type DocumentPdfInput } from '@/lib/document/generate-document-pdf';
import { composeResolvedDocument, documentTextMeasure, pageBandImageAspects } from '@/lib/document/document-layout';
import type { ComposeDocumentInput, DocumentLayout } from '@/lib/document/compose';

export interface PreviewImageSize { w: number; h: number }
interface PreviewLayout { layout: DocumentLayout; measure: ComposeDocumentInput['measure'] }
interface PreparedLayout extends PreviewLayout { input: DocumentPdfInput; imageSizes: ReadonlyMap<string, PreviewImageSize> }
interface LayoutError { input: DocumentPdfInput; imageSizes: ReadonlyMap<string, PreviewImageSize>; message: string }
let metrics: Promise<ComposeDocumentInput['measure']> | undefined;

function standardFontMetrics(): Promise<ComposeDocumentInput['measure']> {
  metrics ??= import('jspdf').then(({ jsPDF }) => {
    // This document only supplies the same standard-font metrics as export.
    // Preview never captures the viewport or creates a downloadable PDF.
    const doc = new jsPDF({ unit: 'pt', format: 'a4' });
    return documentTextMeasure({
      setFont: (family, style) => { doc.setFont(family, style); },
      setFontSize: size => { doc.setFontSize(size); },
      textWidth: text => doc.getTextWidth(text),
    });
  });
  return metrics;
}

/** Reuses resolution and composition; no browser-flow pagination heuristic. */
export function useDocumentLayout(input: DocumentPdfInput, imageSizes: ReadonlyMap<string, PreviewImageSize>) {
  const [value, setValue] = useState<PreparedLayout | null>(null);
  const [error, setError] = useState<LayoutError | null>(null);
  useEffect(() => {
    let current = true;
    setError(null);
    const prepare = async () => {
      const measure = await standardFontMetrics();
      const imageSize = async (dataUrl: string) => imageSizes.get(dataUrl) ?? { w: 1, h: 1 };
      const logoAspects = await pageBandImageAspects(input.document, imageSize);
      const blocks = await resolveBlocks(input,
        imageSize,
        { unresolved: [], missingTopics: [], tableFailures: [] });
      if (!current) return;
      const layout = composeResolvedDocument(input.document, blocks, input.bindings.today.toLocaleString(), measure, input.labels, logoAspects, localIsoDate(input.bindings.today));
      setValue({ layout, measure, input, imageSizes });
    };
    void prepare().catch(cause => {
      if (!current) return;
      console.error('[Documents] preview layout failed', cause);
      setError({ input, imageSizes, message: cause instanceof Error ? cause.message : String(cause) });
    });
    return () => { current = false; };
  }, [input, imageSizes]);
  // Retain the complete captured source with its geometry while this same
  // document reflows. Another document must never inherit those old pages.
  const prepared = value?.input.document.id === input.document.id ? value : null;
  const pending = prepared?.input !== input || prepared.imageSizes !== imageSizes;
  return { value: prepared, pending,
    error: error?.input === input && error.imageSizes === imageSizes ? error.message : null };
}

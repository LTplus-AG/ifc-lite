/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { useEffect, useRef, useState } from 'react';
import { useViewerStore } from '@/store';
import { appearanceAssets } from '@/lib/appearance/model-assets.js';
import type { AppearanceSourceOption } from '@/lib/appearance/draft-types.js';
import { PdfAppearanceSource } from '@/lib/appearance/pdf/source-document.js';
import { getPdfDocument, registerPdfDocument, removePdfDocument } from '@/lib/appearance/pdf/documents.js';
import { publishPdfRaster } from '@/lib/appearance/pdf/publish-source.js';
import { PdfAppearanceError, type PdfRasterRequest } from '@/lib/appearance/pdf/types.js';
import type { AppearancePdfControls, AppearancePdfPasswordPrompt } from './pdf-controls.js';

type Preview = { documentKey: string; pageNumber: number; rotation: number; url: string };
export function usePdfAppearanceSource(source: AppearanceSourceOption | undefined,
  onSelect: (id: string) => void, onError: (error: unknown) => void) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [passwordFile, setPasswordFile] = useState<{ file: File; incorrect: boolean }>();
  const [preview, setPreview] = useState<Preview>();
  const [job, setJob] = useState<{ documentKey: string; request: PdfRasterRequest }>();
  const pending = useRef<AbortController | undefined>(undefined);
  const previewRef = useRef<Preview | undefined>(undefined);
  const mounted = useRef(true);
  const callbacks = useRef({ onSelect, onError });
  callbacks.current = { onSelect, onError };
  function abortPending() { pending.current?.abort(); }
  function cancel() {
    abortPending();
    pending.current = undefined;
    setJob(undefined);
    setPasswordFile(undefined);
    setBusy(false);
  }
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; abortPending(); if (previewRef.current) URL.revokeObjectURL(previewRef.current.url); previewRef.current = undefined; };
  }, []);

  async function raster(documentKey: string, request: PdfRasterRequest, signal: AbortSignal) {
    const document = getPdfDocument(documentKey);
    if (!document) throw new Error('The original PDF is unavailable. Import the document again.');
    const previous = previewRef.current;
    let provisionalUrl: string | undefined;
    try {
      if (!previous || previous.documentKey !== documentKey || previous.pageNumber !== request.pageNumber || previous.rotation !== (request.rotation ?? 0)) {
        const full = await document.rasterize({ pageNumber: request.pageNumber, rotation: request.rotation,
          dpi: 72, maxDimension: 1024, maxPixels: 1024 * 1024 }, { signal });
        try {
          provisionalUrl = URL.createObjectURL(new Blob([appearanceAssets.encoded(full.asset.id)], { type: full.asset.mimeType }));
        } finally { document.releaseRaster(full.asset.id); }
      }
      const result = await document.rasterize(request, { signal });
      if (signal.aborted || !mounted.current) { document.releaseRaster(result.asset.id); return; }
      publishPdfRaster(documentKey, result);
      if (provisionalUrl) {
        const next = { documentKey, pageNumber: request.pageNumber, rotation: request.rotation ?? 0, url: provisionalUrl };
        previewRef.current = next; setPreview(next); provisionalUrl = undefined;
        if (previous) URL.revokeObjectURL(previous.url);
      }
      callbacks.current.onSelect(documentKey);
    } finally { if (provisionalUrl) URL.revokeObjectURL(provisionalUrl); }
  }

  async function upload(file: File, password?: string) {
    cancel();
    const controller = new AbortController(); pending.current = controller;
    setBusy(true); setError(undefined);
    let documentKey: string | undefined;
    try {
      const document = await PdfAppearanceSource.open(file, appearanceAssets, { signal: controller.signal, password });
      documentKey = registerPdfDocument(document);
      await raster(documentKey, { pageNumber: 1, dpi: 144 }, controller.signal);
      if (!controller.signal.aborted && mounted.current) setPasswordFile(undefined);
    } catch (failure) {
      if (!controller.signal.aborted && mounted.current) {
        if (failure instanceof PdfAppearanceError && (failure.code === 'password-required' || failure.code === 'password-incorrect')) {
          setPasswordFile({ file, incorrect: failure.code === 'password-incorrect' });
        } else { setError(failure instanceof Error ? failure.message : String(failure)); callbacks.current.onError(failure); }
      }
    } finally {
      if (documentKey && !useViewerStore.getState().appearanceSources.some(item => item.id === documentKey)) removePdfDocument(documentKey);
      if (pending.current === controller && mounted.current) setBusy(false);
    }
  }

  useEffect(() => {
    if (!job) return;
    abortPending();
    const controller = new AbortController(); pending.current = controller;
    setBusy(true); setError(undefined);
    const timer = setTimeout(() => { void raster(job.documentKey, job.request, controller.signal).catch(failure => {
      if (!controller.signal.aborted && mounted.current) {
        setError(failure instanceof Error ? failure.message : String(failure)); callbacks.current.onError(failure);
      }
    }).finally(() => { if (pending.current === controller && mounted.current) setBusy(false); }); }, 200);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [job]);

  const pdf = source?.pdf;
  // Rebuild only the session-owned full-page preview when reopening the dock.
  useEffect(() => {
    cancel();
    if (!pdf || previewRef.current?.documentKey === pdf.documentKey) return;
    setJob({ documentKey: pdf.documentKey, request: { pageNumber: pdf.recipe.page.pageNumber,
      rotation: pdf.recipe.rotation, cropPoints: pdf.recipe.cropPoints, dpi: pdf.recipe.requestedDpi } });
  }, [source?.id, pdf?.documentKey]);

  let controls: AppearancePdfControls | undefined;
  if (pdf) {
    const document = getPdfDocument(pdf.documentKey);
    if (document) {
      const recipe = pdf.recipe;
      const request: PdfRasterRequest = { pageNumber: recipe.page.pageNumber, rotation: recipe.rotation,
        cropPoints: recipe.cropPoints, dpi: recipe.requestedDpi };
      const effective = job?.documentKey === pdf.documentKey ? job.request : request;
      const change = (patch: Partial<PdfRasterRequest>) => {
        abortPending(); setBusy(true);
        setJob(previous => ({ documentKey: pdf.documentKey,
          request: { ...(previous?.documentKey === pdf.documentKey ? previous.request : request), ...patch } }));
      };
      const rotation = effective.rotation ?? 0;
      const pageResolved = effective.pageNumber === recipe.page.pageNumber && rotation === recipe.rotation;
      controls = { documentId: pdf.documentKey, documentName: document.name, pageCount: document.pageCount,
        pageNumber: effective.pageNumber, rotation,
        pageSizePoints: !pageResolved ? [0, 0] : [recipe.page.widthPoints, recipe.page.heightPoints],
        cropPoints: effective.cropPoints ?? recipe.cropPoints, requestedDpi: effective.dpi ?? recipe.requestedDpi, effectiveDpi: busy ? undefined : recipe.effectiveDpi,
        pagePreviewUrl: pageResolved && preview?.documentKey === pdf.documentKey ? preview.url : undefined, busy, error,
        onPageChange: pageNumber => change({ pageNumber, cropPoints: undefined }),
        onRotationChange: rotation => change({ rotation, cropPoints: undefined }),
        onCropChange: cropPoints => change({ cropPoints }), onDpiChange: dpi => change({ dpi }),
      };
    }
  }
  const passwordPrompt: AppearancePdfPasswordPrompt | undefined = passwordFile ? {
    documentName: passwordFile.file.name, incorrect: passwordFile.incorrect, busy,
    onSubmit: password => { void upload(passwordFile.file, password); },
    onCancel: cancel,
  } : undefined;
  return { upload, controls, passwordPrompt, busy, cancel };
}

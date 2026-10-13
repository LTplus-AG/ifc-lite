/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useEffect, type MutableRefObject } from 'react';
import type { Renderer, SymbolicFillInput, SymbolicTextInput } from '@ifc-lite/renderer';
import { rendererLineVertexData, type RendererLineVertices } from '@/lib/renderer/line-overlay-rte';
import { uploadGuarded } from './gpu-owned-upload.js';

type UploadTarget = Pick<Renderer, 'setLineOverlay' | 'uploadAnnotationFills3D' | 'uploadAnnotationTexts3D'>;
type RendererRef = MutableRefObject<UploadTarget | null>;

function useLineUpload(
  rendererRef: RendererRef, initialized: boolean, epoch: number,
  channel: 'annotation' | 'alignment' | 'grid', vertices: RendererLineVertices,
  visible = true, countRef?: MutableRefObject<number>,
): void {
  useEffect(() => {
    const renderer = rendererRef.current;
    if (!renderer || !initialized) return;
    const count = visible ? rendererLineVertexData(vertices).length / 3 : 0;
    const uploaded = uploadGuarded(`setLineOverlay:${channel}`,
      () => renderer.setLineOverlay(channel, count === 0 ? null : vertices),
      () => renderer.setLineOverlay(channel, null));
    if (countRef) countRef.current = uploaded ? count : 0;
  }, [rendererRef, initialized, epoch, channel, vertices, visible, countRef]);
}

/** CPU inputs stay owned by their source hooks; an epoch retries identical data after device recovery. */
export function useViewportSymbolicUploads(params: {
  rendererRef: RendererRef;
  isInitialized: boolean;
  gpuRecoveryEpoch: number;
  annotation: RendererLineVertices;
  alignment: RendererLineVertices;
  grid: RendererLineVertices;
  gridVisible: boolean;
  annotationCountRef: MutableRefObject<number>;
  fills: readonly SymbolicFillInput[];
  texts: readonly SymbolicTextInput[];
}): void {
  const { rendererRef, isInitialized, gpuRecoveryEpoch, annotation, alignment, grid,
    gridVisible, annotationCountRef, fills, texts } = params;
  useLineUpload(rendererRef, isInitialized, gpuRecoveryEpoch, 'annotation', annotation, true, annotationCountRef);
  useLineUpload(rendererRef, isInitialized, gpuRecoveryEpoch, 'alignment', alignment);
  useLineUpload(rendererRef, isInitialized, gpuRecoveryEpoch, 'grid', grid, gridVisible);
  useEffect(() => {
    const renderer = rendererRef.current;
    if (!renderer || !isInitialized) return;
    uploadGuarded('uploadAnnotationFills3D', () => renderer.uploadAnnotationFills3D(fills),
      () => renderer.uploadAnnotationFills3D([]));
  }, [rendererRef, isInitialized, gpuRecoveryEpoch, fills]);
  useEffect(() => {
    const renderer = rendererRef.current;
    if (!renderer || !isInitialized) return;
    uploadGuarded('uploadAnnotationTexts3D', () => renderer.uploadAnnotationTexts3D(texts),
      () => renderer.uploadAnnotationTexts3D([]));
  }, [rendererRef, isInitialized, gpuRecoveryEpoch, texts]);
}

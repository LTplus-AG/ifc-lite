/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { JSONSchemaType } from 'ajv';
import { ToolErrorCode, ToolExecutionError } from '@ifc-lite/mcp/browser';
import { useViewerStore } from '@/store';
import { getGlobalRenderer } from '@/hooks/useBCF';
import { modelExportFilename, activeModelName, dataUrlToBytes } from '@/lib/export/download';
import { readViewPdfSource, readViewZoom, readCameraSnapshot } from '@/lib/export/view-pdf/view-pdf-export-source';
import { deriveDisplayedScaleFactor, describePage } from '@/lib/export/view-pdf/view-pdf-scale';
import { estimateViewPdfLayout, VIEW_PDF_MARGIN_MM } from '@/lib/export/view-pdf/view-pdf-page-estimate';
import { collectViewMeshes } from '@/lib/export/view-pdf/collect-view-meshes';
import { resolveKeptHalfSpace } from '@/lib/export/view-pdf/view-section-plane';
import { produceNativeViewPdf } from '@/lib/export/native-view-pdf';
import { viewerOperation } from './contract';
import { exportMetadata } from './exports-common';
import { nativeExportGuard, nativeArtifact } from './export-native-runtime';
import { captureNativeViewport } from './native-viewport-frame';
export const exportNativeViewOperations = [
  viewerOperation<{ scope: 'current-view' }>(exportMetadata('exports.screenshot', 'Await the native viewport-frame capture and return real PNG bytes for the current rendered federation. Requires the live native renderer; this is a current-view snapshot with the same effects as the toolbar screenshot action.'), {
    type: 'object', properties: { scope: { type: 'string', const: 'current-view' } }, required: ['scope'], additionalProperties: false,
  } satisfies JSONSchemaType<{ scope: 'current-view' }>, async (_, c) => {
    const s = useViewerStore.getState(); const check = nativeExportGuard(c, [...s.models.keys()]); check();
    const image = await captureNativeViewport(canvas => canvas.toDataURL('image/png'), c.signal); check(); if (!image?.startsWith('data:image/png;base64,')) throw new Error('Native viewport did not produce a PNG.');
    const bytes = dataUrlToBytes(image); if (!bytes) throw new Error('Native viewport did not produce a PNG.');
    return nativeArtifact(c, new Blob([bytes], { type: 'image/png' }), modelExportFilename(activeModelName(s), 'png', '_screenshot'), { scope: 'current-view' }, check);
  }),
  viewerOperation<{ scope: 'current-view'; scale_mode: 'displayed' | 'numerical'; scale: number; include_hidden_lines: boolean; render_mode: 'shaded' | 'lines'; include_scale_stamp: boolean }>(exportMetadata('exports.viewPdf', 'Await the toolbar to-scale current-view PDF producer with explicit displayed/numerical scale, shaded/line mode, hidden edges and scale stamp. Preserves current view visibility, all section cuts, native camera orientation and PDF page-size refusal; return actual PDF bytes plus native page/stroke/raster diagnostics.'), {
    type: 'object', properties: { scope: { type: 'string', const: 'current-view' }, scale_mode: { type: 'string', enum: ['displayed', 'numerical'] }, scale: { type: 'integer', minimum: 1, maximum: 1000000 }, include_hidden_lines: { type: 'boolean' }, render_mode: { type: 'string', enum: ['shaded', 'lines'] }, include_scale_stamp: { type: 'boolean' } }, required: ['scope', 'scale_mode', 'scale', 'include_hidden_lines', 'render_mode', 'include_scale_stamp'], additionalProperties: false,
  } satisfies JSONSchemaType<{ scope: 'current-view'; scale_mode: 'displayed' | 'numerical'; scale: number; include_hidden_lines: boolean; render_mode: 'shaded' | 'lines'; include_scale_stamp: boolean }>, async (i, c) => {
    const s = useViewerStore.getState(); const guard = nativeExportGuard(c, [...s.models.keys()]); guard(); const source = readViewPdfSource(s); const camera = source.camera;
    if (!camera) throw new Error('Native viewport camera is unavailable.'); const pose = JSON.stringify(camera); const renderer = getGlobalRenderer();
    const check = () => { guard(); if (renderer !== getGlobalRenderer() || JSON.stringify(readCameraSnapshot()) !== pose) throw new Error('Native camera changed during view PDF production.'); };
    const zoom = readViewZoom();
    const scale = i.scale_mode === 'displayed' ? source.canvasCssHeightPx && zoom ? deriveDisplayedScaleFactor({ ...zoom, projectionMode: camera.projectionMode, canvasCssHeightPx: source.canvasCssHeightPx }) : null : i.scale;
    if (scale === null) throw new Error('The native viewport cannot report its displayed scale. Choose a numerical scale.');
    const meshes = collectViewMeshes(source.view);
    const layout = estimateViewPdfLayout(meshes, camera, scale, { includeScaleStamp: i.include_scale_stamp, keptHalfSpace: source.section ? resolveKeptHalfSpace(source.section) : null, extraKeptHalfSpaces: source.extraSections.map(resolveKeptHalfSpace) });
    if (!layout) throw new ToolExecutionError({
      code: ToolErrorCode.UNSUPPORTED_OPERATION,
      message: 'The current view has no drawable geometry for PDF export.',
      details: { reason: 'unavailable' },
    });
    if (describePage(layout.page).oversize) {
      if (i.scale_mode === 'numerical') throw new ToolExecutionError({
        code: ToolErrorCode.INVALID_INPUT,
        message: 'The requested PDF scale exceeds the printable page size. Choose a larger scale denominator.',
        details: { reason: 'limit' },
      });
      throw new ToolExecutionError({
        code: ToolErrorCode.UNSUPPORTED_OPERATION,
        message: 'The displayed scale exceeds the printable page size. Zoom out or choose a numerical scale.',
        details: { reason: 'unavailable' },
      });
    }
    const result = await produceNativeViewPdf({ view: source.view, camera, section: source.section, extraSections: source.extraSections, scaleFactor: scale, marginMm: VIEW_PDF_MARGIN_MM, includeHiddenLines: i.include_hidden_lines, renderMode: i.render_mode, includeScaleStamp: i.include_scale_stamp,
      onProgress: (phase, progress) => c.progress?.({ phase, done: progress, total: 1 }) }, check);
    return nativeArtifact(c, result.blob, result.result.filename, result.result, check);
  }),
];

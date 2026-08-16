/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Export the current 3D view as a to-scale vector PDF (#2042).
 *
 * DEFECT CLASS this dialog exists to prevent: a sheet an engineer measures and
 * gets a wrong number from. Three ways that happens, and each has a control
 * here rather than a silent default:
 *
 *  1. **A scale nobody chose.** The default is what the viewport is showing
 *     right now, stated as a number ("about 1:87") instead of implied, with six
 *     drafting presets and a custom field beside it. The chosen factor reaches
 *     the page unrounded, and the filename carries it verbatim: a 1:99.5 export
 *     must never be filed as "1-100" (#2119).
 *  2. **A page a PDF cannot express.** The page is sized to the drawing, never
 *     fitted, so a large model at a large scale asks for metres of paper; past
 *     5080 mm a writer clamps and mis-scales the very thing the export exists
 *     to get right. The readout shows the size before anything is generated and
 *     the warning DISABLES export rather than advising against it.
 *  3. **A perspective image printed as if it had one scale.** It does not. The
 *     export is always a parallel projection along the current view direction;
 *     the dialog says so in plain words and offers the one-click camera switch
 *     instead of silently changing the user's view.
 *
 * The appearance controls live in `PdfViewAppearanceSection`; the default is
 * SHADED, because a sheet that measures correctly and looks nothing like the
 * view it claims to be is its own defect.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { FileText, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { useViewerStore } from '@/store';
import { posthog } from '@/lib/analytics';
import { toast } from '@/components/ui/toast';
import { formatScaleFactorLabel } from '@ifc-lite/drawing-2d';
import { collectViewMeshes } from '@/lib/export/view-pdf/collect-view-meshes';
import { readViewPdfSource, readViewZoom } from '@/lib/export/view-pdf/view-pdf-export-source';
import {
  estimateViewPdfLayout,
  VIEW_PDF_MARGIN_MM,
} from '@/lib/export/view-pdf/view-pdf-page-estimate';
import {
  deriveDisplayedScaleFactor,
  describePage,
} from '@/lib/export/view-pdf/view-pdf-scale';
import { PdfViewAppearanceSection } from './PdfViewAppearanceSection';
import { PdfViewPageNotices } from './PdfViewPageNotices';
import type {
  ViewPdfExportInput,
  ViewPdfExportResult,
  ViewPdfRenderMode,
} from '@/lib/export/view-pdf/generate-view-pdf';

/**
 * The one call this dialog makes into the export pipeline. Production leaves it
 * undefined and gets the code-split `generateViewPdf`; the test passes a
 * recorder, which is the only way to prove that a control the user moved
 * actually reaches the exporter. That is not hypothetical here: the hidden-edges
 * switch once shipped frozen at its mount-time default because a `useCallback`
 * dependency array missed it, and the PDF came out byte-identical whatever the
 * user did. There is no exhaustive-deps lint in this repo to catch the next one.
 */
export type ViewPdfExporter = (input: ViewPdfExportInput) => Promise<ViewPdfExportResult>;

interface PdfViewExportDialogProps {
  trigger?: React.ReactNode;
  /** Test seam for the exporter. See {@link ViewPdfExporter}. */
  exportViewPdf?: ViewPdfExporter;
}

/** The drafting scales offered as presets, coarsest detail last. */
const SCALE_PRESETS = [10, 20, 50, 100, 200, 500] as const;

/**
 * Generator stage ids to words a user recognises. An unmapped stage falls
 * through to a plain "Working", never to a raw internal identifier.
 */
const PHASE_LABEL: Record<string, string> = {
  cutting: 'Cutting',
  polygons: 'Building outlines',
  edges: 'Finding edges',
  hidden: 'Removing hidden lines',
  merging: 'Merging lines',
  complete: 'Writing PDF',
  shading: 'Shading surfaces',
  encoding: 'Encoding image',
};

/** Round a millimetre figure for display without inventing precision. */
function formatMm(value: number): string {
  const rounded = Math.round(value * 10) / 10;
  return Number.isInteger(rounded) ? rounded.toFixed(0) : rounded.toFixed(1);
}

export function PdfViewExportDialog({ trigger, exportViewPdf }: PdfViewExportDialogProps) {
  // Subscribed purely so the readout recomputes when the view changes; the
  // values themselves are read back off `getState()` inside the memo, which
  // keeps this component from restating the shape of half the store.
  const models = useViewerStore((s) => s.models);
  const geometryResult = useViewerStore((s) => s.geometryResult);
  const hiddenEntities = useViewerStore((s) => s.hiddenEntities);
  const isolatedEntities = useViewerStore((s) => s.isolatedEntities);
  const typeVisibility = useViewerStore((s) => s.typeVisibility);
  const sectionPlane = useViewerStore((s) => s.sectionPlane);
  const selectedStoreys = useViewerStore((s) => s.selectedStoreys);
  const classFilter = useViewerStore((s) => s.classFilter);
  const projectionMode = useViewerStore((s) => s.projectionMode);
  const setProjectionMode = useViewerStore((s) => s.setProjectionMode);

  const [open, setOpen] = useState(false);
  const [scaleChoice, setScaleChoice] = useState<string>('displayed');
  const [customScale, setCustomScale] = useState('100');
  const [showHiddenEdges, setShowHiddenEdges] = useState(true);
  // Shaded by default: the export exists to reproduce the viewport, and the
  // viewport is solid and coloured.
  const [renderMode, setRenderMode] = useState<ViewPdfRenderMode>('shaded');
  const [isExporting, setIsExporting] = useState(false);
  const [phase, setPhase] = useState<string | null>(null);

  const source = useMemo(
    () => (open ? readViewPdfSource(useViewerStore.getState()) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- these are invalidation triggers; the values are read from getState() above.
    [open, models, geometryResult, hiddenEntities, isolatedEntities, typeVisibility,
      sectionPlane, selectedStoreys, classFilter, projectionMode],
  );

  const camera = source?.camera ?? null;
  const drawnMeshes = useMemo(() => (source ? collectViewMeshes(source.view) : []), [source]);

  // The camera zoom is not store state, so it is sampled at the same moments
  // the source bundle is: opening the dialog, and any store change that could
  // move the view (notably the projection switch below).
  const zoom = useMemo(
    () => (open ? readViewZoom() : null),
    [open, projectionMode],
  );

  const displayedScale = useMemo(() => {
    if (!camera || !zoom || source?.canvasCssHeightPx == null) return null;
    return deriveDisplayedScaleFactor({
      projectionMode: camera.projectionMode,
      orthoSize: zoom.orthoSize,
      distance: zoom.distance,
      fovRadians: zoom.fovRadians,
      canvasCssHeightPx: source.canvasCssHeightPx,
    });
  }, [camera, zoom, source]);

  // Drafting scales are whole numbers (1:50, not 1:49.7), so a custom entry is
  // rounded to an integer and the rounded value is what actually gets drawn.
  // Rounding here is safe precisely because it happens BEFORE the factor reaches
  // the layout and the filename: the sheet is drawn at the rounded scale, so the
  // filename still names the scale the sheet was really drawn at. (Rounding at
  // the filename instead is the #2119 defect - a 1:99.5 sheet filed as "1-100".)
  const customScaleValue = Math.round(Number.parseFloat(customScale));
  const customScaleValid = Number.isFinite(customScaleValue) && customScaleValue > 0;

  const scaleFactor: number | null = useMemo(() => {
    // No fallback. When the viewport cannot report its scale the label already
    // reads "not available", and substituting a silent 1:100 would hand the
    // user a measured sheet at a scale they never chose - the one failure this
    // whole feature exists to prevent. `null` disables Export instead, so they
    // pick a preset or a custom scale.
    if (scaleChoice === 'displayed') return displayedScale;
    if (scaleChoice === 'custom') return customScaleValid ? customScaleValue : null;
    const preset = Number(scaleChoice);
    return Number.isFinite(preset) && preset > 0 ? preset : null;
  }, [scaleChoice, displayedScale, customScaleValid, customScaleValue]);

  const preview = useMemo(() => {
    if (!camera || drawnMeshes.length === 0 || scaleFactor === null) return null;
    try {
      const layout = estimateViewPdfLayout(drawnMeshes, camera, scaleFactor);
      if (!layout) return null;
      return { page: layout.page, ...describePage(layout.page) };
    } catch (err) {
      // A readout must never take the dialog down; the export itself reports
      // the same failure through toast.error.
      console.debug('[pdf-view] page estimate failed:', err);
      return null;
    }
  }, [camera, drawnMeshes, scaleFactor]);

  // Reset the transient bits every time the dialog opens so a previous run's
  // progress text cannot be read as this run's.
  useEffect(() => {
    if (open) setPhase(null);
  }, [open]);

  const oversize = preview?.oversize ?? false;
  const canExport =
    !isExporting && camera !== null && drawnMeshes.length > 0 && scaleFactor !== null && !oversize;

  const handleExport = useCallback(async () => {
    if (!source || !camera || scaleFactor === null) return;
    setIsExporting(true);
    setPhase('Preparing');
    try {
      // Loaded on demand: the orchestrator pulls in the whole 2D drawing
      // pipeline (cutter, edge extractor, hidden-line raster) plus jsPDF behind
      // it, none of which belongs in the toolbar's eager chunk. A failed chunk
      // load lands in the catch below, not on the console as an unhandled
      // rejection.
      const runExport = exportViewPdf ?? (async (pdfInput: ViewPdfExportInput) => {
        const { generateViewPdf } = await import('@/lib/export/view-pdf/generate-view-pdf');
        return generateViewPdf(pdfInput);
      });
      const result = await runExport({
        view: source.view,
        camera,
        section: source.section,
        scaleFactor,
        marginMm: VIEW_PDF_MARGIN_MM,
        includeHiddenLines: showHiddenEdges,
        renderMode,
        onProgress: (stage) => setPhase(PHASE_LABEL[stage] ?? 'Working'),
      });
      const message =
        `Exported 1:${formatScaleFactorLabel(scaleFactor)} PDF, ` +
        `page ${formatMm(result.page.widthMm)} x ${formatMm(result.page.heightMm)} mm`;
      toast.success(message);
      posthog.capture('export_completed', {
        format: 'pdf-3d-view',
        scale_factor: scaleFactor,
        projection_mode: camera.projectionMode,
        section_enabled: source.section !== null,
        // What the SHEET got, not what was asked for: shaded mode forces hidden
        // edges off, and a capped raster prints below the requested dpi.
        hidden_edges: renderMode === 'shaded' ? false : showHiddenEdges,
        render_mode: renderMode,
        shading_dpi: result.shading?.dpi ?? null,
      });
      setOpen(false);
    } catch (err) {
      console.error('PDF view export failed:', err);
      toast.error(
        err instanceof Error ? `PDF export failed: ${err.message}` : 'PDF export failed.',
      );
    } finally {
      setIsExporting(false);
      setPhase(null);
    }
    // EVERY control the body reads belongs here - `showHiddenEdges` and
    // `renderMode` both. Omitting one does not merely stale the value, it
    // FREEZES it at the mount-time default, so the control moves in the UI and
    // the exported sheet never changes. There is no exhaustive-deps lint in
    // this repo to catch that, and no orchestrator test can see it: the option
    // is honoured correctly one layer down. `PdfViewExportDialog.test.tsx`
    // drives the real dialog through the `exportViewPdf` seam for exactly this.
  }, [source, camera, scaleFactor, showHiddenEdges, renderMode, exportViewPdf]);

  const displayedLabel = displayedScale
    ? `As displayed (about 1:${formatScaleFactorLabel(displayedScale)})`
    : 'As displayed (not available)';

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        {trigger || (
          <Button variant="outline" size="sm">
            <FileText className="h-4 w-4 mr-2" />
            Export PDF
          </Button>
        )}
      </DialogTrigger>
      <DialogContent className="sm:max-w-md overflow-hidden">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <FileText className="h-5 w-5" />
            Export PDF (to-scale 3D view)
          </DialogTitle>
          <DialogDescription>
            Saves what you see in the 3D viewport at an exact scale. Shaded surfaces are
            embedded as an image placed at exact size; all line work stays vector, so
            measurements taken off the print are correct.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4 py-4">
          <div className="flex items-center gap-4">
            <Label className="w-24" htmlFor="pdf-view-scale">
              Scale
            </Label>
            <Select value={scaleChoice} onValueChange={setScaleChoice}>
              <SelectTrigger id="pdf-view-scale">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="displayed">{displayedLabel}</SelectItem>
                {SCALE_PRESETS.map((preset) => (
                  <SelectItem key={preset} value={String(preset)}>
                    {`1:${preset}`}
                  </SelectItem>
                ))}
                <SelectItem value="custom">Custom</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {scaleChoice === 'custom' && (
            <div className="flex items-center gap-4">
              <Label className="w-24" htmlFor="pdf-view-custom-scale">
                1 :
              </Label>
              <div className="flex flex-1 flex-col gap-1">
                <Input
                  id="pdf-view-custom-scale"
                  type="number"
                  min="1"
                  step="1"
                  value={customScale}
                  onChange={(e) => setCustomScale(e.target.value)}
                  onBlur={() => {
                    // Show the value that will actually be drawn, so the sheet
                    // never differs from what the field says.
                    if (customScaleValid) setCustomScale(String(customScaleValue));
                  }}
                  aria-invalid={!customScaleValid}
                  aria-describedby={customScaleValid ? undefined : 'pdf-view-custom-scale-error'}
                />
                {!customScaleValid && (
                  <p id="pdf-view-custom-scale-error" className="text-xs text-destructive">
                    Enter a whole number greater than zero, for example 75.
                  </p>
                )}
              </div>
            </div>
          )}

          <PdfViewPageNotices
            preview={preview}
            oversize={oversize}
            projectionMode={camera?.projectionMode ?? null}
            onSwitchToOrthographic={() => setProjectionMode('orthographic')}
            formatMm={formatMm}
          />

          <PdfViewAppearanceSection
            renderMode={renderMode}
            onRenderModeChange={setRenderMode}
            showHiddenEdges={showHiddenEdges}
            onShowHiddenEdgesChange={setShowHiddenEdges}
            drawingWidthMm={preview ? preview.page.widthMm - VIEW_PDF_MARGIN_MM * 2 : null}
            drawingHeightMm={preview ? preview.page.heightMm - VIEW_PDF_MARGIN_MM * 2 : null}
          />

          {source?.sectionEnabled && (
            <p className="text-xs text-muted-foreground">
              The active section cut is applied. Cut edges print with a heavy line weight.
            </p>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button onClick={() => { void handleExport(); }} disabled={!canExport}>
            {isExporting ? (
              <>
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                {phase ? `${phase}...` : 'Exporting...'}
              </>
            ) : (
              <>
                <FileText className="h-4 w-4 mr-2" />
                Export
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

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
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertCircle, FileText, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
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
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
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
  MAX_PDF_PAGE_DIMENSION_MM,
  deriveDisplayedScaleFactor,
  describePage,
} from '@/lib/export/view-pdf/view-pdf-scale';

interface PdfViewExportDialogProps {
  trigger?: React.ReactNode;
}

/** The drafting scales offered as presets, coarsest detail last. */
const SCALE_PRESETS = [10, 20, 50, 100, 200, 500] as const;

/** Used when the viewport cannot report a scale (degenerate camera or canvas). */
const FALLBACK_SCALE_FACTOR = 100;

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
};

/** Round a millimetre figure for display without inventing precision. */
function formatMm(value: number): string {
  const rounded = Math.round(value * 10) / 10;
  return Number.isInteger(rounded) ? rounded.toFixed(0) : rounded.toFixed(1);
}

export function PdfViewExportDialog({ trigger }: PdfViewExportDialogProps) {
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
    if (scaleChoice === 'displayed') return displayedScale ?? FALLBACK_SCALE_FACTOR;
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
      const { generateViewPdf } = await import('@/lib/export/view-pdf/generate-view-pdf');
      const result = await generateViewPdf({
        view: source.view,
        camera,
        section: source.section,
        scaleFactor,
        marginMm: VIEW_PDF_MARGIN_MM,
        includeHiddenLines: showHiddenEdges,
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
        hidden_edges: showHiddenEdges,
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
  }, [source, camera, scaleFactor]);

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
            Saves what you see in the 3D viewport as a vector PDF at an exact scale, so
            measurements taken off the print are correct. Line work only in this version: no
            fills, materials, textures or point clouds.
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
                />
                {!customScaleValid && (
                  <p className="text-xs text-destructive">
                    Enter a whole number greater than zero, for example 75.
                  </p>
                )}
              </div>
            </div>
          )}

          <p className="text-xs text-muted-foreground" data-testid="pdf-view-page-readout">
            {preview
              ? `Estimated page: ${formatMm(preview.page.widthMm)} x ${formatMm(preview.page.heightMm)} mm` +
                (preview.paper ? ` (fits ${preview.paper.name})` : ' (larger than any ISO sheet)') +
                '. The exported page is sized to the drawing itself and will never be larger.'
              : 'Page size is not available yet. Load a model and choose a valid scale.'}
          </p>

          {oversize && preview && (
            <Alert variant="destructive">
              <AlertCircle className="h-4 w-4" />
              <AlertTitle>Page too large to print</AlertTitle>
              <AlertDescription>
                {`This scale needs a page of ${formatMm(preview.page.widthMm)} x ` +
                  `${formatMm(preview.page.heightMm)} mm. A PDF page cannot exceed ` +
                  `${MAX_PDF_PAGE_DIMENSION_MM} mm on a side. Choose a smaller scale.`}
              </AlertDescription>
            </Alert>
          )}

          {camera?.projectionMode === 'perspective' ? (
            <Alert>
              <AlertCircle className="h-4 w-4" />
              <AlertTitle>Perspective camera</AlertTitle>
              <AlertDescription>
                <span>
                  The PDF is an orthographic (parallel) projection along your current view
                  direction, so near and far objects print at the same scale. That is the only
                  way a printed drawing can carry a single scale. Switch to orthographic to
                  preview exactly what will print.
                </span>
                <Button
                  variant="outline"
                  size="sm"
                  className="mt-2"
                  onClick={() => setProjectionMode('orthographic')}
                >
                  Switch camera to orthographic
                </Button>
              </AlertDescription>
            </Alert>
          ) : (
            <p className="text-xs text-muted-foreground">
              Orthographic camera. The PDF matches your viewport exactly.
            </p>
          )}

          <div className="flex items-center justify-between gap-4">
            <Label className="text-sm font-normal" htmlFor="pdf-view-hidden-edges">
              Show hidden edges as dashed lines
            </Label>
            <Switch
              id="pdf-view-hidden-edges"
              checked={showHiddenEdges}
              onCheckedChange={setShowHiddenEdges}
            />
          </div>
          <p className="text-xs text-muted-foreground">
            {showHiddenEdges
              ? 'Edges behind other geometry print as dashed lines.'
              : 'Only edges you can actually see are printed.'}
          </p>

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

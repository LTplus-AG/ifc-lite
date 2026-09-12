/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * "Export report…" for the Charts panel (#3944): the active dashboard printed
 * to PDF — page size and orientation, the title-block fields (seeded from the
 * 2D sheet's title block when one exists), and optional 3D snapshots of each
 * chart's largest bucket. The page setup and fields are remembered on the
 * dashboard as a `ReportSpec`, so the next export of the same dashboard is
 * one click.
 */
import { useCallback, useMemo, useState } from 'react';
import { FileText, Loader2 } from 'lucide-react';
import type { Aggregation, DashboardSpec, ReportPageSetup, ReportSpec } from '@ifc-lite/charts';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { toast } from '@/components/ui/toast';
import { posthog } from '@/lib/analytics';
import { useViewerStore } from '@/store';
import { downloadBlob, sanitizeFilename } from '@/lib/export/download';
import { browserReportSeams, generateReportPdf, type ReportPdfSeams } from '@/lib/export/report/generate-report-pdf';
import { createSnapshotCapture } from '@/lib/export/report/snapshots';
import { largestBucketIds } from '@/lib/charts/buckets';

/** Title-block fields offered, in order; values seeded from the drawing sheet's title block when present. */
const FIELDS: Array<[string, string]> = [['project', 'Project'], ['title', 'Report title'], ['author', 'Prepared by'], ['date', 'Date'], ['revision', 'Revision']];

export interface ReportExportDialogProps {
  dashboard: DashboardSpec | null;
  aggregations: ReadonlyMap<string, Aggregation | null>;
  onSaveReportSetup: (report: ReportSpec) => void;
  /** Injectable seams for tests; the app uses jsPDF + the live renderer. */
  seams?: () => Promise<ReportPdfSeams>;
}

function isReport(d: DashboardSpec | null): d is ReportSpec {
  return d !== null && 'page' in d && (d as ReportSpec).page !== undefined;
}

export function ReportExportDialog({ dashboard, aggregations, onSaveReportSetup, seams }: ReportExportDialogProps) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const sheetFields = useViewerStore((s) => s.activeSheet?.titleBlock.fields);
  const projectName = useViewerStore((s) => {
    const model = s.models.get(s.activeModelId ?? '') ?? s.models.values().next().value;
    const store = model?.ifcDataStore;
    const project = store?.spatialHierarchy?.project;
    return project ? (store?.entities.getName(project.expressId) ?? '') : '';
  });
  // Field defaults: the sheet's title block, else the model's IfcProject name;
  // the report title is the dashboard's name; a saved report setup wins where
  // it has a value. Re-seeded every time the dialog opens, so a dashboard
  // switched or a model loaded after the panel mounted is reflected.
  const seeded = useMemo<Record<string, string>>(() => {
    const fromSheet: Record<string, string> = {};
    for (const f of sheetFields ?? []) {
      if (f.id === 'project-name') fromSheet.project = f.value;
      if (f.id === 'drawn-by') fromSheet.author = f.value;
      if (f.id === 'revision') fromSheet.revision = f.value;
    }
    const saved = isReport(dashboard) ? Object.fromEntries(Object.entries(dashboard.titleBlock).filter(([, v]) => v.trim().length > 0)) : {};
    return { date: new Date().toISOString().slice(0, 10), project: projectName, title: dashboard?.name ?? '', ...fromSheet, ...saved };
  }, [sheetFields, dashboard, projectName]);
  const [page, setPage] = useState<ReportPageSetup>(isReport(dashboard) ? dashboard.page : { size: 'A4', orientation: 'portrait' });
  const [snapshots, setSnapshots] = useState(isReport(dashboard) ? dashboard.snapshots : true);
  const [fields, setFields] = useState<Record<string, string>>(seeded);
  const openDialog = useCallback(() => {
    setFields(seeded);
    if (isReport(dashboard)) {
      setPage(dashboard.page);
      setSnapshots(dashboard.snapshots);
    }
    setOpen(true);
  }, [seeded, dashboard]);

  const run = useCallback(async () => {
    if (!dashboard) return;
    setBusy(true);
    const snapshot = seams ? null : createSnapshotCapture();
    try {
      const s = await (seams ? seams() : browserReportSeams(snapshots ? snapshot?.capture ?? null : null));
      const result = await generateReportPdf({
        name: dashboard.name,
        page,
        titleBlock: Object.fromEntries(FIELDS.map(([k, label]) => [label, fields[k] ?? ''])),
        snapshots,
        charts: dashboard.charts.map((c) => ({ id: c.id, title: c.title, aggregation: aggregations.get(c.id) ?? null })),
        snapshotIds: (chartId) => largestBucketIds(aggregations.get(chartId)),
      }, s);
      downloadBlob(result.blob, `${sanitizeFilename(dashboard.name, { fallback: 'report' })}-report.pdf`);
      onSaveReportSetup({ ...dashboard, page, titleBlock: Object.fromEntries(FIELDS.map(([k]) => [k, fields[k] ?? ''])), snapshots });
      // Counts only — never the dashboard name or a chart title.
      posthog.capture('export_completed', { format: 'pdf', surface: 'charts_report', chart_count: result.charts, page_count: result.pages, snapshot_count: result.snapshots });
      toast.success(`Report exported: ${result.pages} page${result.pages === 1 ? '' : 's'}, ${result.charts} chart${result.charts === 1 ? '' : 's'}${result.snapshotFailures.length > 0 ? ` (${result.snapshotFailures.length} snapshot${result.snapshotFailures.length === 1 ? '' : 's'} unavailable)` : ''}`);
      setOpen(false);
    } catch (err) {
      console.error('[Charts] report export failed', err);
      toast.error(err instanceof Error ? `Report export failed: ${err.message}` : 'Report export failed');
    } finally {
      snapshot?.restore();
      setBusy(false);
    }
  }, [dashboard, aggregations, page, snapshots, fields, seams, onSaveReportSetup]);

  const field = 'min-w-0 rounded border border-border bg-transparent px-1.5 py-0.5 text-xs';

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? openDialog() : setOpen(false))}>
      <DialogTrigger asChild>
        <Button variant="ghost" size="sm" className="h-6 px-2 text-xs" disabled={!dashboard || dashboard.charts.length === 0} title="Print this dashboard to a PDF report">
          <FileText className="h-3.5 w-3.5 mr-1" />
          Report
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md text-xs" data-report-dialog>
        <DialogHeader>
          <DialogTitle>Export report</DialogTitle>
          <DialogDescription>Every chart of the dashboard as a vector chart with its bucket table{snapshots ? ' and a 3D snapshot of its largest bucket' : ''}.</DialogDescription>
        </DialogHeader>
        <div className="grid grid-cols-2 gap-2">
          <label className="flex flex-col gap-0.5"><span className="text-muted-foreground">Page</span>
            <select className={field} value={page.size} onChange={(e) => setPage({ ...page, size: e.target.value as ReportPageSetup['size'] })} aria-label="Page size">
              <option value="A4">A4</option><option value="A3">A3</option>
            </select>
          </label>
          <label className="flex flex-col gap-0.5"><span className="text-muted-foreground">Orientation</span>
            <select className={field} value={page.orientation} onChange={(e) => setPage({ ...page, orientation: e.target.value as ReportPageSetup['orientation'] })} aria-label="Orientation">
              <option value="portrait">Portrait</option><option value="landscape">Landscape</option>
            </select>
          </label>
          {FIELDS.map(([key, label]) => (
            <label key={key} className="flex flex-col gap-0.5"><span className="text-muted-foreground">{label}</span>
              <input className={field} value={fields[key] ?? ''} onChange={(e) => setFields({ ...fields, [key]: e.target.value })} aria-label={label} />
            </label>
          ))}
          <label className="col-span-2 inline-flex items-center gap-1 cursor-pointer">
            <input type="checkbox" checked={snapshots} onChange={(e) => setSnapshots(e.target.checked)} />
            Include a 3D snapshot of each chart&apos;s largest bucket
          </label>
        </div>
        <DialogFooter>
          <Button size="sm" className="h-7 px-3 text-xs" disabled={busy || !dashboard} onClick={() => void run()} data-report-export>
            {busy ? <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" /> : <FileText className="h-3.5 w-3.5 mr-1" />}
            Export PDF
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

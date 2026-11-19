/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { useViewerStore } from '@/store';
import { viewerOperation, emptySchema } from './contract';
import { assertToolActive } from '../cancellation';
import type { ToolHost } from '../types';
import type { SavedClashReport } from '@/lib/clash/saved-report-schema';
import { evictOldest } from './host-handles';
const outputSchema = {
  type: 'object',
  properties: { native_json: { type: 'string' } },
  required: ['native_json'],
  additionalProperties: false,
};
const out = (value: unknown) => ({ native_json: JSON.stringify(value ?? null) });
const meta = (id: string, description: string, write = false) => ({
  id,
  owner: 'clash',
  description,
  effects: write ? (['configuration'] as const) : (['read'] as const),
  capability: write ? ('commands-and-edits' as const) : ('read' as const),
  implementation: 'native-store' as const,
  outputSchema,
});
interface DeleteCandidate {
  report: SavedClashReport;
  signature: string;
  action: ReturnType<typeof useViewerStore.getState>['deleteSavedClashReport'];
}
const hosts = new WeakMap<ToolHost, Map<string, DeleteCandidate>>();
function owned(host: ToolHost) {
  let map = hosts.get(host);
  if (!map) {
    map = new Map();
    hosts.set(host, map);
  }
  return map;
}
/** Every live and durable dependency, refusing a preview that could not read them all: a reference it
 * cannot see would be broken by the deletion. */
async function dependencies(id: string) {
  const [{ loadDocuments }, { reportChartDependencies, dependenciesUnreadable }] = await Promise.all([
    import('@/lib/document/persistence'),
    import('@/lib/reports/chart-dependencies'),
  ]);
  await useViewerStore.getState().initializeDocuments();
  const entries = await loadDocuments();
  const preview = reportChartDependencies(useViewerStore.getState(), { kind: 'clash', id }, { entries, phase: 'ready' });
  if (preview.documentPhase === 'loading' || dependenciesUnreadable(preview))
    throw new Error('Dashboards or Documents could not all be read, so the report’s dependencies are unknown. Retry once storage is available.');
  return preview;
}
export const clashReportOperations = [
  viewerOperation(
    meta(
      'clash.reports.read',
      'Inspect durable native clash reports, immutable evidence and persistence diagnostics. Saved results never install historical runtime IDs into the current scene.',
    ),
    emptySchema,
    async (_, c) => {
      await useViewerStore.getState().initializeSavedClashReports();
      assertToolActive(c);
      const s = useViewerStore.getState();
      return out({
        reports: s.savedClashReports,
        storage: s.savedClashReportsStorage,
        expected_reports: JSON.stringify(s.savedClashReports),
      });
    },
  ),
  viewerOperation<{ name: string; run_seq: number }>(
    meta(
      'clash.reports.save',
      'Capture native current report evidence, review annotations, model identities, stale limits and frozen quality thresholds into the durable saved-report library.',
      true,
    ),
    {
      type: 'object',
      properties: { name: { type: 'string', minLength: 1, maxLength: 200 }, run_seq: { type: 'integer', minimum: 0 } },
      required: ['name', 'run_seq'],
      additionalProperties: false,
    },
    async (i, c) => {
      const [{ snapshotClashReport }, { useQualityGatePreferences }] = await Promise.all([
        import('@/lib/clash/saved-report'),
        import('@/lib/clash/quality-gate-preferences'),
      ]);
      assertToolActive(c);
      const s = useViewerStore.getState();
      if (s.clashRunSeq !== i.run_seq) throw new Error('Clash run changed.');
      const report = snapshotClashReport(s, i.name, new Date(), useQualityGatePreferences.getState().config);
      if (!report) throw new Error('No native clash result to save.');
      if (!(await c.commitAsync(() => useViewerStore.getState().saveClashReport(report))))
        throw new Error('Native report save failed.');
      return out({ id: report.id });
    },
  ),
  viewerOperation<{
    action: 'rename' | 'import' | 'restore' | 'retry';
    id: string;
    name: string;
    report_json: string;
    expected_reports: string;
  }>(
    meta(
      'clash.reports.write',
      'Rename/import/restore/retry native saved reports through authoritative codecs and immutable-evidence collision checks. Does not reconstruct a live run from historical model IDs.',
      true,
    ),
    {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['rename', 'import', 'restore', 'retry'] },
        id: { type: 'string', maxLength: 200 },
        name: { type: 'string', maxLength: 200 },
        report_json: { type: 'string', maxLength: 10000000 },
        expected_reports: { type: 'string', maxLength: 10000000 },
      },
      required: ['action', 'id', 'name', 'report_json', 'expected_reports'],
      additionalProperties: false,
    },
    async (i, c) => {
      const { isSavedClashReport } = await import('@/lib/clash/saved-report-schema');
      let report: SavedClashReport | undefined;
      if (i.action === 'import') {
        const raw: unknown = JSON.parse(i.report_json);
        if (!isSavedClashReport(raw)) throw new Error('Invalid canonical native clash report.');
        report = raw;
      }
      assertToolActive(c);
      const ok = await c.commitAsync(() => {
        const s = useViewerStore.getState();
        if (JSON.stringify(s.savedClashReports) !== i.expected_reports) throw new Error('Saved reports changed.');
        if (i.action === 'restore') return s.restoreSavedClashReports();
        if (i.action === 'retry') return s.retrySaveClashReports();
        if (i.action === 'import') return s.saveClashReport(report!);
        if (!s.savedClashReports.some((row) => row.id === i.id)) throw new Error('Unknown saved clash report.');
        return s.renameSavedClashReport(i.id, i.name);
      });
      if (!ok) throw new Error('Native report write refused.');
      return out({ completed: i.action });
    },
  ),
  viewerOperation<{ id: string }>(
    meta(
      'clash.reports.delete.prepare',
      'Read exact native saved-report deletion dependencies across live/durable dashboards and Documents. Returns an immutable host-owned candidate; load failures refuse the preview.',
    ),
    {
      type: 'object',
      properties: { id: { type: 'string', minLength: 1, maxLength: 200 } },
      required: ['id'],
      additionalProperties: false,
    },
    async (i, c) => {
      const preview = await dependencies(i.id);
      assertToolActive(c);
      const s = useViewerStore.getState(),
        report = s.savedClashReports.find((row) => row.id === i.id);
      if (!report) throw new Error('Unknown saved report.');
      evictOldest(owned(c.host), 32);
      const token = crypto.randomUUID();
      owned(c.host).set(token, { report, signature: preview.signature, action: s.deleteSavedClashReport });
      return out({ token, preview });
    },
  ),
  viewerOperation<{ token: string }>(
    meta(
      'clash.reports.delete.apply',
      'Delete the exact reviewed native report using its guarded content writer. Rechecks live and durable dependency signature immediately before native persistence; report replacement or changed dependencies refuse rather than bypass the preview.',
      true,
    ),
    {
      type: 'object',
      properties: { token: { type: 'string', minLength: 1, maxLength: 100 } },
      required: ['token'],
      additionalProperties: false,
    },
    async (i, c) => {
      const candidate = owned(c.host).get(i.token);
      if (!candidate) throw new Error('Unknown deletion candidate.');
      const preview = await dependencies(candidate.report.id);
      assertToolActive(c);
      const s = useViewerStore.getState();
      if (
        s.savedClashReports.find((row) => row.id === candidate.report.id) !== candidate.report ||
        s.deleteSavedClashReport !== candidate.action ||
        preview.signature !== candidate.signature
      )
        throw new Error('Deletion target or dependencies changed. Preview again.');
      let staged = false;
      // The library also runs this on a later storage retry, after this call has ended or lost its grant.
      // Refusing then (not throwing) lets the library restore the report instead of leaving it hidden.
      const guard = async () => {
        let latest: Awaited<ReturnType<typeof dependencies>>;
        try {
          latest = await dependencies(candidate.report.id);
          assertToolActive(c);
        } catch (error) {
          console.warn('[Clash reports] Deletion guard refused:', error);
          return false;
        }
        const now = useViewerStore.getState();
        if (
          now.deleteSavedClashReport !== candidate.action ||
          latest.signature !== candidate.signature ||
          (staged
            ? now.savedClashReports.some((row) => row.id === candidate.report.id)
            : now.savedClashReports.find((row) => row.id === candidate.report.id) !== candidate.report)
        )
          return false;
        staged = true;
        return true;
      };
      if (!(await c.commitAsync(() => candidate.action(candidate.report.id, guard))))
        throw new Error('Native report deletion failed or its guard refused.');
      owned(c.host).delete(i.token);
      return out({ deleted: candidate.report.id });
    },
  ),
  viewerOperation<{ id: string }>(
    meta(
      'clash.reports.document',
      'Create the native frozen quality-gate Document from an exact saved clash report through the same native builder and durable Document writer. Requires the browser Canvas2D ring renderer used by the UI.',
      true,
    ),
    {
      type: 'object',
      properties: { id: { type: 'string', minLength: 1, maxLength: 200 } },
      required: ['id'],
      additionalProperties: false,
    },
    async (i, c) => {
      const [{ qualityGateDocument }, { captureTranslation }] = await Promise.all([
        import('@/lib/document/clash-quality-report'),
        import('@/i18n/registry'),
      ]);
      const s = useViewerStore.getState(),
        report = s.savedClashReports.find((row) => row.id === i.id);
      if (!report) throw new Error('Unknown saved clash report.');
      const document = qualityGateDocument(report, captureTranslation());
      assertToolActive(c);
      if (!(await c.commitAsync(() => useViewerStore.getState().upsertDocument(document))))
        throw new Error('Native Document write failed.');
      return out({ document_id: document.id });
    },
  ),
];

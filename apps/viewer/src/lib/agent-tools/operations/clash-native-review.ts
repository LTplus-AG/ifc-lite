/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { useViewerStore } from '@/store';
import { viewerOperation, emptySchema } from './contract';
import { assertToolActive } from '../cancellation';
import { currentClashes } from './clash-native';
import { pageInput, type PageInput } from './result-limit';
import { libraryPage } from './library-page';
import { revisionInput } from './state-revision';
import { groupLibraryRevision } from './clash-group-revision';
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
export const clashReviewOperations = [
  viewerOperation<{ action: 'select' | 'retry' | 'restore'; workspace_id: string; expected_library: string }>(
    meta(
      'clash.groups.library',
      'Select an exact native manual-group workspace or retry/restore its native durable library. Preserves the native default empty workspace and storage refusal semantics.',
      true,
    ),
    {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['select', 'retry', 'restore'] },
        workspace_id: { type: 'string', maxLength: 200 },
        expected_library: revisionInput,
      },
      required: ['action', 'workspace_id', 'expected_library'],
      additionalProperties: false,
    },
    async (i, c) => {
      const { useClashGroupLibrary, clashGroupLibrary, DEFAULT_GROUP_WORKSPACE } = await import(
        '@/lib/clash/group-workspace'
      );
      assertToolActive(c);
      const guard = () => {
        if (groupLibraryRevision(useClashGroupLibrary.getState()) !== i.expected_library) throw new Error('Group library changed.');
      };
      if (i.action === 'select')
        return out(
          c.commit(() => {
            guard();
            const s = useClashGroupLibrary.getState();
            if (
              s.status.phase !== 'ready' ||
              (i.workspace_id !== DEFAULT_GROUP_WORKSPACE && !s.entries.some((row) => row.id === i.workspace_id))
            )
              throw new Error('Native group workspace unavailable.');
            useClashGroupLibrary.setState({ activeId: i.workspace_id });
            return { active_id: i.workspace_id, expected_library: groupLibraryRevision(useClashGroupLibrary.getState()) };
          }),
        );
      const ok = await c.commitAsync(() => {
        guard();
        return i.action === 'retry' ? clashGroupLibrary.retry() : clashGroupLibrary.restore();
      });
      if (!ok) throw new Error('Native group storage action failed.');
      return out({ completed: i.action, expected_library: groupLibraryRevision(useClashGroupLibrary.getState()) });
    },
  ),
  viewerOperation<PageInput>(
    meta(
      'clash.groups.read',
      'Read native durable manual-group workspaces (entries, one page at a time: pass next_offset as offset with the page_revision of the previous page until next_offset is null; a list that changed in between is refused, so read again from 0), active population and save state. expected_library is the revision of the whole library and its active workspace, also the expected_groups of clash.drafts.create. status summarizes the whole library (phase, recovered, entry_count, counts by save state) and maps the ids on this page to their save states; save states of removed entries page after the entries.',
    ),
    pageInput,
    async (i, c) => {
      const { useClashGroupLibrary, clashGroupLibrary } = await import('@/lib/clash/group-workspace');
      await clashGroupLibrary.initialize();
      assertToolActive(c);
      const { entries, status, activeId } = useClashGroupLibrary.getState(), expected_library = groupLibraryRevision({ entries, activeId });
      const paged = libraryPage(entries, status, i, { activeId, expected_library });
      return out({ entries: paged.entries, ...paged.page, status: paged.storage, activeId, expected_library });
    },
  ),
  viewerOperation<{ clash_ids: string[]; run_seq: number }>(
    meta(
      'clash.groups.evidence',
      'Read canonical durable manual-group member identities for explicit current findings. No fabricated keys or bare-ID inference.',
    ),
    {
      type: 'object',
      properties: {
        clash_ids: {
          type: 'array',
          minItems: 1,
          maxItems: 2000,
          uniqueItems: true,
          items: { type: 'string', minLength: 1, maxLength: 200 },
        },
        run_seq: { type: 'integer', minimum: 0 },
      },
      required: ['clash_ids', 'run_seq'],
      additionalProperties: false,
    },
    async (i, c) => {
      const { manualClashMember } = await import('@/lib/clash/manual-groups');
      assertToolActive(c);
      return out(currentClashes(i.run_seq, i.clash_ids).map((clash) => ({ id: clash.id, member: manualClashMember(clash) })));
    },
  ),
  viewerOperation<{ workspace_json: string; expected_library: string }>(
    meta(
      'clash.groups.write',
      'Create/rename/edit manual group partitions and memberships using the canonical whole-workspace codec and durable native content writer. Duplicate/overlapping finding claims are refused atomically. Use groups.evidence for current occurrence-qualified members; empty groups remove all groups.',
      true,
    ),
    {
      type: 'object',
      properties: {
        workspace_json: { type: 'string', maxLength: 1000000 },
        expected_library: revisionInput,
      },
      required: ['workspace_json', 'expected_library'],
      additionalProperties: false,
    },
    async (i, c) => {
      const { decodeClashGroupWorkspace, clashGroupLibrary, useClashGroupLibrary } = await import(
        '@/lib/clash/group-workspace'
      );
      const workspace = decodeClashGroupWorkspace(JSON.parse(i.workspace_json));
      if (!workspace) throw new Error('Invalid native group partition.');
      assertToolActive(c);
      let next = '';
      const ok = await c.commitAsync(() => {
        if (groupLibraryRevision(useClashGroupLibrary.getState()) !== i.expected_library) throw new Error('Group workspace changed.');
        const saved = clashGroupLibrary.put(workspace.id, workspace);
        // put changes the entries synchronously; the token is the state this write made, not whatever lands during the save.
        next = groupLibraryRevision(useClashGroupLibrary.getState());
        return saved;
      });
      if (!ok) throw new Error('Native group persistence failed.');
      return out({ id: workspace.id, persisted: true, expected_library: next });
    },
  ),
  viewerOperation(
    meta(
      'clash.quality.read',
      'Read native quality thresholds and evaluate the exact current run using native stale/completeness/kind diagnostics.',
    ),
    emptySchema,
    async (_, c) => {
      const [
        { useQualityGatePreferences },
        { captureQualityGates },
        { runRequestOf },
        { isAnalysisStale, analysisStampOf },
      ] = await Promise.all([
        import('@/lib/clash/quality-gate-preferences'),
        import('@/lib/clash/quality-gate'),
        import('@/lib/clash/run-request'),
        import('@/hooks/useAnalysisStaleness'),
      ]);
      assertToolActive(c);
      const s = useViewerStore.getState(),
        config = useQualityGatePreferences.getState().config;
      return out({
        config,
        expected_config: JSON.stringify(config),
        snapshot: s.clashResult
          ? captureQualityGates(
              s.clashResult,
              config,
              isAnalysisStale(analysisStampOf(s.clashRawResult ?? s.clashResult), s),
              runRequestOf(s.clashRawResult)?.kind === 'duplicates' ? 'duplicates' : 'clash',
            )
          : null,
      });
    },
  ),
  viewerOperation<{ config_json: string; expected_config: string }>(
    meta(
      'clash.quality.write',
      'Set native clash/duplicate quality bands using exact canonical monotonic percentage/color/label validation and durable preference writer.',
      true,
    ),
    {
      type: 'object',
      properties: {
        config_json: { type: 'string', maxLength: 20000 },
        expected_config: { type: 'string', maxLength: 20000 },
      },
      required: ['config_json', 'expected_config'],
      additionalProperties: false,
    },
    async (i, c) => {
      const [{ isQualityGateConfig }, { useQualityGatePreferences }] = await Promise.all([
        import('@/lib/clash/quality-gate'),
        import('@/lib/clash/quality-gate-preferences'),
      ]);
      const config: unknown = JSON.parse(i.config_json);
      if (!isQualityGateConfig(config)) throw new Error('Invalid native quality bands.');
      assertToolActive(c);
      return out(
        c.commit(() => {
          const s = useQualityGatePreferences.getState();
          if (JSON.stringify(s.config) !== i.expected_config) throw new Error('Quality preferences changed.');
          if (!s.save(config)) throw new Error('Native quality persistence refused.');
          return { saved: true };
        }),
      );
    },
  ),
  viewerOperation<{ action: 'read' | 'capture' | 'clear' | 'compare'; run_seq: number }>(
    meta(
      'clash.revision',
      'Read/capture/clear native revision baseline or compare it with the exact current run through compareClashRevisions. Native unretested-element/model/rule distinctions remain explicit.',
      true,
    ),
    {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['read', 'capture', 'clear', 'compare'] },
        run_seq: { type: 'integer', minimum: 0 },
      },
      required: ['action', 'run_seq'],
      additionalProperties: false,
    },
    async (i, c) => {
      const [
        { loadRevisionBaseline, saveRevisionBaseline, captureModelNames },
        { compareClashRevisions },
        { useOriginalClashBaseline },
      ] = await Promise.all([
        import('@/lib/clash/revision-baseline'),
        import('@ifc-lite/clash'),
        import('@/lib/clash/original-baseline'),
      ]);
      assertToolActive(c);
      const s = useViewerStore.getState(),
        baseline = loadRevisionBaseline();
      if (i.action === 'read') return out(baseline);
      if (s.clashRunSeq !== i.run_seq) throw new Error('Clash run changed.');
      if (i.action === 'compare') {
        if (!baseline || !s.clashResult) throw new Error('Both baseline and current result are required.');
        return out(
          compareClashRevisions(
            { result: baseline.result, modelNames: baseline.modelNames },
            { result: s.clashResult, modelNames: captureModelNames(s.clashResult, s.models) },
          ),
        );
      }
      return out(
        c.commit(() => {
          if (i.action === 'capture' && !s.clashResult) throw new Error('No native run result.');
          const result = saveRevisionBaseline(
            i.action === 'clear'
              ? null
              : {
                  result: s.clashResult!,
                  modelNames: captureModelNames(s.clashResult!, s.models),
                  takenAt: Date.now(),
                },
          );
          if (!result.ok) throw new Error(result.message);
          useOriginalClashBaseline.setState({ finding: null });
          return result;
        }),
      );
    },
  ),
];

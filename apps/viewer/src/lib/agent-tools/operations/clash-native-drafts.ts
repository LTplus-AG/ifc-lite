/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { useViewerStore } from '@/store';
import { viewerOperation } from './contract';
import { assertToolActive } from '../cancellation';
import { currentClash } from './clash-native';
export const clashDraftOperations = [
  viewerOperation<{
    source: 'groups' | 'selection';
    clash_ids: string[];
    run_seq: number;
    expected_groups: string;
    name: string;
    title: string;
  }>(
    {
      id: 'clash.drafts.create',
      owner: 'clash',
      description:
        'Create a native BCF draft batch from the exact active manual-group workspace or explicitly selected current findings, through the existing native draftBatchFromGroups/draftBatchFromSelection services and durable draft writer. Captures native framing/provenance; does not publish to a server or create live BCF topics. Cancellation suppresses saving while an in-flight native frame may settle.',
      effects: ['configuration'],
      capability: 'commands-and-edits',
      implementation: 'native-store',
      outputSchema: {
        type: 'object',
        properties: { batch_id: { type: 'string' }, topics: { type: 'integer' }, persisted: { type: 'boolean' } },
        required: ['batch_id', 'topics', 'persisted'],
        additionalProperties: false,
      },
    },
    {
      type: 'object',
      properties: {
        source: { type: 'string', enum: ['groups', 'selection'] },
        clash_ids: {
          type: 'array',
          maxItems: 50000,
          uniqueItems: true,
          items: { type: 'string', minLength: 1, maxLength: 200 },
        },
        run_seq: { type: 'integer', minimum: 0 },
        expected_groups: { type: 'string', maxLength: 1000000 },
        name: { type: 'string', minLength: 1, maxLength: 200 },
        title: { type: 'string', minLength: 1, maxLength: 200 },
      },
      required: ['source', 'clash_ids', 'run_seq', 'expected_groups', 'name', 'title'],
      additionalProperties: false,
    },
    async (i, c) => {
      const [
        { currentDraftRun },
        { draftBatchFromGroups, draftBatchFromSelection },
        { useClashGroupLibrary, DEFAULT_GROUP_WORKSPACE },
        { resolveManualClashGroups },
        { saveDraftBatch },
      ] = await Promise.all([
        import('@/components/viewer/bcf/useBcfDraftActions'),
        import('@/lib/bcf-drafts/draft-create'),
        import('@/lib/clash/group-workspace'),
        import('@/lib/clash/manual-groups'),
        import('@/lib/bcf-drafts/draft-library'),
      ]);
      assertToolActive(c);
      const state = useViewerStore.getState();
      if (state.clashRunSeq !== i.run_seq) throw new Error('Clash run changed.');
      const run = currentDraftRun();
      if (!run) throw new Error('No native clash run.');
      const result = state.clashResult,
        library = useClashGroupLibrary.getState();
      if (i.source === 'groups' && JSON.stringify(library.entries) !== i.expected_groups)
        throw new Error('Manual groups changed.');
      const workspace = library.entries.find((row) => row.id === library.activeId);
      const batch =
        i.source === 'groups'
          ? await draftBatchFromGroups(
              i.name,
              workspace?.id ?? DEFAULT_GROUP_WORKSPACE,
              resolveManualClashGroups(workspace?.groups ?? [], run.clashes),
              run,
            )
          : await draftBatchFromSelection(
              i.name,
              i.title,
              i.clash_ids.map((id) => currentClash(i.run_seq, id)),
              run,
            );
      assertToolActive(c);
      if (
        useViewerStore.getState().clashResult !== result ||
        useViewerStore.getState().clashRunSeq !== i.run_seq ||
        (i.source === 'groups' &&
          (JSON.stringify(useClashGroupLibrary.getState().entries) !== i.expected_groups ||
            useClashGroupLibrary.getState().activeId !== library.activeId))
      )
        throw new Error('Native draft inputs changed during capture.');
      if (!batch.topics.length) throw new Error('Native drafting produced no topics.');
      const persisted = await c.commitAsync(() => saveDraftBatch(batch));
      return { batch_id: batch.id, topics: batch.topics.length, persisted };
    },
  ),
];

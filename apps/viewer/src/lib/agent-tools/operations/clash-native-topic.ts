/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { useViewerStore } from '@/store';
import { viewerOperation } from './contract';
import { assertToolActive } from '../cancellation';
import { clashFocusRefusal, clashRuntime, currentClashes } from './clash-native';
import { internal, invalidInput, stale, unavailable } from './refusals';
export const clashTopicOperations = [
  viewerOperation<{
    kind: 'pair' | 'report' | 'group';
    clash_ids: string[];
    run_seq: number;
    group_name: string;
    mode: 'highlight' | 'isolate' | 'ghost';
  }>(
    {
      id: 'clash.topic.create',
      owner: 'clash',
      description:
        'Create the native in-app BCF topic from a current clash, explicit manual group or report view. Calls the exact shared Clash-panel/manual-group native topic service, preserving camera/scene validity, viewport capture, source header provenance and atomic final publication. No topic/project is created on capture failure or cancellation.',
      effects: ['configuration', 'view'],
      capability: 'commands-and-edits',
      implementation: 'native-store',
      outputSchema: {
        type: 'object',
        properties: { guid: { type: 'string' } },
        required: ['guid'],
        additionalProperties: false,
      },
    },
    {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['pair', 'report', 'group'] },
        clash_ids: {
          type: 'array',
          maxItems: 2000,
          uniqueItems: true,
          items: { type: 'string', minLength: 1, maxLength: 200 },
        },
        run_seq: { type: 'integer', minimum: 0 },
        group_name: { type: 'string', maxLength: 100 },
        mode: { type: 'string', enum: ['highlight', 'isolate', 'ghost'] },
      },
      required: ['kind', 'clash_ids', 'run_seq', 'group_name', 'mode'],
      additionalProperties: false,
    },
    async (i, c) => {
      const [{ createNativeClashTopic, StaleCaptureError }, runtime] = await Promise.all([
        import('@/lib/clash/clash-native-topic'),
        clashRuntime(c),
      ]);
      const s = useViewerStore.getState();
      if (!s.clashResult) throw unavailable('No current clash result.');
      if (s.clashRunSeq !== i.run_seq) throw stale('The clash result changed since inspection.');
      if (
        (i.kind === 'pair' && i.clash_ids.length !== 1) ||
        (i.kind === 'report' && i.clash_ids.length !== 0) ||
        (i.kind === 'group' && (!i.group_name.trim() || i.clash_ids.length === 0))
      )
        throw invalidInput('invalid-value', 'Use one pair, an empty report population, or an explicit named nonempty group.');
      const result = s.clashResult,
        pairs = currentClashes(i.run_seq, i.clash_ids);
      const isCurrent = () =>
        !c.signal?.aborted &&
        useViewerStore.getState().clashResult === result &&
        useViewerStore.getState().clashRunSeq === i.run_seq;
      let created;
      try {
        created = await createNativeClashTopic({
          clashes: pairs,
          total: result.clashes.length,
          ...(i.kind === 'group' ? { groupName: i.group_name } : {}),
          mode: i.mode,
          focusClash: (pair, mode) => {
            if (!runtime.focusClash(pair, mode)) throw clashFocusRefusal('Native clash focus refused.');
          },
          focusClashes: (group, mode, signal) => {
            const focused = runtime.focusClashes(group, mode, signal);
            if (!focused) throw clashFocusRefusal('None of this group’s objects are available in the loaded models.');
            return focused;
          },
          isCurrent,
          signal: c.signal,
          commit: (write) => c.commit(write),
          requireSnapshot: true,
        });
      } catch (error) {
        if (error instanceof StaleCaptureError) throw stale(error.message);
        throw error;
      }
      assertToolActive(c);
      if (!created) throw isCurrent() ? internal('Native BCF topic capture failed.')
        : stale('The clash result changed during BCF topic capture.');
      return created;
    },
  ),
];

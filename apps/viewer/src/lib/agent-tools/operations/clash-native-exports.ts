/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { useViewerStore } from '@/store';
import { viewerOperation } from './contract';
import { assertToolActive } from '../cancellation';
import { clashRuntime } from './clash-native';
import { internal, invalidInput, stale, unavailable } from './refusals';
const outputSchema = {
  type: 'object',
  properties: { native_json: { type: 'string' } },
  required: ['native_json'],
  additionalProperties: false,
};
const meta = (id: string, description: string) => ({
  id,
  owner: 'clash',
  description,
  effects: ['artifact'] as const,
  capability: 'commands-and-edits' as const,
  implementation: 'native-store' as const,
  outputSchema,
  policy: { artifact: 'native-export' as const },
});
export const clashExportOperations = [
  viewerOperation<{ kind: 'csv' | 'presets'; run_seq: number }>(
    meta(
      'clash.export',
      'Export the exact current native CSV table or rule preset JSON through the existing panel writer into a host-owned artifact. No immediate browser download.',
    ),
    {
      type: 'object',
      properties: { kind: { type: 'string', enum: ['csv', 'presets'] }, run_seq: { type: 'integer', minimum: 0 } },
      required: ['kind', 'run_seq'],
      additionalProperties: false,
    },
    async (i, c) => {
      const [{ exportClashTableCsv }, { exportPresets }] = await Promise.all([
        import('@/lib/clash/export-table'),
        import('@/lib/clash/persistence'),
      ]);
      assertToolActive(c);
      const s = useViewerStore.getState();
      if (s.clashRunSeq !== i.run_seq) throw stale('Clash result changed.');
      let captured: { content: string; filename: string; mime: string } | undefined;
      const emit = (content: string, filename: string, mime: string) => {
        captured = { content, filename, mime };
      };
      if (i.kind === 'csv') exportClashTableCsv(emit);
      else exportPresets(s.clashPresets, emit);
      assertToolActive(c);
      if (!captured) throw unavailable('No native export result.');
      return {
        native_json: JSON.stringify(
          await c.artifacts.create({ filename: captured.filename, mimeType: captured.mime, data: captured.content }),
        ),
      };
    },
  ),
  viewerOperation<{
    run_seq: number;
    groupBy: 'cluster' | 'rule' | 'typePair' | 'element';
    severities: Array<'critical' | 'major' | 'minor' | 'info'>;
    includeSnapshots: boolean;
    maxTopics: number;
    clash_ids: string[];
  }>(
    meta(
      'clash.exportBcf',
      'Export the native grouped BCF report with severity/finding scope, exact topic cap and optional native snapshots. Uses the same shared exporter as ClashPanel. Cancellation suppresses publication; a snapshot already capturing may settle.',
    ),
    {
      type: 'object',
      properties: {
        run_seq: { type: 'integer', minimum: 0 },
        groupBy: { type: 'string', enum: ['cluster', 'rule', 'typePair', 'element'] },
        severities: {
          type: 'array',
          minItems: 1,
          maxItems: 4,
          uniqueItems: true,
          items: { type: 'string', enum: ['critical', 'major', 'minor', 'info'] },
        },
        includeSnapshots: { type: 'boolean' },
        maxTopics: { type: 'integer', minimum: 1, maximum: 10000 },
        clash_ids: {
          type: 'array',
          maxItems: 50000,
          uniqueItems: true,
          items: { type: 'string', minLength: 1, maxLength: 200 },
        },
      },
      required: ['run_seq', 'groupBy', 'severities', 'includeSnapshots', 'maxTopics', 'clash_ids'],
      additionalProperties: false,
    },
    async (i, c) => {
      let captured: { blob: Blob; filename: string } | undefined;
      const runtime = await clashRuntime(c, (blob, filename) => {
        captured = { blob, filename };
      });
      const s = useViewerStore.getState();
      if (!s.clashResult) throw unavailable('No current native result.');
      if (s.clashRunSeq !== i.run_seq) throw stale('The native result changed since inspection.');
      const current = s.clashResult;
      const ids = i.clash_ids.length ? new Set(i.clash_ids) : undefined;
      const known = ids ? new Set(current.clashes.map((clash) => clash.id)) : undefined;
      if (known && i.clash_ids.some((id) => !known.has(id)))
        throw invalidInput('unknown-target', 'Unknown current finding in explicit export scope.');
      const config = {
        groupBy: i.groupBy,
        severities: i.severities,
        includeSnapshots: i.includeSnapshots,
        maxTopics: i.maxTopics,
        clashIds: ids,
      };
      const preview = runtime.bcfPreview(config);
      if (!preview.clashes) throw invalidInput('invalid-value', 'No native findings match the requested BCF export scope.');
      await runtime.exportBcf(config);
      assertToolActive(c);
      if (useViewerStore.getState().clashResult !== current) throw stale('Clash results changed during export.');
      if (!captured) throw internal('The native exporter produced no BCF artifact.');
      return {
        native_json: JSON.stringify({
          preview,
          artifact: await c.artifacts.create({
            filename: captured.filename,
            mimeType: 'application/zip',
            data: captured.blob,
          }),
        }),
      };
    },
  ),
];

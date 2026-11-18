/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { useViewerStore } from '@/store';
import { viewerOperation } from './contract';
import { assertToolActive } from '../cancellation';
import { currentClash, clashSettings } from './clash-native';
const outputSchema = {
  type: 'object',
  properties: { native_json: { type: 'string' } },
  required: ['native_json'],
  additionalProperties: false,
};
const out = (value: unknown) => ({ native_json: JSON.stringify(value ?? null) });
const meta = (id: string, description: string) => ({
  id,
  owner: 'clash',
  description,
  effects: ['configuration'] as const,
  capability: 'commands-and-edits' as const,
  implementation: 'native-store' as const,
  outputSchema,
});
function saved(result: { ok: boolean }) {
  if (!result.ok) throw new Error(`Native clash persistence refused: ${JSON.stringify(result)}`);
  return result;
}
export const clashSettingsOperations = [
  viewerOperation<{
    sortBy: 'severity' | 'depth' | 'distance';
    hideTouching: boolean;
    focusMode: 'highlight' | 'isolate' | 'ghost';
    showRegionBox: boolean;
    statusFilter: Array<'open' | 'resolved' | 'accepted'>;
    expected_settings: string;
  }>(
    meta(
      'clash.viewSettings',
      'Set native sort/touching/review-status filters, focus mode and region-box display after inspecting the exact settings. These change presentation, not detection results.',
    ),
    {
      type: 'object',
      properties: {
        sortBy: { type: 'string', enum: ['severity', 'depth', 'distance'] },
        hideTouching: { type: 'boolean' },
        focusMode: { type: 'string', enum: ['highlight', 'isolate', 'ghost'] },
        showRegionBox: { type: 'boolean' },
        statusFilter: {
          type: 'array',
          maxItems: 3,
          uniqueItems: true,
          items: { type: 'string', enum: ['open', 'resolved', 'accepted'] },
        },
        expected_settings: { type: 'string', maxLength: 20000 },
      },
      required: ['sortBy', 'hideTouching', 'focusMode', 'showRegionBox', 'statusFilter', 'expected_settings'],
      additionalProperties: false,
    },
    (i, c) =>
      out(
        c.commit(() => {
          const s = useViewerStore.getState();
          if (JSON.stringify(clashSettings()) !== i.expected_settings) throw new Error('Clash settings changed.');
          s.setClashSortBy(i.sortBy);
          s.setClashHideTouching(i.hideTouching);
          s.setClashFocusMode(i.focusMode);
          s.setShowClashRegionBox(i.showRegionBox);
          for (const status of ['open', 'resolved', 'accepted'] as const)
            if (s.clashStatusFilter.has(status) !== i.statusFilter.includes(status)) s.toggleClashStatusFilter(status);
          return { settings: clashSettings(), statusFilter: [...useViewerStore.getState().clashStatusFilter] };
        }),
      ),
  ),
  viewerOperation<{ settings_json: string; expected_settings: string }>(
    meta(
      'clash.settings.write',
      'Set the complete canonical native detection settings in one native durable flavor transaction. Unknown fields or normalization changes are refused; settings_json uses ClashGlobalSettings. Inspect clash.state first.',
    ),
    {
      type: 'object',
      properties: {
        settings_json: { type: 'string', maxLength: 20000 },
        expected_settings: { type: 'string', maxLength: 20000 },
      },
      required: ['settings_json', 'expected_settings'],
      additionalProperties: false,
    },
    async (i, c) => {
      const { normalizeSettings } = await import('@/lib/clash/persistence');
      const raw: unknown = JSON.parse(i.settings_json);
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Expected canonical settings object.');
      const settings = normalizeSettings(raw);
      const record = raw as Record<string, unknown>;
      if (
        Object.keys(record).some((key) => !Object.hasOwn(settings, key)) ||
        Object.entries(settings).some(([key, value]) => record[key] !== value)
      )
        throw new Error('Provide every canonical setting with valid native values/bounds.');
      assertToolActive(c);
      return out(
        c.commit(() => {
          const s = useViewerStore.getState();
          if (JSON.stringify(clashSettings()) !== i.expected_settings) throw new Error('Clash settings changed.');
          return saved(s.applyClashFlavorConfig({ settings, presets: s.clashPresets }));
        }),
      );
    },
  ),
  viewerOperation<{
    action: 'create' | 'update' | 'delete' | 'enabled' | 'reset' | 'import';
    id: string;
    preset_json: string;
    enabled: boolean;
    expected_presets: string;
  }>(
    meta(
      'clash.presets.write',
      'Create/edit/delete/enable/reset/import native rule presets, including side set/model-tag filters. Preserves built-in protections, validation, storage rollback and all SaveResult refusals. preset_json for create/update is a canonical stored ClashPreset; import is a native exported JSON file.',
    ),
    {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['create', 'update', 'delete', 'enabled', 'reset', 'import'] },
        id: { type: 'string', maxLength: 200 },
        preset_json: { type: 'string', maxLength: 1000000 },
        enabled: { type: 'boolean' },
        expected_presets: { type: 'string', maxLength: 1000000 },
      },
      required: ['action', 'id', 'preset_json', 'enabled', 'expected_presets'],
      additionalProperties: false,
    },
    async (i, c) => {
      const { isValidStoredPreset, storedPresetToPreset, importPresets } = await import('@/lib/clash/persistence');
      const imported =
        i.action === 'import'
          ? await importPresets(new File([i.preset_json], 'clash-presets.json', { type: 'application/json' }))
          : null;
      // The panel refuses an import with no valid rules (noValidRulesToast); so does the operation.
      if (imported && !imported.length) throw new Error('The preset file contains no valid clash rules.');
      let preset;
      if (i.action === 'create' || i.action === 'update') {
        const value: unknown = JSON.parse(i.preset_json);
        if (!isValidStoredPreset(value)) throw new Error('Invalid canonical ClashPreset.');
        preset = storedPresetToPreset(value, false);
      }
      assertToolActive(c);
      return out(
        c.commit(() => {
          const s = useViewerStore.getState();
          if (JSON.stringify(s.clashPresets) !== i.expected_presets) throw new Error('Clash presets changed.');
          if (i.action === 'reset') return saved(s.resetClashPresets());
          if (i.action === 'import') return saved(s.importClashPresets(imported!));
          if (i.action === 'create') return saved(s.createClashPreset(preset!));
          if (!s.clashPresets.some((p) => p.id === i.id)) throw new Error('Unknown native preset.');
          return saved(
            i.action === 'update'
              ? s.updateClashPreset(
                  i.id,
                  (() => {
                    const { id, builtin, ...patch } = preset!;
                    void id;
                    void builtin;
                    return patch;
                  })(),
                )
              : i.action === 'delete'
                ? s.deleteClashPreset(i.id)
                : s.setClashPresetEnabled(i.id, i.enabled),
          );
        }),
      );
    },
  ),
  viewerOperation<{ clash_id: string; run_seq: number; status: 'open' | 'resolved' | 'accepted'; comment: string }>(
    meta(
      'clash.review',
      'Write the supplied native clash review status/comment under its durable review key, preserving native persistence refusal.',
    ),
    {
      type: 'object',
      properties: {
        clash_id: { type: 'string', minLength: 1, maxLength: 200 },
        run_seq: { type: 'integer', minimum: 0 },
        status: { type: 'string', enum: ['open', 'resolved', 'accepted'] },
        comment: { type: 'string', maxLength: 10000 },
      },
      required: ['clash_id', 'run_seq', 'status', 'comment'],
      additionalProperties: false,
    },
    async (i, c) => {
      const [{ clashReviewKey }, { MAX_COMMENT }] = await Promise.all([import('@ifc-lite/clash'), import('@/lib/clash/persistence')]);
      if (i.comment.trim().length > MAX_COMMENT)
        throw new Error(`Review comments are limited to ${MAX_COMMENT} characters after trimming.`);
      assertToolActive(c);
      return out(
        c.commit(() =>
          saved(
            useViewerStore
              .getState()
              .setClashReview(clashReviewKey(currentClash(i.run_seq, i.clash_id)), {
                status: i.status,
                comment: i.comment,
              }),
          ),
        ),
      );
    },
  ),
  viewerOperation<{
    action: 'typeAny' | 'typePair' | 'elementPair' | 'remove' | 'enabled' | 'clear';
    clash_id: string;
    run_seq: number;
    tag: string;
    id: string;
    enabled: boolean;
    expected_exclusions: string;
  }>(
    meta(
      'clash.exclusions.write',
      'Create native type-any/type-pair/element-pair exclusions from exact current findings, or remove/toggle/clear. Native derivation recomputes filtered results/groups/counts without rerunning geometry; durable IDs use native factories.',
    ),
    {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['typeAny', 'typePair', 'elementPair', 'remove', 'enabled', 'clear'] },
        clash_id: { type: 'string', maxLength: 200 },
        run_seq: { type: 'integer', minimum: 0 },
        tag: { type: 'string', maxLength: 200 },
        id: { type: 'string', maxLength: 500 },
        enabled: { type: 'boolean' },
        expected_exclusions: { type: 'string', maxLength: 1000000 },
      },
      required: ['action', 'clash_id', 'run_seq', 'tag', 'id', 'enabled', 'expected_exclusions'],
      additionalProperties: false,
    },
    async (i, c) => {
      const { typeAnyExclusion, typePairExclusion, elementPairExclusion } = await import('@/lib/clash/exclusions');
      assertToolActive(c);
      return out(
        c.commit(() => {
          const s = useViewerStore.getState();
          if (JSON.stringify(s.clashExclusions) !== i.expected_exclusions) throw new Error('Clash exclusions changed.');
          if (i.action === 'clear') return saved(s.clearClashExclusions());
          if (i.action === 'remove' || i.action === 'enabled') {
            if (!s.clashExclusions.some((rule) => rule.id === i.id)) throw new Error('Unknown native exclusion.');
            return saved(
              i.action === 'remove' ? s.removeClashExclusion(i.id) : s.setClashExclusionEnabled(i.id, i.enabled),
            );
          }
          if (i.action === 'typeAny') {
            const tag = i.tag.trim();
            if (!tag) throw new Error('An IFC class is required.');
            return saved(s.addClashExclusion(typeAnyExclusion(tag)));
          }
          const pair = currentClash(i.run_seq, i.clash_id);
          return saved(
            s.addClashExclusion(
              i.action === 'typePair'
                ? typePairExclusion(pair.a.tag, pair.b.tag)
                : elementPairExclusion(pair.a, pair.b),
            ),
          );
        }),
      );
    },
  ),
];

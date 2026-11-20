/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { useViewerStore } from '@/store';
import { viewerOperation, emptySchema, type ViewerOperationContext } from './contract';
import { assertToolActive } from '../cancellation';
import type { ToolHost } from '../types';
import type { ClashGroupDraft } from '@/lib/assistant/clash-group-draft';
import type { ClassifyPlan } from '@/lib/assistant/clash-classify-chunks';
import type { EvidenceSnapshot } from '@/lib/assistant/evidence';
import type { ClashGroupApplyPlan } from '@/lib/clash/group-apply';
import { evictOldest } from './host-handles';
const outputSchema = {
  type: 'object',
  properties: { native_json: { type: 'string' } },
  required: ['native_json'],
  additionalProperties: false,
};
const out = (value: unknown) => ({ native_json: JSON.stringify(value) });
const meta = (id: string, description: string, network = false) => ({
  id,
  owner: 'clash',
  features: network ? (['ai.assistant'] as const) : [],
  description,
  effects: network ? (['network'] as const) : (['configuration'] as const),
  capability: 'commands-and-edits' as const,
  implementation: 'native-store' as const,
  outputSchema,
  policy: network ? { network: 'native-provider' as const } : undefined,
});
interface Review {
  result: NonNullable<ReturnType<typeof useViewerStore.getState>['clashResult']>;
  plan: ClassifyPlan;
  evidence: EvidenceSnapshot;
  model: string;
  draft?: ClashGroupDraft;
  apply?: ClashGroupApplyPlan;
}
const hosts = new WeakMap<ToolHost, Map<string, Review>>();
function reviews(c: ViewerOperationContext) {
  let map = hosts.get(c.host);
  if (!map) {
    map = new Map();
    hosts.set(c.host, map);
    const owned = map;
    c.host.lifetimeSignal?.addEventListener('abort', () => owned.clear(), { once: true });
  }
  return map;
}
function review(c: ViewerOperationContext, token: string) {
  const value = reviews(c).get(token);
  if (!value || value.result !== useViewerStore.getState().clashResult)
    throw new Error('Unknown or stale native classification review.');
  return value;
}
const tokenInput = {
  type: 'object' as const,
  properties: { token: { type: 'string' as const, minLength: 1, maxLength: 100 } },
  required: ['token' as const],
  additionalProperties: false as const,
};
export const clashClassificationOperations = [
  viewerOperation(
    meta(
      'clash.classification.prepare',
      'Capture complete native classification chunks, bounded sample evidence and native root-budget estimate before any provider call. Uses the configured UI model capability ceiling; no network or model edit.',
    ),
    emptySchema,
    async (_, c) => {
      const [
        { planClassification, estimateClassification, CLASSIFY_ROOT_BUDGET },
        { captureEvidence },
        { modelCapabilities },
      ] = await Promise.all([
        import('@/lib/assistant/clash-classify-chunks'),
        import('@/lib/assistant/evidence'),
        import('@/lib/llm/model-capabilities'),
      ]);
      assertToolActive(c);
      const s = useViewerStore.getState();
      if (!s.clashResult) throw new Error('No current native clash result.');
      const plan = planClassification(s.clashResult.clashes),
        evidence = captureEvidence('clash');
      evictOldest(reviews(c), 32);
      const token = crypto.randomUUID();
      reviews(c).set(token, { result: s.clashResult, plan, evidence, model: s.chatActiveModel });
      c.retain(() => { reviews(c).delete(token); });
      return out({
        token,
        evidence,
        estimate: estimateClassification(
          plan,
          CLASSIFY_ROOT_BUDGET,
          modelCapabilities(s.chatActiveModel).maxOutputTokens,
        ),
        limits: CLASSIFY_ROOT_BUDGET,
      });
    },
  ),
  viewerOperation<{ token: string; allow_normalization: boolean }>(
    meta(
      'clash.classification.run',
      'Run the existing chunked classify-all service against the already configured native route/keys/proxy, with the exact native root budget and explicit normalization consent. Forwards real cancellation and current-run guard. Returns native accounting/diagnostics and a review draft; does not apply groups.',
      true,
    ),
    {
      type: 'object',
      properties: { ...tokenInput.properties, allow_normalization: { type: 'boolean' } },
      required: ['token', 'allow_normalization'],
      additionalProperties: false,
    },
    async (i, c) => {
      review(c, i.token); // refuse an unknown token before loading the provider modules
      const [
        { runClassification, draftFromClassification },
        { CLASSIFY_ROOT_BUDGET, estimateClassification },
        { resolveStreamRoute },
        { modelCapabilities },
        { createRootBudget },
        { getApiKeys },
        { UNCONFIGURED_MODEL_ID },
      ] = await Promise.all([
        import('@/lib/assistant/clash-classify-run'),
        import('@/lib/assistant/clash-classify-chunks'),
        import('@/lib/llm/byok-guard'),
        import('@/lib/llm/model-capabilities'),
        import('@/lib/llm/root-budget'),
        import('@/services/api-keys'),
        import('@/lib/llm/models'),
      ]);
      const saved = review(c, i.token);
      assertToolActive(c);
      if (saved.model !== useViewerStore.getState().chatActiveModel || saved.model === UNCONFIGURED_MODEL_ID)
        throw new Error('Native classification model changed or is unconfigured.');
      const route = resolveStreamRoute(saved.model, getApiKeys());
      if (route.kind === 'missing-key') throw new Error('The native provider route requires a configured key.');
      if (
        !estimateClassification(saved.plan, CLASSIFY_ROOT_BUDGET, modelCapabilities(saved.model).maxOutputTokens).fits
      )
        throw new Error('Native root classification budget does not fit this population.');
      const signal = c.signal ?? c.host.lifetimeSignal;
      if (!signal) throw new Error('A live cancellation/session signal is required.');
      const result = await runClassification({
        plan: saved.plan,
        route,
        proxyUrl: import.meta.env.VITE_LLM_PROXY_URL || '/api/chat',
        budget: createRootBudget(CLASSIFY_ROOT_BUDGET),
        signal,
        allowNormalization: i.allow_normalization,
        isCurrent: () => !signal.aborted && saved.result === useViewerStore.getState().clashResult,
      });
      assertToolActive(c);
      review(c, i.token);
      saved.draft = draftFromClassification(result);
      return out({ result, draft: { ...saved.draft, findings: [...saved.draft.findings] } });
    },
  ),
  viewerOperation<{ token: string; answer: string }>(
    meta(
      'clash.classification.sample',
      'Ground a supplied typed clash.groups answer against the exact captured native sample evidence, then create the same editable review draft as the Assistant UI.',
    ),
    {
      type: 'object',
      properties: { ...tokenInput.properties, answer: { type: 'string', maxLength: 1000000 } },
      required: ['token', 'answer'],
      additionalProperties: false,
    },
    async (i, c) => {
      const [{ prepareClashGroupPreview }, { draftFromPreview }] = await Promise.all([
        import('@/lib/assistant/clash-group-proposal'),
        import('@/lib/assistant/clash-group-draft'),
      ]);
      const saved = review(c, i.token);
      assertToolActive(c);
      const preview = prepareClashGroupPreview(i.answer, saved.evidence);
      saved.draft = draftFromPreview(preview);
      return out({ preview, draft: { ...saved.draft, findings: [...saved.draft.findings] } });
    },
  ),
  viewerOperation<{
    token: string;
    action: 'rename' | 'move' | 'newGroup' | 'unclassify' | 'merge';
    group: string;
    target: string;
    name: string;
    occurrences: string[];
  }>(
    meta(
      'clash.classification.edit',
      'Run native review draft rename/move/new-group/unclassify/merge handlers, preserving native immutable finding IDs, name validation and accounting.',
    ),
    {
      type: 'object',
      properties: {
        ...tokenInput.properties,
        action: { type: 'string', enum: ['rename', 'move', 'newGroup', 'unclassify', 'merge'] },
        group: { type: 'string', maxLength: 200 },
        target: { type: 'string', maxLength: 200 },
        name: { type: 'string', maxLength: 100 },
        occurrences: { type: 'array', maxItems: 50000, uniqueItems: true, items: { type: 'string', maxLength: 10000 } },
      },
      required: ['token', 'action', 'group', 'target', 'name', 'occurrences'],
      additionalProperties: false,
    },
    async (i, c) => {
      const { renameDraftGroup, moveDraftFindings, mergeDraftGroups, draftAccounting } = await import(
        '@/lib/assistant/clash-group-draft'
      );
      const saved = review(c, i.token);
      if (!saved.draft) throw new Error('No native review draft.');
      assertToolActive(c);
      const edit =
        i.action === 'rename'
          ? renameDraftGroup(saved.draft, i.group, i.name)
          : i.action === 'merge'
            ? mergeDraftGroups(saved.draft, i.group, i.target)
            : moveDraftFindings(
                saved.draft,
                i.occurrences,
                i.action === 'unclassify' ? null : i.action === 'newGroup' ? { newGroup: i.name } : { group: i.target },
              );
      if (!edit.ok) throw new Error(`Native draft edit refused: ${edit.reason}`);
      saved.draft = edit.draft;
      saved.apply = undefined;
      return out({
        draft: { ...saved.draft, findings: [...saved.draft.findings] },
        accounting: draftAccounting(saved.draft),
      });
    },
  ),
  viewerOperation<{ token: string; workspace_id: string; name: string }>(
    meta(
      'clash.classification.plan',
      'Prepare the exact native reviewed grouping application into an existing workspace (workspace_id) or new workspace (empty id). Returns moved-finding and native expected-revision details before apply.',
    ),
    {
      type: 'object',
      properties: {
        ...tokenInput.properties,
        workspace_id: { type: 'string', maxLength: 200 },
        name: { type: 'string', minLength: 1, maxLength: 200 },
      },
      required: ['token', 'workspace_id', 'name'],
      additionalProperties: false,
    },
    async (i, c) => {
      const { readApplyBase, newWorkspaceBase, planClashGroupApply } = await import('@/lib/clash/group-apply');
      const saved = review(c, i.token);
      if (!saved.draft) throw new Error('No native review draft.');
      const base = i.workspace_id ? await readApplyBase(i.workspace_id, i.name) : newWorkspaceBase(i.name);
      assertToolActive(c);
      review(c, i.token);
      if (!base) throw new Error('Native workspace unavailable.');
      const planned = planClashGroupApply(saved.draft.groups, base, saved.result.clashes);
      if (!planned.ok) throw new Error(`Native group plan refused: ${planned.reason}`);
      saved.apply = planned.plan;
      return out(planned.plan);
    },
  ),
  viewerOperation<{ token: string; confirm_moves: boolean }>(
    meta(
      'clash.classification.apply',
      'Apply the exact native grouping plan in the existing optimistic content batch with explicit moved-finding confirmation and immutable receipt. Preserves stale-run/unsaved-edit/storage/revision refusals.',
    ),
    {
      type: 'object',
      properties: { ...tokenInput.properties, confirm_moves: { type: 'boolean' } },
      required: ['token', 'confirm_moves'],
      additionalProperties: false,
    },
    async (i, c) => {
      const { applyClashGroupPlan } = await import('@/lib/clash/group-apply');
      const saved = review(c, i.token);
      if (!saved.draft || !saved.apply) throw new Error('Prepare native grouping plan first.');
      const result = await c.commitAsync(() =>
        applyClashGroupPlan(saved.apply!, {
          confirmMoves: i.confirm_moves,
          origin: `agent:${saved.evidence.id}`,
          source: saved.draft!.origin.kind,
          partial: saved.draft!.origin.kind === 'full-run' && saved.draft!.origin.partial,
        }),
        (r) => r.ok,
      );
      if (!result.ok) throw new Error(`Native group apply refused: ${result.reason}`);
      return out(result);
    },
  ),
  viewerOperation<{ receipt_id: string }>(
    meta(
      'clash.classification.undo',
      'Undo an exact native grouping receipt through the original optimistic revision/partition guards. Never overwrites a later human edit/import.',
    ),
    {
      type: 'object',
      properties: { receipt_id: { type: 'string', minLength: 1, maxLength: 200 } },
      required: ['receipt_id'],
      additionalProperties: false,
    },
    async (i, c) => {
      const [{ clashGroupApplicationLibrary, useClashGroupApplications }, { undoClashGroupApplication }] =
        await Promise.all([import('@/lib/clash/group-applications'), import('@/lib/clash/group-apply')]);
      await clashGroupApplicationLibrary.initialize();
      assertToolActive(c);
      const receipt = useClashGroupApplications.getState().entries.find((row) => row.id === i.receipt_id);
      if (!receipt) throw new Error('Unknown native grouping receipt.');
      const result = await c.commitAsync(() => undoClashGroupApplication(receipt), (r) => r.ok);
      if (!result.ok) throw new Error(`Native grouping Undo refused: ${result.reason}`);
      return out(result);
    },
  ),
];

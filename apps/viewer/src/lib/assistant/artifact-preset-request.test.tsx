/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { Ajv } from 'ajv';
import { MutablePropertyView } from '@ifc-lite/mutations';
import { render, click, cleanup, type, waitFor, advance } from '@/test/render';
import { seedArtifactModels, ARCH } from '@/test/artifact-models-fixture';
import { loadListDefinitions } from '@/lib/lists/persistence';
import { prepareListProviders } from '@/lib/lists/prepare-providers';
import { runListFederated } from '@/lib/lists/run-list';
import { resolveRenderFrame } from '@/hooks/useRenderFrameOffsets';
import { configureMutationView } from '@/utils/configureMutationView';
import { useViewerStore } from '@/store';
import { updateApiKeys, clearApiKeys } from '@/services/api-keys';
import { AssistantPanel } from '@/components/viewer/assistant/AssistantPanel';
import { useAssistant, replaceEvidence, cancelAssistant } from './conversation';
import { setAssistantDraft } from './composer-draft';
import { captureEvidence } from './evidence';
import { parseArtifactProposal, type ArtifactKind } from './artifacts/proposal-kinds';
import { previewArtifact } from './artifacts/artifact-preview';

const pristine = useViewerStore.getState();
const assistant = useAssistant.getState();
const originalFetch = globalThis.fetch;
afterEach(() => {
  cleanup(); cancelAssistant(); setAssistantDraft(''); clearApiKeys(); globalThis.fetch = originalFetch;
  useViewerStore.setState(pristine, true); useAssistant.setState(assistant, true);
});

const chart = { version: 1, kind: 'chart.proposal', title: 'Native classes', scope: 'all',
  chart: { type: 'bar', dimension: 'IfcType', measure: { agg: 'count' } } };
const list = { version: 1, kind: 'list.proposal', title: 'Wall measurements', list: {
  name: 'Wall measurements', entityTypes: ['IfcWall'], columns: [
    { id: 'area', source: 'quantity', psetName: 'Qto_WallBaseQuantities', propertyName: 'NetSideArea' },
    { id: 'fire-rating', source: 'property', psetName: 'Pset_WallCommon', propertyName: 'FireRating' },
  ] } };

type Protocol = 'chat' | 'responses' | 'anthropic' | 'hosted';
const models: Record<Protocol, string> = { chat: 'gpt-6.1-sol', responses: 'gpt-5.3-codex',
  anthropic: 'claude-opus-5-5', hosted: 'openai/gpt-free' };

async function seed(protocol: Protocol, federated: boolean) {
  await seedArtifactModels({ federated });
  const store = useViewerStore.getState().models.get(ARCH)?.ifcDataStore; assert.ok(store);
  // Real live authored value on actual SketchUp wall#291; no fabricated parser.
  const view = new MutablePropertyView(null, ARCH); configureMutationView(view, store);
  view.setProperty(291, 'Pset_WallCommon', 'FireRating', 'EI60');
  useViewerStore.setState({ mutationViews: new Map([[ARCH, view]]), mutationVersion: 1, chatActiveModel: models[protocol] });
  updateApiKeys({ openaiKey: 'sk-native-test', anthropicKey: 'sk-ant-native-test' });
  replaceEvidence(captureEvidence('loadReport'));
}

function stream(protocol: Protocol, answer: string) {
  if (protocol === 'responses') return `data: ${JSON.stringify({ type: 'response.output_text.delta', delta: answer })}\n\ndata: ${JSON.stringify({ type: 'response.completed', response: { status: 'completed' } })}\n\n`;
  if (protocol !== 'anthropic') return `data: ${JSON.stringify({ choices: [{ delta: { content: answer }, finish_reason: 'stop' }] })}\n\n`;
  const events = [
    { type: 'message_start', message: { id: 'msg_native', type: 'message', role: 'assistant', model: models.anthropic,
      content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 12, output_tokens: 1 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: answer } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 4 } },
    { type: 'message_stop' },
  ];
  return events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('');
}

async function settled(expected: 'idle' | 'error' = 'idle') {
  await waitFor(() => useAssistant.getState().status !== 'streaming', 'native provider request settles');
  assert.equal(useAssistant.getState().status, expected, useAssistant.getState().error ?? 'request did not settle');
}

for (const protocol of ['chat', 'responses', 'anthropic'] as const) {
  for (const kind of ['chart', 'list'] as const) {
    test(`#7234 mounted explicit ${kind} preset reaches real ${protocol} strict transport and native 1/N preview`, async () => {
      const federated = protocol !== 'chat'; await seed(protocol, federated);
      const answer = kind === 'chart' ? chart : list;
      const sent: Record<string, unknown>[] = [];
      globalThis.fetch = async (_url, init) => { sent.push(JSON.parse(String(init?.body))); return new Response(stream(protocol, JSON.stringify(answer))); };
      const ui = render(<AssistantPanel />);
      const label = kind === 'chart' ? 'Chart element counts by IFC class' : 'Build a list of walls with their area and fire rating';
      const preset = [...ui.querySelectorAll('button')].find(button => button.textContent === label); assert.ok(preset); click(preset);
      click(ui.querySelector('button[type="submit"]')!); await settled();
      assert.equal(sent.length, 1);
      const payload = sent[0];
      const format = protocol === 'chat' ? (payload.response_format as { json_schema?: { schema: object } } | undefined)?.json_schema
        : protocol === 'responses' ? (payload.text as { format?: { schema: object } } | undefined)?.format
        : (payload.output_config as { format?: { schema: object } } | undefined)?.format;
      assert.ok(format?.schema, 'explicit preset must reach the shared real provider schema transport');
      const valid = new Ajv({ strict: true }).compile(format.schema);
      assert.equal(valid(answer), true);
      assert.equal(valid({ ...answer, title: null }), false, 'null does not mean an omitted optional');
      assert.equal(valid({ ...answer, kind: 'filter.proposal' }), false);
      if (kind === 'list') {
        assert.equal(valid({ ...list, list: { ...list.list, description: null } }), false);
        // Structural output still passes through native semantic refusal, never directly executes.
        const duplicate = { ...list, list: { ...list.list, columns: [list.list.columns[0], list.list.columns[0]] } };
        assert.equal(valid(duplicate), true);
        assert.throws(() => parseArtifactProposal(JSON.stringify(duplicate), 'list.proposal'), /repeats the column id/);
      } else assert.equal(valid({ ...chart, chart: { ...chart.chart, title: null } }), false);
      const reply = useAssistant.getState().messages.at(-1); assert.equal(reply?.receipt?.outputFormat, 'json-schema');
      assert.equal(reply?.content, JSON.stringify(answer));
      const proposal = parseArtifactProposal(reply!.content, `${kind}.proposal` as ArtifactKind);
      const preview = await previewArtifact(proposal, useViewerStore.getState());
      if (kind === 'chart') {
        assert.equal(preview.matched, federated ? 20 : 14);
        assert.equal(preview.buckets.find(bucket => bucket.label === 'IfcWall')?.count, federated ? 5 : 4);
      } else {
        assert.deepEqual(preview.population.map(model => [model.modelId, model.count]), federated ? [['arch', 4], ['wall', 1]] : [['arch', 4]]);
        assert.ok(preview.samples.some(row => row.globalId === '3wdauVJT5Fx9drrREiDqA$' && row.values.some(value => value === 'EI60')));
        assert.equal(preview.measures[0].unit, 'm²');
        assert.ok(Math.abs(preview.measures[0].total - 43.29141256176735) < 0.001);
      }
    });
  }
}

for (const control of ['edited', 'typed', 'refreshed', 'unavailable-fields', 'hosted', 'provider-refusal'] as const) {
  test(`#7234 mounted ${control} preserves explicit intent and route boundaries without retries`, async () => {
    const protocol = control === 'hosted' ? 'hosted' : 'chat';
    await seed(protocol, false);
    if (control === 'unavailable-fields') {
      // Unedited native SketchUp IFC has FireRating only on a slab; it cannot supply a wall profile.
      await seedArtifactModels(); replaceEvidence(captureEvidence('loadReport'));
    }
    const sent: Record<string, unknown>[] = [];
    globalThis.fetch = async (_url, init) => {
      sent.push(JSON.parse(String(init?.body)));
      if (control === 'provider-refusal') return new Response(JSON.stringify({ error: { message: 'schema rejected' } }), { status: 400 });
      return new Response(stream(protocol, 'Native evidence remains available for review.'));
    };
    const ui = render(<AssistantPanel />);
    const label = control === 'unavailable-fields' ? 'Build a list of walls with their area and fire rating' : 'Chart element counts by IFC class';
    const preset = [...ui.querySelectorAll('button')].find(button => button.textContent === label); assert.ok(preset);
    if (control !== 'typed') click(preset);
    const input = ui.querySelector<HTMLTextAreaElement>('textarea'); assert.ok(input);
    if (control === 'typed' || control === 'edited') type(input, control === 'typed' ? label : `${label}, explain the result`);
    if (control === 'refreshed') {
      // Same native source, new capture: a saved explicit intent belongs to the old capture only.
      const refresh = ui.querySelector('button[aria-label="Refresh evidence and start a new conversation"]'); assert.ok(refresh); click(refresh);
    }
    click(ui.querySelector('button[type="submit"]')!); await settled(control === 'provider-refusal' ? 'error' : 'idle');
    assert.equal(sent.length, 1, 'schema refusal never becomes a silent textual retry');
    if (control === 'provider-refusal') {
      assert.ok(sent[0].response_format); assert.equal(useAssistant.getState().status, 'error');
      assert.equal(useAssistant.getState().messages.some(message => message.role === 'assistant'), false);
    } else {
      assert.equal(sent[0].response_format, undefined);
      assert.equal(useAssistant.getState().messages.at(-1)?.receipt?.outputFormat, control === 'hosted' ? 'text' : undefined);
      assert.equal(useAssistant.getState().messages.at(-1)?.content, 'Native evidence remains available for review.');
    }
  });
}

test('#7234 source replacement aborts the owned preset request and discards late native proposal', async () => {
  await seed('chat', false);
  let started = false; let release: (() => void) | undefined; const transport: { signal?: AbortSignal | null } = {};
  const gate = new Promise<void>(resolve => { release = resolve; });
  globalThis.fetch = async (_url, init) => {
    transport.signal = init?.signal ?? null; started = true; await gate;
    return new Response(stream('chat', JSON.stringify(chart)));
  };
  const ui = render(<AssistantPanel />);
  const preset = [...ui.querySelectorAll('button')].find(button => button.textContent === 'Chart element counts by IFC class'); assert.ok(preset); click(preset);
  click(ui.querySelector('button[type="submit"]')!);
  await waitFor(() => started, 'real provider transport begins');
  const refresh = ui.querySelector('button[aria-label="Refresh evidence and start a new conversation"]'); assert.ok(refresh); click(refresh);
  assert.ok(transport.signal?.aborted, 'the active per-request native controller aborts');
  release!(); await advance(0);
  await waitFor(() => useAssistant.getState().status !== 'streaming', 'replacement capture owns conversation');
  assert.equal(useAssistant.getState().messages.length, 0, 'late proposal cannot populate a replacement capture');
});


test('#7234 public list preset saves, opens and reloads the native definition without changing the scene', async () => {
  localStorage.removeItem('ifc-lite-lists');
  await seed('chat', true);
  const before = useViewerStore.getState();
  const view = before.mutationViews.get(ARCH); assert.ok(view);
  const mutations = view.getMutations();
  globalThis.fetch = async () => new Response(stream('chat', JSON.stringify(list)));
  const ui = render(<AssistantPanel />);
  const button = (text: string) => [...ui.querySelectorAll('button')].find(item => item.textContent === text);
  const preset = button('Build a list of walls with their area and fire rating'); assert.ok(preset); click(preset);
  click(ui.querySelector('button[type="submit"]')!); await settled();
  await waitFor(() => !!button('Save to Lists'), 'native list preview allows Save');
  click(button('Save to Lists')!);
  await waitFor(() => !!button('Open in the list editor'), 'native library save finishes');
  click(button('Open in the list editor')!);
  const after = useViewerStore.getState();
  const restored = loadListDefinitions().find(definition => definition.id === after.pendingListDraft?.id);
  assert.ok(restored, 'native persistence decoder reloads the definition opened by the public review');
  assert.equal(restored.name, 'Wall measurements');
  const { pairs } = prepareListProviders(after, resolveRenderFrame(after.models, after.geometryResult));
  const result = await runListFederated(restored, pairs, after);
  assert.equal(result.rows.length, 5, 'reloaded definition runs against both real native IFC sources');
  const wall = result.rows.find(row => row.modelId === ARCH && row.entityId === 291); assert.ok(wall);
  assert.ok(wall.values.includes('EI60'), 'saved native fields retain the current authored property');
  assert.strictEqual(after.models, before.models);
  assert.strictEqual(after.mutationViews, before.mutationViews);
  assert.deepEqual(view.getMutations(), mutations);
  assert.equal(after.mutationVersion, before.mutationVersion);
  assert.strictEqual(after.selectedEntityIds, before.selectedEntityIds);
  assert.equal(after.selectedEntityId, before.selectedEntityId);
  assert.strictEqual(after.hiddenEntities, before.hiddenEntities);
  assert.strictEqual(after.isolatedEntities, before.isolatedEntities);
  localStorage.removeItem('ifc-lite-lists');
});

/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Clash-to-BCF export must carry the clashing pair as "found objects" (#4806).
 *
 * `ClashPanel`'s `createBcfTopic` calls `focusClash`, which — deliberately,
 * per #1277/#1339 — calls `state.clearEntitySelection()` and paints the pair
 * only through the clash-highlight colour channel, NOT the selection. It
 * then calls `createViewpointFromState({ includeSelection: true, ... })`.
 * `createViewpointFromState` derived `selectedGuids` only from
 * `selectedEntityId`/`selectedEntityIds`, which are empty right after
 * `clearEntitySelection()` — so the exported viewpoint's `<Selection>` was
 * entirely ABSENT, not merely empty. A recipient opening the BCF topic in
 * any tool sees the camera framing and the colour tint, but no "found
 * objects" list at all — the reported symptom.
 *
 * The fix threads the clash pair's refs into `createViewpointFromState`
 * independent of the live viewer selection (`additionalSelectedRefs`), and
 * separately records the on-screen amber/cyan clash colours as BCF
 * `<Coloring>` (`additionalColoredRefs`) so the exported topic matches what
 * the user sees. Neither channel may be gated behind — or read from —
 * `selectedEntityId`/`selectedEntityIds`, or this regresses the instant the
 * live selection is (correctly, per #1277/#1339) empty.
 */

import '@/test/setup-dom.js';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import JSZip from 'jszip';
import type { Renderer } from '@ifc-lite/renderer';
import type { IfcDataStore } from '@ifc-lite/parser';
import { writeBCF, type BCFProject, type BCFViewpoint } from '@ifc-lite/bcf';
import { useViewerStore, type ViewerState } from '@/store';
import { useBCF } from './useBCF.js';

/** Express ids behind the two clashing entities, and their IFC GlobalIds. */
const CLASH_A_ID = 501;
const CLASH_B_ID = 502;
const CLASH_A_ALIAS_ID = 503;
const CLASH_A_GUID = 'CLASH0A0000000000000A';
const CLASH_B_GUID = 'CLASH0B0000000000000B';

const dataStore = {
  entities: {
    getGlobalId: (expressId: number): string | undefined => {
      if (expressId === CLASH_A_ID || expressId === CLASH_A_ALIAS_ID) return CLASH_A_GUID;
      if (expressId === CLASH_B_ID) return CLASH_B_GUID;
      return undefined;
    },
    getExpressIdByGlobalId: (): number | undefined => undefined,
  },
} as unknown as IfcDataStore;

let submittedWork: Promise<void> = Promise.resolve();
const renderer = {
  getGPUDevice: () => ({ queue: { onSubmittedWorkDone: () => submittedWork } }),
  getCamera: () => ({
    getPosition: () => ({ x: 10, y: 5, z: 20 }),
    getTarget: () => ({ x: 1, y: 2, z: 3 }),
    getUp: () => ({ x: 0, y: 1, z: 0 }),
    getFOV: () => Math.PI / 4,
    getAspect: () => 16 / 9,
    getDistance: () => 10,
  }),
} as unknown as Renderer;

let api: ReturnType<typeof useBCF> | null = null;
let root: Root | null = null;

function Probe(): null {
  api = useBCF({
    rendererRef: { current: renderer },
    canvasRef: { current: { toDataURL: () => 'data:image/png;base64,c25hcHNob3Q=' } as HTMLCanvasElement },
  });
  return null;
}

beforeEach(async () => {
  submittedWork = Promise.resolve();
  useViewerStore.setState({
    models: new Map(),
    ifcDataStore: dataStore,
    isolatedEntities: null,
    ghostExceptEntities: null,
    hiddenEntities: new Set(),
    mutationViews: new Map(),
    // The state left behind by `focusClash`: selection cleared, pair only
    // painted via the highlight channel.
    selectedEntityId: null,
    selectedEntityIds: new Set(),
  });
  const container = globalThis.document.createElement('div');
  globalThis.document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(<Probe />);
  });
  assert.ok(api, 'the probe must be mounted');
});

afterEach(async () => {
  const current = root;
  root = null;
  api = null;
  if (current) await act(async () => current.unmount());
});

/** Wrap one viewpoint in the smallest BCF 3.0 project `writeBCF` accepts. */
function projectAround(viewpoint: BCFViewpoint): BCFProject {
  return {
    version: '3.0',
    projectId: '99999999-9999-4999-8999-999999999999',
    name: 'Clash report',
    topics: new Map([
      [
        '11111111-1111-4111-8111-111111111111',
        {
          guid: '11111111-1111-4111-8111-111111111111',
          title: 'Clash: A x B',
          topicType: 'Clash',
          topicStatus: 'Open',
          creationDate: '2026-01-02T03:04:05Z',
          creationAuthor: 'author@example.invalid',
          comments: [],
          viewpoints: [viewpoint],
        },
      ],
    ]),
  };
}

async function viewpointBcfvXml(viewpoint: BCFViewpoint): Promise<string> {
  const blob = await writeBCF(projectAround(viewpoint));
  const zip = await JSZip.loadAsync(await blob.arrayBuffer());
  const entry = Object.keys(zip.files).find((name) => name.endsWith('viewpoint.bcfv'));
  assert.ok(entry, 'the archive must contain a viewpoint.bcfv entry');
  const xml = await zip.file(entry!)?.async('string');
  assert.ok(xml, 'viewpoint.bcfv must have content');
  return xml!;
}

describe('useBCF — clash-to-BCF export carries the clashing pair (#4806)', () => {
  it('carries the two clashing entities as found objects, not an empty selection', async () => {
    const captured: (BCFViewpoint | null)[] = [];
    await act(async () => {
      captured.push(
        await api!.createViewpointFromState({
          includeSnapshot: false,
          includeSelection: true,
          includeHidden: false,
          additionalSelectedRefs: [CLASH_A_ID, CLASH_B_ID],
        }),
      );
    });
    const viewpoint = captured[0];
    assert.ok(viewpoint, 'a viewpoint must be produced');

    const guids = new Set((viewpoint.components?.selection ?? []).map((c) => c.ifcGuid));
    assert.deepEqual(
      guids,
      new Set([CLASH_A_GUID, CLASH_B_GUID]),
      'BUG: the exported viewpoint carries an empty selection instead of the clashing pair',
    );
  });

  it('does not depend on the live viewer selection at all (the state focusClash leaves behind)', async () => {
    // Sanity: the live selection really is empty, matching what `focusClash`
    // leaves behind (#1277/#1339) — this is not testing a fixture mistake.
    assert.equal(useViewerStore.getState().selectedEntityId, null);
    assert.equal(useViewerStore.getState().selectedEntityIds.size, 0);

    const captured: (BCFViewpoint | null)[] = [];
    await act(async () => {
      captured.push(
        await api!.createViewpointFromState({
          includeSnapshot: false,
          includeSelection: true,
          additionalSelectedRefs: [CLASH_A_ID, CLASH_B_ID],
        }),
      );
    });
    const viewpoint = captured[0];
    assert.ok(viewpoint, 'a viewpoint must be produced');
    assert.equal(
      viewpoint.components?.selection?.length,
      2,
      'the clash pair must be recorded even though nothing is live-selected',
    );
  });

  it('writes an actual <Selection> element into viewpoint.bcfv — absent, not merely empty, is the real bug', async () => {
    const captured: (BCFViewpoint | null)[] = [];
    await act(async () => {
      captured.push(
        await api!.createViewpointFromState({
          includeSnapshot: false,
          includeSelection: true,
          additionalSelectedRefs: [CLASH_A_ID, CLASH_B_ID],
        }),
      );
    });
    const viewpoint = captured[0];
    assert.ok(viewpoint, 'a viewpoint must be produced');
    const xml = await viewpointBcfvXml(viewpoint);
    assert.match(xml, /<Selection>/, 'BUG: <Selection> is entirely absent from the serialised viewpoint');
    assert.match(xml, new RegExp(CLASH_A_GUID));
    assert.match(xml, new RegExp(CLASH_B_GUID));
  });

  it('does not duplicate a guid already present in the live selection', async () => {
    // Wrapped in `act` so the hook's subscribed selectors (and therefore
    // `createViewpointFromState`'s closure) actually pick up the new
    // selection before the assertion below runs — a bare `setState` here
    // left the callback holding the PRE-selection closure and made this
    // test pass regardless of the dedup guard, defeating its purpose.
    await act(async () => {
      useViewerStore.setState({ selectedEntityId: CLASH_A_ID, selectedEntityIds: new Set([CLASH_A_ID]) });
    });

    const captured: (BCFViewpoint | null)[] = [];
    await act(async () => {
      captured.push(
        await api!.createViewpointFromState({
          includeSnapshot: false,
          includeSelection: true,
          // CLASH_A_ID is ALREADY in the live selection above; this must not
          // produce two <Selection> entries for the same GlobalId.
          additionalSelectedRefs: [CLASH_A_ID, CLASH_B_ID],
        }),
      );
    });
    const viewpoint = captured[0];
    assert.ok(viewpoint, 'a viewpoint must be produced');
    assert.equal(
      viewpoint.components?.selection?.length,
      2,
      'BUG: the same GlobalId was written twice instead of deduped across the live selection and the clash pair',
    );
  });

  it('records the on-screen clash colours as BCF Coloring', async () => {
    const captured: (BCFViewpoint | null)[] = [];
    await act(async () => {
      captured.push(
        await api!.createViewpointFromState({
          includeSnapshot: false,
          includeSelection: true,
          additionalSelectedRefs: [CLASH_A_ID, CLASH_B_ID],
          additionalColoredRefs: [
            { color: 'FFFF8000', refs: [CLASH_A_ID] },
            { color: 'FF00D1FF', refs: [CLASH_B_ID] },
          ],
        }),
      );
    });
    const viewpoint = captured[0];
    assert.ok(viewpoint, 'a viewpoint must be produced');
    const coloring = viewpoint.components?.coloring ?? [];
    assert.equal(coloring.length, 2, 'both clash colours must be recorded');
    const byColor = new Map(coloring.map((c) => [c.color, c.components.map((comp) => comp.ifcGuid)]));
    assert.deepEqual(byColor.get('FFFF8000'), [CLASH_A_GUID]);
    assert.deepEqual(byColor.get('FF00D1FF'), [CLASH_B_GUID]);

    const xml = await viewpointBcfvXml(viewpoint);
    assert.match(xml, /<Coloring>/);
    assert.match(xml, /Color="FFFF8000"/);
    assert.match(xml, /Color="FF00D1FF"/);
  });

  it('keeps the first color when distinct federated refs resolve to the same GlobalId', async () => {
    const viewpoint = await api!.createViewpointFromState({
      includeSnapshot: false,
      includeSelection: false,
      additionalColoredRefs: [
        { color: 'FFFF8000', refs: [CLASH_A_ID] },
        { color: 'FF00D1FF', refs: [CLASH_A_ALIAS_ID, CLASH_B_ID] },
      ],
    });
    assert.ok(viewpoint, 'a viewpoint must be produced');
    assert.deepEqual(
      viewpoint.components?.coloring?.map((group) => ({
        color: group.color,
        guids: group.components.map((component) => component.ifcGuid),
      })),
      [
        { color: 'FFFF8000', guids: [CLASH_A_GUID] },
        { color: 'FF00D1FF', guids: [CLASH_B_GUID] },
      ],
    );
  });

  it('keeps model identity when two loaded models use the same renderer id (#4921)', async () => {
    const ordinaryGuid = 'ORDINARY00000000000001';
    const roomGuid = 'ROOMMODEL0000000000001';
    const model = (id: string, guid: string) => ({
      id, name: id, idOffset: 0, maxExpressId: CLASH_A_ID,
      ifcDataStore: {
        entities: { getGlobalId: (expressId: number) => expressId === CLASH_A_ID ? guid : undefined },
      },
      geometryResult: null, loadedAt: 0,
    });
    await act(async () => {
      useViewerStore.setState({
        models: new Map([
          ['ordinary', model('ordinary', ordinaryGuid)],
          ['room:r:m0', model('room:r:m0', roomGuid)],
        ]) as unknown as ViewerState['models'],
        ifcDataStore: null,
        isolatedEntities: new Set([CLASH_A_ID]),
      });
    });

    const ordinaryRef = { modelId: 'ordinary', expressId: CLASH_A_ID };
    const roomRef = { modelId: 'room:r:m0', expressId: CLASH_A_ID };
    const viewpoint = await api!.createViewpointFromState({
      includeSnapshot: false,
      includeSelection: false,
      additionalSelectedRefs: [ordinaryRef, roomRef],
      additionalColoredRefs: [
        { color: 'FFFF8000', refs: [ordinaryRef] },
        { color: 'FF00D1FF', refs: [roomRef] },
      ],
      additionalVisibleGuids: [ordinaryGuid, roomGuid],
    });

    assert.ok(viewpoint, 'a viewpoint must be produced');
    assert.deepEqual(
      viewpoint.components?.selection?.map((component) => component.ifcGuid),
      [ordinaryGuid, roomGuid],
      'BUG: reducing both refs to renderer id 501 resolves both through the first model',
    );
    assert.deepEqual(
      viewpoint.components?.coloring?.map((group) => ({
        color: group.color,
        guids: group.components.map((component) => component.ifcGuid),
      })),
      [
        { color: 'FFFF8000', guids: [ordinaryGuid] },
        { color: 'FF00D1FF', guids: [roomGuid] },
      ],
    );
    assert.deepEqual(
      viewpoint.components?.visibility?.exceptions?.map((component) => component.ifcGuid),
      [ordinaryGuid, roomGuid],
      'model-bound group GUIDs survive a collapsed numeric isolation id',
    );
  });

  it('keeps exact isolation GUIDs and reports another hydrated owner without one (#4921)', async (t) => {
    const warn = t.mock.method(console, 'warn', () => undefined);
    const roomGuid = 'ROOMMODEL0000000000001';
    const model = (id: string, guid: string | undefined) => ({
      id, name: id, idOffset: 0, maxExpressId: CLASH_A_ID,
      ifcDataStore: {
        entities: { getGlobalId: (expressId: number) => expressId === CLASH_A_ID ? guid : undefined },
      },
      geometryResult: null, loadedAt: 0,
    });
    await act(async () => {
      useViewerStore.setState({
        models: new Map([
          ['ordinary', model('ordinary', undefined)],
          ['room:r:m0', model('room:r:m0', roomGuid)],
        ]) as unknown as ViewerState['models'],
        ifcDataStore: null,
        isolatedEntities: new Set([CLASH_A_ID]),
      });
    });

    const viewpoint = await api!.createViewpointFromState({
      includeSnapshot: false,
      includeSelection: false,
      additionalVisibleGuids: [roomGuid],
    });

    assert.deepEqual(
      viewpoint?.components?.visibility?.exceptions?.map((component) => component.ifcGuid),
      [roomGuid],
      'an exact model-bound GUID makes a numerically unnameable isolation recordable',
    );
    assert.ok(warn.mock.calls.some((call) => String(call.arguments[0]).includes(
      '1 of 1 isolated entities have no resolvable IFC GlobalId',
    )), 'the hydrated owner without a GlobalId must not disappear from capture diagnostics');
  });

  it('includes a StoreEditor-created clash member in selection, coloring, and isolation (#4921)', async () => {
    const overlayId = 900;
    const overlayGuid = 'AUTHORED00000000000001';
    await act(async () => {
      useViewerStore.setState({
        models: new Map([
          ['ordinary', {
            id: 'ordinary', name: 'ordinary', idOffset: 0, maxExpressId: CLASH_B_ID,
            ifcDataStore: dataStore, geometryResult: null, loadedAt: 0,
          }],
        ]) as unknown as ViewerState['models'],
        ifcDataStore: null,
        isolatedEntities: new Set([overlayId]),
        mutationViews: new Map([
          ['ordinary', {
            getNewEntity: (expressId: number) => expressId === overlayId
              ? { attributes: [overlayGuid] }
              : null,
          }],
        ]) as unknown as ViewerState['mutationViews'],
      });
    });

    const overlayRef = { modelId: 'ordinary', expressId: overlayId };
    const viewpoint = await api!.createViewpointFromState({
      includeSnapshot: false,
      includeSelection: false,
      additionalSelectedRefs: [overlayRef],
      additionalColoredRefs: [{ color: 'FFFF8000', refs: [overlayRef] }],
    });

    assert.deepEqual(viewpoint?.components?.selection?.map((component) => component.ifcGuid), [overlayGuid]);
    assert.deepEqual(
      viewpoint?.components?.coloring?.[0]?.components.map((component) => component.ifcGuid),
      [overlayGuid],
    );
    assert.equal(viewpoint?.components?.visibility?.defaultVisibility, false);
    assert.deepEqual(
      viewpoint?.components?.visibility?.exceptions?.map((component) => component.ifcGuid),
      [overlayGuid],
      'the overlay-aware resolver must preserve an authored entity in the isolation allowlist',
    );
  });

  it('binds exact refs before an awaited snapshot can replace their model revision (#4921)', async () => {
    const oldGuid = 'OLDREVISION000000000001';
    const newGuid = 'NEWREVISION000000000001';
    const model = (guid: string) => ({
      id: 'ordinary', name: 'ordinary', idOffset: 0, maxExpressId: CLASH_A_ID,
      ifcDataStore: {
        entities: { getGlobalId: (expressId: number) => expressId === CLASH_A_ID ? guid : undefined },
      },
      geometryResult: null, loadedAt: 0,
    });
    await act(async () => {
      useViewerStore.setState({
        models: new Map([['ordinary', model(oldGuid)]]) as unknown as ViewerState['models'],
        ifcDataStore: null,
      });
    });
    let finishSnapshot!: () => void;
    submittedWork = new Promise<void>((resolve) => { finishSnapshot = resolve; });
    const exactRef = { modelId: 'ordinary', expressId: CLASH_A_ID };
    const capture = api!.createViewpointFromState({
      includeSnapshot: true,
      includeSelection: false,
      additionalSelectedRefs: [exactRef],
      additionalColoredRefs: [{ color: 'FFFF8000', refs: [exactRef] }],
    });
    await Promise.resolve();
    const viewpoints: (BCFViewpoint | null)[] = [];
    await act(async () => {
      useViewerStore.setState({
        models: new Map([['ordinary', model(newGuid)]]) as unknown as ViewerState['models'],
      });
      finishSnapshot();
      viewpoints.push(await capture);
    });
    const viewpoint = viewpoints[0];

    assert.deepEqual(viewpoint?.components?.selection?.map((component) => component.ifcGuid), [oldGuid]);
    assert.deepEqual(
      viewpoint?.components?.coloring?.[0]?.components.map((component) => component.ifcGuid),
      [oldGuid],
      'BUG: the old ref was retargeted to a replacement model while snapshot capture awaited the GPU',
    );
  });

  it('serializes caller-bound group GUIDs without consulting a replacement model (#4921)', async () => {
    const boundGuid = 'FOCUSEDREVISION00000001';
    const viewpoint = await api!.createViewpointFromState({
      includeSnapshot: false,
      includeSelection: false,
      additionalSelectedGuids: [boundGuid],
      additionalColoredGuids: [{ color: 'FFFF8000', guids: [boundGuid] }],
    });

    assert.deepEqual(viewpoint?.components?.selection?.map((component) => component.ifcGuid), [boundGuid]);
    assert.deepEqual(
      viewpoint?.components?.coloring?.[0]?.components.map((component) => component.ifcGuid),
      [boundGuid],
    );
  });

  it('aborts when the bound scene revision changes during snapshot capture (#4921)', async () => {
    let finishSnapshot!: () => void;
    let valid = true;
    submittedWork = new Promise<void>((resolve) => { finishSnapshot = resolve; });
    const capture = api!.createViewpointFromState({
      includeSnapshot: true,
      includeSelection: false,
      additionalSelectedGuids: [CLASH_A_GUID],
      isCaptureStillValid: () => valid,
    });
    await Promise.resolve();

    const viewpoints: (BCFViewpoint | null)[] = [];
    await act(async () => {
      valid = false;
      finishSnapshot();
      viewpoints.push(await capture);
    });

    assert.equal(viewpoints[0], null,
      'a snapshot painted from another model revision must not be paired with the old component GUIDs');
  });

  it('reports visibility source models from the exact component snapshot (#4921)', async () => {
    const sharedGuid = 'SHAREDREVISION000000001';
    const model = (id: string) => ({
      id, name: `${id}.ifc`, idOffset: 0, maxExpressId: CLASH_A_ID,
      ifcDataStore: {
        entities: { getGlobalId: (expressId: number) => expressId === CLASH_A_ID ? sharedGuid : undefined },
      },
      geometryResult: null, loadedAt: 0,
    });
    await act(async () => {
      useViewerStore.setState({
        models: new Map([
          ['old-revision', model('old-revision')],
          ['visible-revision', model('visible-revision')],
        ]) as unknown as ViewerState['models'],
        ifcDataStore: null,
        hiddenEntities: new Set([CLASH_A_ID]),
        hiddenEntitiesByModel: new Map([['visible-revision', new Set([CLASH_A_ID])]]),
      });
    });
    const capturedModelIds: string[][] = [];
    const viewpoint = await api!.createViewpointFromState({
      includeSnapshot: false,
      includeSelection: false,
      includeHidden: true,
      onVisibilityModelIdsCaptured: (modelIds) => capturedModelIds.push([...modelIds]),
    });

    assert.deepEqual(viewpoint?.components?.visibility?.exceptions?.map((component) => component.ifcGuid), [sharedGuid]);
    assert.deepEqual(new Set(capturedModelIds[0]), new Set(['old-revision', 'visible-revision']),
      'the exact hidden-model source must survive ambiguous shared GlobalIds');
  });
});

/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Inbound postMessage bridge tests.
 *
 * This is the embed side of the iframe trust boundary: it decides which
 * senders are listened to, which commands run, and — critically — which
 * origin replies are addressed to. Those decisions are pinned in BOTH
 * directions here (accepted and dropped, latched and not latched) so a
 * silent relaxation of the boundary fails the suite.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The bridge only needs one value from the viewer store barrel; importing the
// real barrel would drag in zustand + renderer + wasm. Mirror the real
// implementation (apps/viewer/src/store/globalId.ts) exactly.
vi.mock('@/store/index.js', () => ({
  toGlobalIdFromModels: (
    models: ReadonlyMap<string, { idOffset?: number }>,
    modelId: string,
    expressId: number,
  ): number => {
    if (modelId === 'legacy' || modelId === 'default' || modelId === '__legacy__') return expressId;
    const model = models.get(modelId);
    if (!model) return expressId;
    return expressId + (model.idOffset ?? 0);
  },
}));

import { EMBED_SOURCE, PROTOCOL_VERSION } from '@ifc-lite/embed-protocol';
import { initBridge, destroyBridge, emitEvent, emitToParent } from './handler.js';

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

interface Posted {
  msg: any;
  targetOrigin: string;
  transfer: unknown;
}

interface FakeWindow {
  posted: Posted[];
  listenerCount: () => number;
  dispatch: (event: { data: unknown; origin: string }) => void;
  /** Grab the live listeners so a message can be replayed after teardown. */
  captureListeners: () => Array<(e: unknown) => void>;
}

function installWindow({ inIframe = true }: { inIframe?: boolean } = {}): FakeWindow {
  const posted: Posted[] = [];
  const listeners = new Set<(e: unknown) => void>();
  const win: any = {
    addEventListener: (type: string, fn: (e: unknown) => void) => {
      if (type === 'message') listeners.add(fn);
    },
    removeEventListener: (type: string, fn: (e: unknown) => void) => {
      if (type === 'message') listeners.delete(fn);
    },
  };
  win.parent = inIframe
    ? {
        postMessage: (msg: any, targetOrigin: string, transfer: unknown) => {
          posted.push({ msg, targetOrigin, transfer });
        },
      }
    : win;
  (globalThis as any).window = win;
  return {
    posted,
    listenerCount: () => listeners.size,
    captureListeners: () => [...listeners],
    dispatch: (event) => {
      for (const fn of [...listeners]) fn(event);
    },
  };
}

/** Minimal entity table stand-in used by SELECT_BY_GUID / GET_PROPERTIES. */
function makeEntities(rows: Record<number, { globalId: string; name: string; type: string }>) {
  return {
    count: Object.keys(rows).length,
    getExpressIdByGlobalId: (guid: string) => {
      for (const [id, row] of Object.entries(rows)) {
        if (row.globalId === guid) return Number(id);
      }
      return -1;
    },
    getTypeName: (id: number) => rows[id]?.type,
    getName: (id: number) => rows[id]?.name,
    getGlobalId: (id: number) => rows[id]?.globalId,
    getDescription: (_id: number) => undefined,
    getObjectType: (_id: number) => undefined,
  };
}

function makeState() {
  const calls: Array<[string, ...unknown[]]> = [];
  const rec = (name: string) => (...args: unknown[]) => { calls.push([name, ...args]); };
  const entities = makeEntities({
    5: { globalId: 'GUID-A', name: 'Wall A', type: 'IfcWall' },
    7: { globalId: 'GUID-B', name: 'Slab B', type: 'IfcSlab' },
  });
  const models = new Map<string, any>([
    ['m1', {
      id: 'm1',
      name: 'model-one.ifc',
      idOffset: 1000,
      visible: true,
      ifcDataStore: { entities },
      geometryResult: { totalTriangles: 42 },
    }],
  ]);
  const state: any = {
    models,
    entities,
    calls,
    sectionPlane: { enabled: false, flipped: false },
    typeVisibility: { spaces: true, openings: false, site: true },
    cameraCallbacks: {
      frameSelection: rec('frameSelection'),
      fitAll: rec('fitAll'),
      setPresetView: rec('setPresetView'),
    },
    setTheme: rec('setTheme'),
    removeModel: rec('removeModel'),
    clearEntitySelection: rec('clearEntitySelection'),
    setSelectedEntityId: rec('setSelectedEntityId'),
    setSelectedEntityIds: rec('setSelectedEntityIds'),
    isolateEntities: rec('isolateEntities'),
    hideEntities: rec('hideEntities'),
    showEntities: rec('showEntities'),
    showAllInAllModels: rec('showAllInAllModels'),
    updateMeshColors: rec('updateMeshColors'),
    clearPendingColorUpdates: rec('clearPendingColorUpdates'),
    setCameraRotation: rec('setCameraRotation'),
    setSectionPlaneAxis: rec('setSectionPlaneAxis'),
    setSectionPlanePosition: rec('setSectionPlanePosition'),
    toggleSectionPlane: rec('toggleSectionPlane'),
    flipSectionPlane: rec('flipSectionPlane'),
    toggleTypeVisibility: rec('toggleTypeVisibility'),
    resolveGlobalIdFromModels: (id: number) =>
      id === 1005 ? { modelId: 'm1', expressId: 5 } : undefined,
  };
  return state;
}

function makeCtx(state: any, overrides: Partial<Record<string, any>> = {}) {
  return {
    getState: () => state,
    loadModelFromUrl: overrides.loadModelFromUrl
      ?? vi.fn(async () => ({ entities: 1, triangles: 2, vertices: 3 })),
    loadModelFromBuffer: overrides.loadModelFromBuffer
      ?? vi.fn(async () => ({ entities: 4, triangles: 5, vertices: 6 })),
  };
}

const PARENT = 'https://host.example';
const EVIL = 'https://evil.example';

function cmd(type: string, data?: unknown, requestId?: string) {
  return { source: EMBED_SOURCE, version: PROTOCOL_VERSION, type, requestId, data };
}

/** Post a message and let the async handleCommand chain settle. */
async function send(
  fw: FakeWindow,
  message: unknown,
  origin = PARENT,
) {
  fw.dispatch({ data: message, origin });
  // handleCommand is async; two macrotask hops cover the awaited load paths.
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
}

const names = (posted: Posted[]) => posted.map((p) => p.msg.type);
const called = (state: any, name: string) => state.calls.some(([n]: [string]) => n === name);
const argsOf = (state: any, name: string) =>
  state.calls.find(([n]: [string]) => n === name)?.slice(1);

let fw: FakeWindow;
let state: any;

beforeEach(() => {
  fw = installWindow();
  state = makeState();
});

afterEach(() => {
  destroyBridge();
  delete (globalThis as any).window;
});

// ---------------------------------------------------------------------------
// Origin filtering
// ---------------------------------------------------------------------------

describe('inbound origin filtering', () => {
  it('accepts commands from ANY origin when no allowlist is configured', async () => {
    initBridge(makeCtx(state));
    await send(fw, cmd('SHOW_ALL', undefined, 'r1'), EVIL);
    // This is the documented fail-open default. If it ever changes, this test
    // is the one that must be updated deliberately.
    expect(called(state, 'showAllInAllModels')).toBe(true);
  });

  it('drops commands from an origin outside a configured allowlist', async () => {
    initBridge(makeCtx(state), { allowedOrigins: [PARENT] });
    await send(fw, cmd('SHOW_ALL', undefined, 'r1'), EVIL);
    expect(called(state, 'showAllInAllModels')).toBe(false);
    // Nothing beyond the READY handshake goes out either.
    expect(names(fw.posted)).toEqual(['READY']);
  });

  it('accepts commands from an origin on the allowlist', async () => {
    initBridge(makeCtx(state), { allowedOrigins: [EVIL, PARENT] });
    await send(fw, cmd('SHOW_ALL', undefined, 'r1'), PARENT);
    expect(called(state, 'showAllInAllModels')).toBe(true);
  });

  it('matches allowlist entries exactly, not by prefix or suffix', async () => {
    initBridge(makeCtx(state), { allowedOrigins: ['https://app.example.com'] });
    await send(fw, cmd('SHOW_ALL', undefined, 'r1'), 'https://app.example.com.evil.test');
    await send(fw, cmd('SHOW_ALL', undefined, 'r2'), 'https://evil.https://app.example.com');
    await send(fw, cmd('SHOW_ALL', undefined, 'r3'), 'http://app.example.com');
    expect(called(state, 'showAllInAllModels')).toBe(false);
  });

  it('does not latch the outbound origin from a rejected sender', async () => {
    initBridge(makeCtx(state), { allowedOrigins: [PARENT] });
    await send(fw, cmd('SHOW_ALL', undefined, 'r1'), EVIL);
    emitEvent('MODEL_LOADED', { entities: 1, triangles: 1, vertices: 1 });
    // Still '*' internally, so the content event is withheld entirely.
    expect(names(fw.posted)).toEqual(['READY']);
  });
});

// ---------------------------------------------------------------------------
// Envelope / discriminator validation
// ---------------------------------------------------------------------------

describe('envelope validation', () => {
  it.each([
    ['null', null],
    ['a string', 'SHOW_ALL'],
    ['a number', 7],
    ['no source field', { version: PROTOCOL_VERSION, type: 'SHOW_ALL', requestId: 'r' }],
    ['a foreign source', { source: 'other-widget', type: 'SHOW_ALL', requestId: 'r' }],
  ])('ignores a message that is %s', async (_label, payload) => {
    initBridge(makeCtx(state));
    await send(fw, payload);
    expect(called(state, 'showAllInAllModels')).toBe(false);
    expect(names(fw.posted)).toEqual(['READY']);
  });

  it('accepts a well-formed envelope (control for the rejection cases above)', async () => {
    initBridge(makeCtx(state));
    await send(fw, cmd('SHOW_ALL', undefined, 'r1'));
    expect(called(state, 'showAllInAllModels')).toBe(true);
  });

  it('ignores messages before initBridge and after destroyBridge', async () => {
    initBridge(makeCtx(state));
    destroyBridge();
    await send(fw, cmd('SHOW_ALL', undefined, 'r1'));
    expect(called(state, 'showAllInAllModels')).toBe(false);
    expect(fw.listenerCount()).toBe(0);
  });

  it('runs no command against a torn-down context', async () => {
    initBridge(makeCtx(state));
    // Hold the listener across teardown, then replay a command through it. In
    // the DOM this models a handler reference that outlives destroyBridge; the
    // `!ctx` guard is what stops it reaching the store.
    const listeners = fw.captureListeners();
    destroyBridge();
    for (const fn of listeners) fn({ data: cmd('SHOW_ALL', undefined, 'r1'), origin: PARENT });
    await new Promise((r) => setTimeout(r, 0));
    expect(called(state, 'showAllInAllModels')).toBe(false);
    expect(names(fw.posted)).toEqual(['READY']);
  });
});

// ---------------------------------------------------------------------------
// Parent-origin capture state machine
// ---------------------------------------------------------------------------

describe('parent origin capture', () => {
  it('broadcasts only READY to "*" and withholds content events', () => {
    initBridge(makeCtx(state));
    expect(fw.posted).toHaveLength(1);
    expect(fw.posted[0].msg.type).toBe('READY');
    expect(fw.posted[0].targetOrigin).toBe('*');
    expect(fw.posted[0].msg.data).toEqual({ version: PROTOCOL_VERSION });

    emitEvent('MODEL_LOADED', { entities: 1, triangles: 2, vertices: 3 });
    emitEvent('ENTITY_SELECTED', { id: 1 });
    expect(fw.posted).toHaveLength(1);
  });

  it('latches the first accepted inbound origin as the outbound target', async () => {
    initBridge(makeCtx(state));
    await send(fw, cmd('SHOW_ALL', undefined, 'r1'), PARENT);
    const response = fw.posted.at(-1)!;
    expect(response.msg.type).toBe('RESPONSE');
    expect(response.targetOrigin).toBe(PARENT);

    emitEvent('MODEL_LOADED', { entities: 1, triangles: 2, vertices: 3 });
    expect(fw.posted.at(-1)!.targetOrigin).toBe(PARENT);
  });

  it.each(['null', '*', ''])('does not latch the opaque origin %j', async (origin) => {
    initBridge(makeCtx(state));
    await send(fw, cmd('SHOW_ALL', undefined, 'r1'), origin);
    // The command still ran (no allowlist) but nothing was addressable...
    expect(called(state, 'showAllInAllModels')).toBe(true);
    expect(names(fw.posted)).toEqual(['READY']);
    // ...and a later concrete origin can still be adopted.
    await send(fw, cmd('SHOW_ALL', undefined, 'r2'), PARENT);
    expect(fw.posted.at(-1)!.targetOrigin).toBe(PARENT);
  });

  it('latches exactly once — a later origin cannot re-target the channel', async () => {
    initBridge(makeCtx(state));
    await send(fw, cmd('SHOW_ALL', undefined, 'r1'), EVIL);
    await send(fw, cmd('SHOW_ALL', undefined, 'r2'), PARENT);
    // Documents the current (fail-open) behaviour: the FIRST sender wins and
    // every later reply is addressed to it. See the security note in the PR.
    expect(fw.posted.at(-1)!.targetOrigin).toBe(EVIL);
  });

  it('seeds the outbound target from expectedParentOrigin, including for READY', () => {
    initBridge(makeCtx(state), { expectedParentOrigin: PARENT });
    expect(fw.posted[0].targetOrigin).toBe(PARENT);
    emitEvent('MODEL_LOADED', { entities: 1, triangles: 2, vertices: 3 });
    expect(fw.posted.at(-1)!.targetOrigin).toBe(PARENT);
  });

  it.each(['null', '*', ''])('ignores the seed value %j', (seed) => {
    initBridge(makeCtx(state), { expectedParentOrigin: seed });
    expect(fw.posted[0].targetOrigin).toBe('*');
    emitEvent('MODEL_LOADED', { entities: 1, triangles: 2, vertices: 3 });
    expect(names(fw.posted)).toEqual(['READY']);
  });

  it('lets the first inbound origin supersede a stale seed', async () => {
    initBridge(makeCtx(state), { expectedParentOrigin: 'https://stale.example' });
    expect(fw.posted[0].targetOrigin).toBe('https://stale.example');
    await send(fw, cmd('SHOW_ALL', undefined, 'r1'), PARENT);
    expect(fw.posted.at(-1)!.targetOrigin).toBe(PARENT);
  });

  it('resets the captured origin on destroyBridge', async () => {
    initBridge(makeCtx(state));
    await send(fw, cmd('SHOW_ALL', undefined, 'r1'), PARENT);
    destroyBridge();
    initBridge(makeCtx(state));
    expect(fw.posted.at(-1)!.msg.type).toBe('READY');
    expect(fw.posted.at(-1)!.targetOrigin).toBe('*');
  });

  it('posts nothing at all when not inside an iframe', async () => {
    destroyBridge();
    fw = installWindow({ inIframe: false });
    initBridge(makeCtx(state), { expectedParentOrigin: PARENT });
    await send(fw, cmd('SHOW_ALL', undefined, 'r1'), PARENT);
    expect(fw.posted).toHaveLength(0);
    expect(called(state, 'showAllInAllModels')).toBe(true);
  });

  it('passes an empty transfer list when none is supplied', () => {
    initBridge(makeCtx(state));
    expect(fw.posted[0].transfer).toEqual([]);
    const buf = new ArrayBuffer(4);
    emitToParent({ source: EMBED_SOURCE, version: PROTOCOL_VERSION, type: 'READY' }, [buf]);
    expect(fw.posted.at(-1)!.transfer).toEqual([buf]);
  });
});

// ---------------------------------------------------------------------------
// INIT handshake + token
// ---------------------------------------------------------------------------

describe('INIT', () => {
  it('ACKs with a RESPONSE then an INIT_ACK event, in that order', async () => {
    initBridge(makeCtx(state));
    await send(fw, cmd('INIT', { config: { theme: 'dark' } }, 'r1'));
    expect(names(fw.posted)).toEqual(['READY', 'RESPONSE', 'INIT_ACK']);
    expect(fw.posted[1].msg.responseId).toBe('r1');
    expect(fw.posted[1].msg.error).toBeUndefined();
    expect(argsOf(state, 'setTheme')).toEqual(['dark']);
  });

  it('emits INIT_ACK but no RESPONSE when there is no requestId', async () => {
    initBridge(makeCtx(state));
    await send(fw, cmd('INIT', {}));
    expect(names(fw.posted)).toEqual(['READY', 'INIT_ACK']);
  });

  it('does not touch the theme when config omits it', async () => {
    initBridge(makeCtx(state));
    await send(fw, cmd('INIT', { config: {} }, 'r1'));
    expect(called(state, 'setTheme')).toBe(false);
  });

  it('rejects a token mismatch without applying config or ACKing', async () => {
    initBridge(makeCtx(state), { initToken: 'secret' });
    await send(fw, cmd('INIT', { token: 'wrong', config: { theme: 'dark' } }, 'r1'));
    expect(names(fw.posted)).toEqual(['READY', 'RESPONSE']);
    expect(fw.posted[1].msg.error).toEqual({ code: 'UNAUTHORIZED', message: 'INIT token mismatch' });
    expect(fw.posted[1].msg.data).toBeUndefined();
    expect(called(state, 'setTheme')).toBe(false);
  });

  it('rejects a missing token when one is configured', async () => {
    initBridge(makeCtx(state), { initToken: 'secret' });
    await send(fw, cmd('INIT', { config: { theme: 'dark' } }, 'r1'));
    expect(fw.posted[1].msg.error?.code).toBe('UNAUTHORIZED');
  });

  it('stays silent on a token mismatch with no requestId', async () => {
    initBridge(makeCtx(state), { initToken: 'secret' });
    await send(fw, cmd('INIT', { token: 'wrong' }));
    expect(names(fw.posted)).toEqual(['READY']);
  });

  it('accepts a matching token', async () => {
    initBridge(makeCtx(state), { initToken: 'secret' });
    await send(fw, cmd('INIT', { token: 'secret', config: { theme: 'light' } }, 'r1'));
    expect(names(fw.posted)).toEqual(['READY', 'RESPONSE', 'INIT_ACK']);
    expect(argsOf(state, 'setTheme')).toEqual(['light']);
  });

  it('ignores a presented token when none is configured', async () => {
    initBridge(makeCtx(state));
    await send(fw, cmd('INIT', { token: 'anything' }, 'r1'));
    expect(names(fw.posted)).toEqual(['READY', 'RESPONSE', 'INIT_ACK']);
  });

  it('clears a previously configured token on destroyBridge', async () => {
    initBridge(makeCtx(state), { initToken: 'secret' });
    destroyBridge();
    initBridge(makeCtx(state));
    await send(fw, cmd('INIT', {}, 'r1'));
    expect(names(fw.posted).slice(-2)).toEqual(['RESPONSE', 'INIT_ACK']);
  });
});

// ---------------------------------------------------------------------------
// Command dispatch
// ---------------------------------------------------------------------------

describe('command dispatch', () => {
  it('answers an unknown command with UNKNOWN_COMMAND', async () => {
    initBridge(makeCtx(state));
    await send(fw, cmd('DROP_TABLES', {}, 'r1'));
    expect(fw.posted.at(-1)!.msg.error).toEqual({
      code: 'UNKNOWN_COMMAND',
      message: 'Unknown command: DROP_TABLES',
    });
  });

  it('stays silent on an unknown fire-and-forget command', async () => {
    initBridge(makeCtx(state));
    await send(fw, cmd('DROP_TABLES', {}));
    expect(names(fw.posted)).toEqual(['READY']);
  });

  it('reports a thrown command error as COMMAND_FAILED', async () => {
    const ctx = makeCtx(state, {
      loadModelFromUrl: vi.fn(async () => { throw new Error('boom'); }),
    });
    initBridge(ctx);
    await send(fw, cmd('LOAD_MODEL', { url: 'https://x.test/a.ifc' }, 'r1'));
    expect(fw.posted.at(-1)!.msg.error).toEqual({ code: 'COMMAND_FAILED', message: 'boom' });
    expect(fw.posted.at(-1)!.msg.responseId).toBe('r1');
  });

  it('stringifies a non-Error rejection', async () => {
    const ctx = makeCtx(state, {
      loadModelFromUrl: vi.fn(async () => { throw 'plain string'; }),
    });
    initBridge(ctx);
    await send(fw, cmd('LOAD_MODEL', { url: 'https://x.test/a.ifc' }, 'r1'));
    expect(fw.posted.at(-1)!.msg.error?.message).toBe('plain string');
  });

  it('swallows errors on fire-and-forget commands', async () => {
    const ctx = makeCtx(state, {
      loadModelFromUrl: vi.fn(async () => { throw new Error('boom'); }),
    });
    initBridge(ctx);
    await send(fw, cmd('LOAD_MODEL', { url: 'https://x.test/a.ifc' }));
    expect(names(fw.posted)).toEqual(['READY']);
  });

  it('LOAD_MODEL forwards the URL and returns the loader stats', async () => {
    const loadModelFromUrl = vi.fn(async () => ({ entities: 9, triangles: 8, vertices: 7 }));
    initBridge(makeCtx(state, { loadModelFromUrl }));
    await send(fw, cmd('LOAD_MODEL', { url: 'https://x.test/a.ifc' }, 'r1'));
    expect(loadModelFromUrl).toHaveBeenCalledWith('https://x.test/a.ifc');
    expect(fw.posted.at(-1)!.msg.data).toEqual({ entities: 9, triangles: 8, vertices: 7 });
  });

  it('ADD_MODEL tags the response with a modelId', async () => {
    initBridge(makeCtx(state));
    await send(fw, cmd('ADD_MODEL', { url: 'https://x.test/a.ifc' }, 'r1'));
    expect(fw.posted.at(-1)!.msg.data).toEqual({
      modelId: 'latest', entities: 1, triangles: 2, vertices: 3,
    });
  });

  it('REMOVE_MODEL forwards the modelId', async () => {
    initBridge(makeCtx(state));
    await send(fw, cmd('REMOVE_MODEL', { modelId: 'm1' }, 'r1'));
    expect(argsOf(state, 'removeModel')).toEqual(['m1']);
  });

  it('rejects LOAD_MODEL_BUFFER above the 500 MB ceiling', async () => {
    const loadModelFromBuffer = vi.fn(async () => ({ entities: 0, triangles: 0, vertices: 0 }));
    initBridge(makeCtx(state, { loadModelFromBuffer }));
    await send(fw, cmd('LOAD_MODEL_BUFFER', { byteLength: 500 * 1024 * 1024 + 1 }, 'r1'));
    expect(fw.posted.at(-1)!.msg.error).toEqual({
      code: 'COMMAND_FAILED',
      message: 'Model too large (500 MB). Max: 500 MB',
    });
    expect(loadModelFromBuffer).not.toHaveBeenCalled();
  });

  it('accepts LOAD_MODEL_BUFFER exactly at the ceiling', async () => {
    const loadModelFromBuffer = vi.fn(async () => ({ entities: 1, triangles: 1, vertices: 1 }));
    initBridge(makeCtx(state, { loadModelFromBuffer }));
    const buffer = { byteLength: 500 * 1024 * 1024 };
    await send(fw, cmd('LOAD_MODEL_BUFFER', buffer, 'r1'));
    expect(loadModelFromBuffer).toHaveBeenCalledWith(buffer);
    expect(fw.posted.at(-1)!.msg.data).toEqual({ entities: 1, triangles: 1, vertices: 1 });
  });
});

// ---------------------------------------------------------------------------
// Selection / visibility / appearance commands
// ---------------------------------------------------------------------------

describe('selection and visibility commands', () => {
  it('SELECT with ids sets both the primary and the full selection', async () => {
    initBridge(makeCtx(state));
    await send(fw, cmd('SELECT', { ids: [3, 4] }, 'r1'));
    expect(argsOf(state, 'setSelectedEntityId')).toEqual([3]);
    expect(argsOf(state, 'setSelectedEntityIds')).toEqual([[3, 4]]);
    expect(called(state, 'clearEntitySelection')).toBe(false);
  });

  it('SELECT with an empty id list clears the selection instead', async () => {
    initBridge(makeCtx(state));
    await send(fw, cmd('SELECT', { ids: [] }, 'r1'));
    expect(called(state, 'clearEntitySelection')).toBe(true);
    expect(called(state, 'setSelectedEntityId')).toBe(false);
  });

  it('CLEAR_SELECTION clears and responds', async () => {
    initBridge(makeCtx(state));
    await send(fw, cmd('CLEAR_SELECTION', undefined, 'r1'));
    expect(called(state, 'clearEntitySelection')).toBe(true);
    expect(fw.posted.at(-1)!.msg.responseId).toBe('r1');
  });

  it('SELECT_BY_GUID resolves GUIDs through the model id offset', async () => {
    initBridge(makeCtx(state));
    await send(fw, cmd('SELECT_BY_GUID', { guids: ['GUID-B', 'GUID-A'] }, 'r1'));
    expect(fw.posted.at(-1)!.msg.data).toEqual({ resolved: [1007, 1005] });
    expect(argsOf(state, 'setSelectedEntityId')).toEqual([1007]);
  });

  it('SELECT_BY_GUID skips unknown GUIDs and leaves the selection untouched', async () => {
    initBridge(makeCtx(state));
    await send(fw, cmd('SELECT_BY_GUID', { guids: ['nope'] }, 'r1'));
    expect(fw.posted.at(-1)!.msg.data).toEqual({ resolved: [] });
    expect(called(state, 'setSelectedEntityId')).toBe(false);
    expect(called(state, 'setSelectedEntityIds')).toBe(false);
  });

  it('SELECT_BY_GUID skips models with no entity table', async () => {
    state.models.set('m2', { id: 'm2', name: 'empty', idOffset: 5000, ifcDataStore: undefined });
    initBridge(makeCtx(state));
    await send(fw, cmd('SELECT_BY_GUID', { guids: ['GUID-A'] }, 'r1'));
    expect(fw.posted.at(-1)!.msg.data).toEqual({ resolved: [1005] });
  });

  it.each([
    ['ISOLATE', 'isolateEntities'],
    ['HIDE', 'hideEntities'],
    ['SHOW', 'showEntities'],
  ])('%s forwards its id list to %s', async (command, method) => {
    initBridge(makeCtx(state));
    await send(fw, cmd(command, { ids: [1, 2] }, 'r1'));
    expect(argsOf(state, method)).toEqual([[1, 2]]);
    expect(fw.posted.at(-1)!.msg.responseId).toBe('r1');
  });

  it('SHOW_ALL restores visibility across every model', async () => {
    initBridge(makeCtx(state));
    await send(fw, cmd('SHOW_ALL', undefined, 'r1'));
    expect(called(state, 'showAllInAllModels')).toBe(true);
  });

  it('SET_COLORS converts string keys to numeric entity ids', async () => {
    initBridge(makeCtx(state));
    await send(fw, cmd('SET_COLORS', { colorMap: { '12': [1, 0, 0, 1] } }, 'r1'));
    const [updates] = argsOf(state, 'updateMeshColors') as [Map<number, unknown>];
    expect([...updates.keys()]).toEqual([12]);
    expect(updates.get(12)).toEqual([1, 0, 0, 1]);
  });

  it('RESET_COLORS clears pending updates', async () => {
    initBridge(makeCtx(state));
    await send(fw, cmd('RESET_COLORS', undefined, 'r1'));
    expect(called(state, 'clearPendingColorUpdates')).toBe(true);
  });

  it('SET_TYPE_VISIBILITY toggles only the flags that actually differ', async () => {
    // Fixture state: spaces=true, openings=false, site=true.
    initBridge(makeCtx(state));
    await send(fw, cmd('SET_TYPE_VISIBILITY', { spaces: true, openings: true, site: false }, 'r1'));
    const toggled = state.calls
      .filter(([n]: [string]) => n === 'toggleTypeVisibility')
      .map(([, arg]: [string, string]) => arg);
    expect(toggled).toEqual(['openings', 'site']);
  });

  it('SET_TYPE_VISIBILITY ignores omitted flags', async () => {
    initBridge(makeCtx(state));
    await send(fw, cmd('SET_TYPE_VISIBILITY', {}, 'r1'));
    expect(called(state, 'toggleTypeVisibility')).toBe(false);
  });

  it('SET_THEME forwards the theme', async () => {
    initBridge(makeCtx(state));
    await send(fw, cmd('SET_THEME', { theme: 'dark' }, 'r1'));
    expect(argsOf(state, 'setTheme')).toEqual(['dark']);
  });
});

// ---------------------------------------------------------------------------
// Camera / section commands
// ---------------------------------------------------------------------------

describe('camera and section commands', () => {
  it('FIT_TO_VIEW with ids frames the selection', async () => {
    initBridge(makeCtx(state));
    await send(fw, cmd('FIT_TO_VIEW', { ids: [1] }, 'r1'));
    expect(argsOf(state, 'setSelectedEntityIds')).toEqual([[1]]);
    expect(called(state, 'frameSelection')).toBe(true);
    expect(called(state, 'fitAll')).toBe(false);
  });

  it.each([
    ['an empty id list', { ids: [] }],
    ['no payload at all', undefined],
  ])('FIT_TO_VIEW with %s fits everything', async (_label, payload) => {
    initBridge(makeCtx(state));
    await send(fw, cmd('FIT_TO_VIEW', payload, 'r1'));
    expect(called(state, 'fitAll')).toBe(true);
    expect(called(state, 'frameSelection')).toBe(false);
  });

  it('SET_CAMERA forwards azimuth and elevation', async () => {
    initBridge(makeCtx(state));
    await send(fw, cmd('SET_CAMERA', { azimuth: 30, elevation: -10, zoom: 2 }, 'r1'));
    expect(argsOf(state, 'setCameraRotation')).toEqual([{ azimuth: 30, elevation: -10 }]);
  });

  it('SET_VIEW forwards the preset', async () => {
    initBridge(makeCtx(state));
    await send(fw, cmd('SET_VIEW', { preset: 'front' }, 'r1'));
    expect(argsOf(state, 'setPresetView')).toEqual(['front']);
  });

  it('SET_VIEW survives a viewport that has not registered camera callbacks', async () => {
    state.cameraCallbacks = {};
    initBridge(makeCtx(state));
    await send(fw, cmd('SET_VIEW', { preset: 'front' }, 'r1'));
    expect(fw.posted.at(-1)!.msg.error).toBeUndefined();
  });

  it('SET_SECTION applies axis and position and toggles only on a real change', async () => {
    // Fixture: sectionPlane = { enabled: false, flipped: false }.
    initBridge(makeCtx(state));
    await send(fw, cmd('SET_SECTION', { axis: 'front', position: 1.5, enabled: true, flipped: false }, 'r1'));
    expect(argsOf(state, 'setSectionPlaneAxis')).toEqual(['front']);
    expect(argsOf(state, 'setSectionPlanePosition')).toEqual([1.5]);
    expect(called(state, 'toggleSectionPlane')).toBe(true);
    expect(called(state, 'flipSectionPlane')).toBe(false);
  });

  it('SET_SECTION with matching enabled/flipped toggles nothing', async () => {
    state.sectionPlane = { enabled: true, flipped: true };
    initBridge(makeCtx(state));
    await send(fw, cmd('SET_SECTION', { enabled: true, flipped: true }, 'r1'));
    expect(called(state, 'toggleSectionPlane')).toBe(false);
    expect(called(state, 'flipSectionPlane')).toBe(false);
  });

  it('SET_SECTION flips when the requested flip differs', async () => {
    state.sectionPlane = { enabled: true, flipped: false };
    initBridge(makeCtx(state));
    await send(fw, cmd('SET_SECTION', { flipped: true }, 'r1'));
    expect(called(state, 'flipSectionPlane')).toBe(true);
    expect(called(state, 'setSectionPlaneAxis')).toBe(false);
    expect(called(state, 'setSectionPlanePosition')).toBe(false);
  });

  it('SET_SECTION accepts position 0 and enabled false as real values', async () => {
    state.sectionPlane = { enabled: true, flipped: false };
    initBridge(makeCtx(state));
    await send(fw, cmd('SET_SECTION', { position: 0, enabled: false }, 'r1'));
    expect(argsOf(state, 'setSectionPlanePosition')).toEqual([0]);
    expect(called(state, 'toggleSectionPlane')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Read commands
// ---------------------------------------------------------------------------

describe('read commands', () => {
  it('GET_PROPERTIES returns attributes for a resolvable entity', async () => {
    initBridge(makeCtx(state));
    await send(fw, cmd('GET_PROPERTIES', { id: 1005 }, 'r1'));
    expect(fw.posted.at(-1)!.msg.data).toEqual({
      expressId: 5,
      ifcType: 'IfcWall',
      name: 'Wall A',
      globalId: 'GUID-A',
      attributes: {
        GlobalId: 'GUID-A',
        Name: 'Wall A',
        Description: '',
        ObjectType: '',
        Type: 'IfcWall',
      },
      propertySets: [],
      quantitySets: [],
    });
  });

  it('GET_PROPERTIES reports NOT_FOUND for an unresolvable id', async () => {
    initBridge(makeCtx(state));
    await send(fw, cmd('GET_PROPERTIES', { id: 999 }, 'r1'));
    expect(fw.posted.at(-1)!.msg.error).toEqual({
      code: 'NOT_FOUND',
      message: 'Entity 999 not found',
    });
  });

  it('GET_PROPERTIES stays silent without a requestId', async () => {
    initBridge(makeCtx(state));
    await send(fw, cmd('GET_PROPERTIES', { id: 999 }));
    expect(names(fw.posted)).toEqual(['READY']);
  });

  it('GET_MODEL_INFO aggregates per-model counts and totals', async () => {
    state.models.set('m2', {
      id: 'm2',
      name: 'model-two.ifc',
      visible: false,
      ifcDataStore: { entities: { count: 3 } },
      geometryResult: { totalTriangles: 8 },
    });
    initBridge(makeCtx(state));
    await send(fw, cmd('GET_MODEL_INFO', undefined, 'r1'));
    expect(fw.posted.at(-1)!.msg.data).toEqual({
      models: [
        { modelId: 'm1', name: 'model-one.ifc', entityCount: 2, triangleCount: 42, visible: true },
        { modelId: 'm2', name: 'model-two.ifc', entityCount: 3, triangleCount: 8, visible: false },
      ],
      totalEntities: 5,
      totalTriangles: 50,
    });
  });

  it('GET_MODEL_INFO defaults missing counts to zero', async () => {
    state.models.set('m3', { id: 'm3', name: 'bare', visible: true });
    initBridge(makeCtx(state));
    await send(fw, cmd('GET_MODEL_INFO', undefined, 'r1'));
    const info = fw.posted.at(-1)!.msg.data;
    expect(info.models.at(-1)).toEqual({
      modelId: 'm3', name: 'bare', entityCount: 0, triangleCount: 0, visible: true,
    });
    expect(info.totalEntities).toBe(2);
  });

  it('GET_SCREENSHOT is explicitly reported as not implemented', async () => {
    initBridge(makeCtx(state));
    await send(fw, cmd('GET_SCREENSHOT', {}, 'r1'));
    expect(fw.posted.at(-1)!.msg.error).toEqual({
      code: 'NOT_IMPLEMENTED',
      message: 'GET_SCREENSHOT not yet implemented',
    });
  });
});

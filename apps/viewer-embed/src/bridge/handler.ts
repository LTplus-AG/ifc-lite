/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Inbound postMessage command handler.
 *
 * Receives commands from the parent SDK and dispatches them to the store
 * and renderer. Also handles the READY → INIT → INIT_ACK handshake.
 */

import {
  isEmbedMessage,
  createResponse,
  createEvent,
  EMBED_SOURCE,
  PROTOCOL_VERSION,
  type EmbedMessageEnvelope,
  type InboundCommandType,
  type InboundPayloads,
  type ModelInfo,
  type ViewPreset,
  type SectionAxis,
} from '@ifc-lite/embed-protocol';
import type { ViewerState } from '@/store/index.js';
import { toGlobalIdFromModels } from '@/store/index.js';

/** Reference to the store's getState / setState for imperative access */
interface BridgeContext {
  getState: () => ViewerState;
  /** Callback to load a model from URL (async). Replaces the whole scene — used by LOAD_MODEL. */
  loadModelFromUrl: (url: string) => Promise<{ entities: number; triangles: number; vertices: number }>;
  /** Callback to load a model from ArrayBuffer */
  loadModelFromBuffer: (buffer: ArrayBuffer, name?: string) => Promise<{ entities: number; triangles: number; vertices: number }>;
  /**
   * Callback to ADD a model to the federation alongside whatever is already
   * loaded (does not replace existing models). Returns the real, freshly
   * minted model id so the host can later target it with REMOVE_MODEL.
   */
  addModelFromUrl: (url: string) => Promise<{ modelId: string; entities: number; triangles: number; vertices: number }>;
}

/** Optional security knobs for the bridge (all opt-in; defaults preserve the public-widget behaviour). */
interface BridgeOptions {
  /**
   * Optional inbound origin allowlist. When non-empty, postMessage commands
   * whose event.origin is not on the list are dropped. When empty/undefined
   * the bridge accepts any sender (public read-only embed default).
   */
  allowedOrigins?: string[];
  /**
   * Optional expected parent origin (e.g. from ?parentOrigin= or
   * document.referrer). Used as the outbound targetOrigin for content-bearing
   * events before the first inbound message arrives, so they are not broadcast
   * to '*'. The READY handshake still uses '*' regardless.
   */
  expectedParentOrigin?: string;
  /**
   * Optional INIT token. When set, the INIT command's payload.token must match
   * or the INIT is rejected.
   */
  initToken?: string;
}

let ctx: BridgeContext | null = null;
let allowedOrigins: string[] = [];
let initToken: string | undefined;
/**
 * The `event.source` window of the first accepted inbound message. Mirrors
 * the SDK side (packages/embed-sdk/src/index.ts onMessage), which checks
 * `event.source !== this.iframe.contentWindow`. The embed side has no
 * equivalent fixed reference to compare against up front (unlike the SDK,
 * which knows its own iframe's contentWindow at construction time), so it
 * latches the sender the same way captureParentOrigin latches the sender's
 * origin: from the first accepted message, then holds it for the life of
 * the bridge.
 */
let parentSource: MessageEventSource | null = null;
/** True once a concrete event.source has been captured. */
let parentSourceCaptured = false;
/**
 * Outbound targetOrigin. '*' until a concrete parent origin is known. The
 * READY handshake is always allowed to post to '*'; content-bearing events are
 * withheld while this is '*' (see emitToParent).
 */
let parentOrigin: string = '*';
/** True once a concrete (non-'*') parentOrigin has been captured. */
let parentOriginResolved = false;

/** Is `origin` permitted given the configured allowlist? Empty allowlist permits all. */
function isOriginAllowed(origin: string): boolean {
  if (allowedOrigins.length === 0) return true;
  return allowedOrigins.includes(origin);
}

/** Adopt a concrete outbound targetOrigin once, ignoring '*'/'null'. */
function captureParentOrigin(origin: string | undefined) {
  if (parentOriginResolved) return;
  if (!origin || origin === 'null' || origin === '*') return;
  parentOrigin = origin;
  parentOriginResolved = true;
}

/** Adopt the sender window of the first accepted inbound message, once. */
function captureParentSource(source: MessageEventSource | null) {
  if (parentSourceCaptured) return;
  if (!source) return;
  parentSource = source;
  parentSourceCaptured = true;
}

/** Initialize the bridge with store and callback references */
export function initBridge(context: BridgeContext, options: BridgeOptions = {}) {
  ctx = context;
  allowedOrigins = options.allowedOrigins ?? [];
  initToken = options.initToken;
  // Seed the outbound targetOrigin from an expected parent origin so
  // content-bearing auto-load events are not broadcast to '*' before any
  // inbound command is received. Crucially this seed stays *overridable*: a
  // stale/misconfigured ?parentOrigin= or referrer must not permanently lock
  // the target, or replies/events would be addressed to the wrong origin and
  // silently dropped. The first valid inbound message confirms the real origin
  // (via captureParentOrigin in onMessage) and supersedes this seed.
  const seed = options.expectedParentOrigin;
  if (seed && seed !== 'null' && seed !== '*') {
    parentOrigin = seed;
    parentOriginResolved = false;
  }
  window.addEventListener('message', onMessage);

  // Send READY event to parent (handshake bootstrap — allowed to use '*').
  emitToParent(createEvent('READY', { version: PROTOCOL_VERSION }));
}

/** Clean up the bridge */
export function destroyBridge() {
  window.removeEventListener('message', onMessage);
  ctx = null;
  allowedOrigins = [];
  initToken = undefined;
  parentOrigin = '*';
  parentOriginResolved = false;
  parentSource = null;
  parentSourceCaptured = false;
}

/** Emit an event to the parent window */
export function emitToParent(msg: EmbedMessageEnvelope, transfer?: Transferable[]) {
  if (window.parent === window) return; // Not in an iframe
  // Only the READY handshake (carries no model data) may broadcast to '*'.
  // Withhold every other message until a concrete parentOrigin is known so we
  // don't leak content/responses to unknown ancestor origins.
  if (parentOrigin === '*' && msg.type !== 'READY') return;
  window.parent.postMessage(msg, parentOrigin, transfer ?? []);
}

/** Emit a typed event to the parent */
export function emitEvent(type: string, data?: unknown) {
  emitToParent({
    source: EMBED_SOURCE,
    version: PROTOCOL_VERSION,
    type,
    data,
  });
}

// ---- Internal message handler ----

function onMessage(event: MessageEvent) {
  if (!isEmbedMessage(event.data)) return;
  if (!ctx) return;

  // When an allowlist is configured, drop inbound commands from any other
  // origin. With no allowlist (the public-widget default) every sender is
  // accepted, preserving generic embedding.
  if (!isOriginAllowed(event.origin)) return;

  // Mirror the SDK side's event.source check (packages/embed-sdk/src/index.ts
  // onMessage: `event.source !== this.iframe.contentWindow`). Once a sender
  // window is latched (see captureParentSource below), reject anything from a
  // different window even if the origin matches -- an origin string alone
  // does not prove *which* window sent the message. Before latching (i.e. for
  // the very first accepted message, typically INIT) there is nothing yet to
  // compare against, so it is let through on origin/shape alone; that message
  // is what gets latched.
  if (parentSourceCaptured && event.source !== parentSource) return;

  const msg = event.data as EmbedMessageEnvelope;

  // Capture the first valid inbound origin as the outbound targetOrigin so all
  // subsequent replies/events go only to that origin instead of '*'.
  captureParentOrigin(event.origin);
  captureParentSource(event.source);

  const { type, requestId, data } = msg;

  // Handle commands with request/response pattern
  if (requestId) {
    handleCommand(type as InboundCommandType, data, requestId).catch((err) => {
      emitToParent(createResponse(requestId, undefined, {
        code: 'COMMAND_FAILED',
        message: err instanceof Error ? err.message : String(err),
      }));
    });
    return;
  }

  // Handle fire-and-forget commands (no requestId)
  handleCommand(type as InboundCommandType, data).catch(() => {
    // Silently ignore errors on fire-and-forget commands
  });
}

/** The `ifcDataStore` field of a model entry in `ViewerState.models`. */
type EntityDataStore = NonNullable<ReturnType<ViewerState['models']['get']>>['ifcDataStore'] | undefined;

/**
 * Real property-set extraction for GET_PROPERTIES, reusing the same
 * `IfcDataStore.getProperties` accessor the main viewer's properties panel
 * calls via `EntityNode.properties()` (apps/viewer/src/components/viewer/
 * PropertiesPanel.tsx -> packages/query/src/entity-node.ts). That accessor is
 * synchronous over data already attached at load time (see
 * packages/parser/src/data-store-accessors.ts) — there is no separate
 * "streamed later" pset state to account for here, so an empty result
 * genuinely means the entity has no property sets, not that they have not
 * loaded yet. The wire shape flattens each set's properties into a
 * name->value record per the embed-protocol's `PropertySet` (a deliberately
 * simpler public shape than the internal `Property[]` array).
 */
function extractPropertySets(ds: EntityDataStore, expressId: number) {
  if (!ds?.getProperties) return [];
  return ds.getProperties(expressId).map((pset) => ({
    name: pset.name,
    properties: Object.fromEntries(pset.properties.map((p) => [p.name, p.value])),
  }));
}

/** Same rationale as {@link extractPropertySets}, for quantity sets. */
function extractQuantitySets(ds: EntityDataStore, expressId: number) {
  if (!ds?.getQuantities) return [];
  return ds.getQuantities(expressId).map((qset) => ({
    name: qset.name,
    quantities: Object.fromEntries(qset.quantities.map((q) => [q.name, q.value])),
  }));
}

async function handleCommand(type: InboundCommandType, data: unknown, requestId?: string) {
  if (!ctx) throw new Error('Bridge not initialized');
  const state = ctx.getState();

  switch (type) {
    case 'INIT': {
      const payload = data as InboundPayloads['INIT'];
      // When an INIT token is configured, the handshake must present a matching
      // token; otherwise reject without applying config or ACKing.
      if (initToken !== undefined && payload?.token !== initToken) {
        if (requestId) {
          emitToParent(createResponse(requestId, undefined, {
            code: 'UNAUTHORIZED',
            message: 'INIT token mismatch',
          }));
        }
        return;
      }
      // Apply initial config if provided
      if (payload?.config?.theme) state.setTheme(payload.config.theme);
      // ACK the init
      if (requestId) {
        emitToParent(createResponse(requestId));
      }
      emitEvent('INIT_ACK');
      return;
    }

    case 'LOAD_MODEL': {
      const payload = data as InboundPayloads['LOAD_MODEL'];
      const stats = await ctx.loadModelFromUrl(payload.url);
      if (requestId) emitToParent(createResponse(requestId, stats));
      return;
    }

    case 'LOAD_MODEL_BUFFER': {
      const buffer = data as ArrayBuffer;
      const MAX_BUFFER_SIZE = 500 * 1024 * 1024; // 500 MB
      if (buffer.byteLength > MAX_BUFFER_SIZE) {
        throw new Error(`Model too large (${(buffer.byteLength / 1024 / 1024).toFixed(0)} MB). Max: 500 MB`);
      }
      const stats = await ctx.loadModelFromBuffer(buffer);
      if (requestId) emitToParent(createResponse(requestId, stats));
      return;
    }

    case 'ADD_MODEL': {
      const payload = data as InboundPayloads['ADD_MODEL'];
      // Federation-aware add: does NOT replace existing models (unlike
      // LOAD_MODEL, which is destructive by design). The response carries the
      // real minted model id so REMOVE_MODEL can target it later.
      const result = await ctx.addModelFromUrl(payload.url);
      if (requestId) emitToParent(createResponse(requestId, result));
      return;
    }

    case 'REMOVE_MODEL': {
      const payload = data as InboundPayloads['REMOVE_MODEL'];
      // Map.delete on an absent key is a silent no-op (same for the
      // federation registry's unregisterModel), so removeModel() itself
      // cannot tell "removed something" from "nothing to remove". Check
      // existence first and report NOT_FOUND for an unknown id, matching the
      // convention GET_PROPERTIES already uses for a missing entity id.
      if (!state.models.has(payload.modelId)) {
        if (requestId) {
          emitToParent(createResponse(requestId, undefined, {
            code: 'NOT_FOUND',
            message: `Model ${payload.modelId} not found`,
          }));
        }
        return;
      }
      state.removeModel(payload.modelId);
      if (requestId) emitToParent(createResponse(requestId));
      return;
    }

    case 'SELECT': {
      const payload = data as InboundPayloads['SELECT'];
      if (payload.ids.length === 0) {
        state.clearEntitySelection();
      } else {
        state.setSelectedEntityId(payload.ids[0]);
        state.setSelectedEntityIds(payload.ids);
      }
      if (requestId) emitToParent(createResponse(requestId));
      return;
    }

    case 'SELECT_BY_GUID': {
      const payload = data as InboundPayloads['SELECT_BY_GUID'];
      const resolved: number[] = [];
      for (const [, model] of state.models) {
        const ds = model.ifcDataStore;
        if (!ds?.entities) continue;
        for (const guid of payload.guids) {
          const expressId = ds.entities.getExpressIdByGlobalId(guid);
          if (expressId >= 0) {
            resolved.push(toGlobalIdFromModels(state.models, model.id, expressId));
          }
        }
      }
      if (resolved.length > 0) {
        state.setSelectedEntityId(resolved[0]);
        state.setSelectedEntityIds(resolved);
      }
      if (requestId) emitToParent(createResponse(requestId, { resolved }));
      return;
    }

    case 'CLEAR_SELECTION': {
      state.clearEntitySelection();
      if (requestId) emitToParent(createResponse(requestId));
      return;
    }

    case 'ISOLATE': {
      const payload = data as InboundPayloads['ISOLATE'];
      state.isolateEntities(payload.ids);
      if (requestId) emitToParent(createResponse(requestId));
      return;
    }

    case 'HIDE': {
      const payload = data as InboundPayloads['HIDE'];
      state.hideEntities(payload.ids);
      if (requestId) emitToParent(createResponse(requestId));
      return;
    }

    case 'SHOW': {
      const payload = data as InboundPayloads['SHOW'];
      state.showEntities(payload.ids);
      if (requestId) emitToParent(createResponse(requestId));
      return;
    }

    case 'SHOW_ALL': {
      state.showAllInAllModels();
      if (requestId) emitToParent(createResponse(requestId));
      return;
    }

    case 'SET_COLORS': {
      const payload = data as InboundPayloads['SET_COLORS'];
      const updates = new Map<number, [number, number, number, number]>();
      for (const [key, color] of Object.entries(payload.colorMap)) {
        updates.set(Number(key), color);
      }
      state.updateMeshColors(updates);
      if (requestId) emitToParent(createResponse(requestId));
      return;
    }

    case 'RESET_COLORS': {
      state.clearPendingColorUpdates();
      if (requestId) emitToParent(createResponse(requestId));
      return;
    }

    case 'FIT_TO_VIEW': {
      const payload = data as InboundPayloads['FIT_TO_VIEW'];
      if (payload?.ids && payload.ids.length > 0) {
        state.setSelectedEntityIds(payload.ids);
        state.cameraCallbacks.frameSelection?.();
      } else {
        state.cameraCallbacks.fitAll?.();
      }
      if (requestId) emitToParent(createResponse(requestId));
      return;
    }

    case 'SET_CAMERA': {
      const payload = data as InboundPayloads['SET_CAMERA'];
      state.setCameraRotation({ azimuth: payload.azimuth, elevation: payload.elevation });
      if (requestId) emitToParent(createResponse(requestId));
      return;
    }

    case 'SET_VIEW': {
      const payload = data as InboundPayloads['SET_VIEW'];
      state.cameraCallbacks.setPresetView?.(payload.preset as ViewPreset);
      if (requestId) emitToParent(createResponse(requestId));
      return;
    }

    case 'SET_SECTION': {
      const payload = data as InboundPayloads['SET_SECTION'];
      if (payload.axis !== undefined) state.setSectionPlaneAxis(payload.axis as SectionAxis);
      if (payload.position !== undefined) state.setSectionPlanePosition(payload.position);
      if (payload.enabled !== undefined) {
        const current = state.sectionPlane.enabled;
        if (current !== payload.enabled) state.toggleSectionPlane();
      }
      if (payload.flipped !== undefined) {
        const current = state.sectionPlane.flipped;
        if (current !== payload.flipped) state.flipSectionPlane();
      }
      if (requestId) emitToParent(createResponse(requestId));
      return;
    }

    case 'SET_THEME': {
      const payload = data as InboundPayloads['SET_THEME'];
      state.setTheme(payload.theme);
      if (requestId) emitToParent(createResponse(requestId));
      return;
    }

    case 'SET_TYPE_VISIBILITY': {
      const payload = data as InboundPayloads['SET_TYPE_VISIBILITY'];
      const tv = state.typeVisibility;
      if (payload.spaces !== undefined && tv.spaces !== payload.spaces) state.toggleTypeVisibility('spaces');
      if (payload.openings !== undefined && tv.openings !== payload.openings) state.toggleTypeVisibility('openings');
      if (payload.site !== undefined && tv.site !== payload.site) state.toggleTypeVisibility('site');
      if (requestId) emitToParent(createResponse(requestId));
      return;
    }

    case 'GET_PROPERTIES': {
      const payload = data as InboundPayloads['GET_PROPERTIES'];
      // Find entity across all models
      const lookup = state.resolveGlobalIdFromModels(payload.id);
      if (!lookup) {
        if (requestId) emitToParent(createResponse(requestId, undefined, { code: 'NOT_FOUND', message: `Entity ${payload.id} not found` }));
        return;
      }
      const model = state.models.get(lookup.modelId);
      const ds = model?.ifcDataStore;
      const entities = ds?.entities;
      if (requestId) {
        emitToParent(createResponse(requestId, {
          expressId: lookup.expressId,
          ifcType: entities?.getTypeName(lookup.expressId),
          name: entities?.getName(lookup.expressId),
          globalId: entities?.getGlobalId(lookup.expressId),
          attributes: {
            GlobalId: entities?.getGlobalId(lookup.expressId) ?? '',
            Name: entities?.getName(lookup.expressId) ?? '',
            Description: entities?.getDescription(lookup.expressId) ?? '',
            ObjectType: entities?.getObjectType(lookup.expressId) ?? '',
            Type: entities?.getTypeName(lookup.expressId) ?? '',
          },
          propertySets: extractPropertySets(ds, lookup.expressId),
          quantitySets: extractQuantitySets(ds, lookup.expressId),
        }));
      }
      return;
    }

    case 'GET_SCREENSHOT': {
      // Screenshot requires canvas access - return placeholder for now
      if (requestId) {
        emitToParent(createResponse(requestId, undefined, {
          code: 'NOT_IMPLEMENTED',
          message: 'GET_SCREENSHOT not yet implemented',
        }));
      }
      return;
    }

    case 'GET_MODEL_INFO': {
      const models = Array.from(state.models.values());
      const info: ModelInfo = {
        models: models.map(m => ({
          modelId: m.id,
          name: m.name,
          entityCount: m.ifcDataStore?.entities?.count ?? 0,
          triangleCount: m.geometryResult?.totalTriangles ?? 0,
          visible: m.visible,
        })),
        totalEntities: models.reduce((sum, m) => sum + (m.ifcDataStore?.entities?.count ?? 0), 0),
        totalTriangles: models.reduce((sum, m) => sum + (m.geometryResult?.totalTriangles ?? 0), 0),
      };
      if (requestId) emitToParent(createResponse(requestId, info));
      return;
    }

    default:
      if (requestId) {
        emitToParent(createResponse(requestId, undefined, {
          code: 'UNKNOWN_COMMAND',
          message: `Unknown command: ${type}`,
        }));
      }
  }
}

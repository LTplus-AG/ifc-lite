/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * @ifc-lite/embed-sdk
 *
 * A lightweight SDK (~3-5 KB) for embedding the IFC-Lite 3D viewer in any web page.
 * Creates an iframe pointed at the hosted embed viewer and provides a promise-based
 * API for controlling it via postMessage.
 *
 * @example
 * ```typescript
 * import { IFCLiteEmbed } from '@ifc-lite/embed-sdk';
 *
 * const viewer = await IFCLiteEmbed.create({
 *   container: '#viewer',
 *   modelUrl: 'https://example.com/model.ifc',
 *   theme: 'dark',
 * });
 *
 * await viewer.select([42, 43]);
 * viewer.on('entity-selected', (data) => console.log(data));
 * ```
 */

import {
  EMBED_SOURCE,
  PROTOCOL_VERSION,
  isEmbedMessage,
  type EmbedMessageEnvelope,
  type ViewPreset,
  type SectionAxis,
  type ModelStats,
  type EntityProperties,
  type ModelInfo,
  type TypeVisibilityFlags,
} from '@ifc-lite/embed-protocol';
import { createWorkerRpc, type RpcReply } from '@ifc-lite/wasm-lifecycle';
import { embedUrlSearchParams, type EmbedOptions } from './options.js';

// ============================================================================
// Public types
// ============================================================================

export interface EventMap {
  'ready': { version: string };
  'model-loading': { progress: number; phase: string };
  'model-loaded': ModelStats & { modelId?: string };
  'model-error': { error: { code: string; message: string } };
  'entity-selected': { id: number; globalId?: string; modelId?: string; ifcType?: string };
  'entity-deselected': void;
  'entity-hovered': { id: number; globalId?: string; ifcType?: string };
  'camera-changed': { azimuth: number; elevation: number; zoom?: number };
  'section-changed': { axis: SectionAxis; position: number; enabled: boolean };
}

type EventCallback<T> = (data: T) => void;

// Re-export types consumers might need
export type { EmbedOptions };
export type { ViewPreset, SectionAxis, ModelStats, EntityProperties, ModelInfo, TypeVisibilityFlags };

// ============================================================================
// Default embed origin
// ============================================================================

const DEFAULT_ORIGIN = 'https://embed.ifclite.com';

/** How long a command may wait for its RESPONSE. */
const REQUEST_TIMEOUT_MS = 30_000;

// ============================================================================
// IFCLiteEmbed class
// ============================================================================

export class IFCLiteEmbed {
  private iframe: HTMLIFrameElement;
  private origin: string;
  private expectedOrigin: string;
  /** Request/response correlation with a dead latch: `destroy()` rejects everything pending. */
  private readonly rpc = createWorkerRpc<string>({
    label: 'Embed viewer',
    nextId: () => crypto.randomUUID(),
    post: (message, transfer) => this.send(message as Partial<EmbedMessageEnvelope>, transfer),
    decode: (data): RpcReply<string> | undefined => {
      const msg = data as EmbedMessageEnvelope;
      if (!msg.responseId) return undefined;
      return msg.error
        ? { id: msg.responseId, error: new Error(`${msg.error.code}: ${msg.error.message}`) }
        : { id: msg.responseId, value: msg.data };
    },
    requestTimeoutMs: REQUEST_TIMEOUT_MS,
    // A slow command fails alone; the viewer may still answer the next one.
    onRequestTimeout: 'reject',
  });
  private listeners = new Map<string, Set<EventCallback<unknown>>>();
  private readyPromise: Promise<void>;
  private destroyed = false;

  // --- Factory ---

  /** Create an embed viewer instance. Returns a promise that resolves after the handshake. */
  static async create(opts: EmbedOptions): Promise<IFCLiteEmbed> {
    const instance = new IFCLiteEmbed(opts);
    await instance.readyPromise;
    return instance;
  }

  private constructor(opts: EmbedOptions) {
    this.origin = opts.origin ?? DEFAULT_ORIGIN;
    // Canonical scheme+host+port for strict event.origin comparison
    // (tolerates a consumer-supplied origin with a trailing slash or path).
    this.expectedOrigin = new URL(this.origin).origin;

    // Build URL with non-sensitive params
    const params = embedUrlSearchParams(opts);

    // Create iframe
    this.iframe = document.createElement('iframe');
    this.iframe.src = `${this.origin}/v1?${params}`;
    this.iframe.style.cssText = 'width:100%;height:100%;border:none;display:block;';
    this.iframe.setAttribute('allow', 'cross-origin-isolated');
    this.iframe.setAttribute('loading', 'eager');

    // Mount
    const container = typeof opts.container === 'string'
      ? document.querySelector(opts.container)
      : opts.container;
    if (!container) throw new Error(`Container not found: ${opts.container}`);
    container.appendChild(this.iframe);

    // Listen for messages
    window.addEventListener('message', this.onMessage);

    // Handshake: READY -> INIT -> INIT_ACK
    const handshakeTimeout = opts.timeout ?? 15_000;
    this.readyPromise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        // create() never hands a timed-out instance to the caller, so nobody
        // else can destroy it: tear it down here so a late READY cannot pull
        // the token into an iframe the host gave up on, and retries don't stack.
        this.destroy();
        reject(new Error('Embed viewer handshake timed out'));
      }, handshakeTimeout);

      const waitForReady = (msg: EmbedMessageEnvelope) => {
        if (msg.type === 'READY') {
          // Send INIT
          this.send({ type: 'INIT', data: { token: opts.token } });
        }
        if (msg.type === 'INIT_ACK') {
          clearTimeout(timer);
          resolve();
        }
      };

      // Temporary internal listener for handshake
      this.onceInternal('READY', waitForReady);
      this.onceInternal('INIT_ACK', waitForReady);
    });
  }

  // --- Commands (promise-based) ---

  /** Load a model from a URL */
  loadModel(url: string): Promise<ModelStats> {
    return this.request('LOAD_MODEL', { url }) as Promise<ModelStats>;
  }

  /** Load a model from an ArrayBuffer (zero-copy transfer) */
  loadModelBuffer(buffer: ArrayBuffer): Promise<ModelStats> {
    return this.request('LOAD_MODEL_BUFFER', buffer, [buffer]) as Promise<ModelStats>;
  }

  /** Add a model to the federation */
  addModel(url: string, name?: string): Promise<ModelStats & { modelId: string }> {
    return this.request('ADD_MODEL', { url, name }) as Promise<ModelStats & { modelId: string }>;
  }

  /** Remove a model from the federation */
  removeModel(modelId: string): Promise<void> {
    return this.request('REMOVE_MODEL', { modelId }) as Promise<void>;
  }

  /** Select entities by global IDs */
  select(ids: number[]): Promise<void> {
    return this.request('SELECT', { ids }) as Promise<void>;
  }

  /** Select entities by IFC GlobalId GUIDs */
  selectByGuid(guids: string[]): Promise<{ resolved: number[] }> {
    return this.request('SELECT_BY_GUID', { guids }) as Promise<{ resolved: number[] }>;
  }

  /** Clear selection */
  clearSelection(): Promise<void> {
    return this.request('CLEAR_SELECTION') as Promise<void>;
  }

  /** Isolate (show only) specific entities */
  isolate(ids: number[]): Promise<void> {
    return this.request('ISOLATE', { ids }) as Promise<void>;
  }

  /** Hide specific entities */
  hide(ids: number[]): Promise<void> {
    return this.request('HIDE', { ids }) as Promise<void>;
  }

  /** Show specific entities */
  show(ids: number[]): Promise<void> {
    return this.request('SHOW', { ids }) as Promise<void>;
  }

  /** Show all entities (reset visibility) */
  showAll(): Promise<void> {
    return this.request('SHOW_ALL') as Promise<void>;
  }

  /** Set color overrides for entities. Keys are entity IDs, values are [r,g,b,a]. */
  setColors(colorMap: Record<number, [number, number, number, number]>): Promise<void> {
    // Convert numeric keys to string for JSON serialization
    const stringKeyed: Record<string, [number, number, number, number]> = {};
    for (const [k, v] of Object.entries(colorMap)) stringKeyed[k] = v;
    return this.request('SET_COLORS', { colorMap: stringKeyed }) as Promise<void>;
  }

  /** Reset all color overrides */
  resetColors(): Promise<void> {
    return this.request('RESET_COLORS') as Promise<void>;
  }

  /** Zoom the camera to fit specific entities (or all if no IDs given) */
  fitToView(ids?: number[]): Promise<void> {
    return this.request('FIT_TO_VIEW', { ids }) as Promise<void>;
  }

  /**
   * Set the camera's absolute orientation, in degrees, around whatever it is
   * currently looking at. `zoom` is reserved and ignored by the viewer — see
   * `InboundPayloads['SET_CAMERA']`.
   */
  setCamera(azimuth: number, elevation: number, zoom?: number): Promise<void> {
    return this.request('SET_CAMERA', { azimuth, elevation, zoom }) as Promise<void>;
  }

  /** Set a preset camera view */
  setView(preset: ViewPreset): Promise<void> {
    return this.request('SET_VIEW', { preset }) as Promise<void>;
  }

  /** Control the section plane */
  setSection(opts: { axis?: SectionAxis; position?: number; enabled?: boolean; flipped?: boolean }): Promise<void> {
    return this.request('SET_SECTION', opts) as Promise<void>;
  }

  /** Change the color theme */
  setTheme(theme: 'light' | 'dark', bg?: string): Promise<void> {
    return this.request('SET_THEME', { theme, bg }) as Promise<void>;
  }

  /**
   * Toggle IFC type visibility: `spaces`, `spatialZones`, `openings`,
   * `virtualElements`, `site`, `ifcAnnotations`, `ifcGrid`. Omitted flags are
   * left as they are. See `TypeVisibilityFlags` for the classes each one gates.
   */
  setTypeVisibility(opts: TypeVisibilityFlags): Promise<void> {
    return this.request('SET_TYPE_VISIBILITY', opts) as Promise<void>;
  }

  /** Get properties for a specific entity */
  getProperties(id: number): Promise<EntityProperties> {
    return this.request('GET_PROPERTIES', { id }) as Promise<EntityProperties>;
  }

  /** Capture a screenshot of the viewport */
  getScreenshot(width?: number, height?: number): Promise<{ dataUrl: string }> {
    return this.request('GET_SCREENSHOT', { width, height }) as Promise<{ dataUrl: string }>;
  }

  /** Get info about all loaded models */
  getModelInfo(): Promise<ModelInfo> {
    return this.request('GET_MODEL_INFO') as Promise<ModelInfo>;
  }

  // --- Events ---

  /** Subscribe to an event. Returns an unsubscribe function. */
  on<K extends keyof EventMap>(event: K, callback: EventCallback<EventMap[K]>): () => void {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set());
    this.listeners.get(event)!.add(callback as EventCallback<unknown>);
    return () => this.listeners.get(event)?.delete(callback as EventCallback<unknown>);
  }

  // --- Lifecycle ---

  /** Destroy the embed viewer and clean up resources */
  destroy() {
    this.destroyed = true;
    window.removeEventListener('message', this.onMessage);
    this.rpc.dispose(new Error('Embed destroyed'));
    this.listeners.clear();
    this.iframe.remove();
  }

  // --- Internals ---

  private onMessage = (event: MessageEvent) => {
    // Filter: must be from our iframe, at our origin
    if (event.origin !== this.expectedOrigin) return;
    if (event.source !== this.iframe.contentWindow) return;
    if (!isEmbedMessage(event.data)) return;

    const msg = event.data as EmbedMessageEnvelope;

    // Handle response to a pending request
    if (this.rpc.receive(msg)) return;

    // Broadcast event to external listeners
    const kebab = msg.type.toLowerCase().replace(/_/g, '-');
    this.listeners.get(kebab)?.forEach(fn => {
      try { fn(msg.data); } catch (err) { console.error('[ifc-lite-embed] event listener threw', err); }
    });

    // Also broadcast to internal listeners (for handshake)
    this.internalListeners.get(msg.type)?.forEach(fn => {
      try { fn(msg); } catch (err) { console.error('[ifc-lite-embed] internal listener threw', err); }
    });
  };

  private send(msg: Partial<EmbedMessageEnvelope>, transfer?: Transferable[]) {
    if (this.destroyed) return;
    this.iframe.contentWindow?.postMessage(
      { source: EMBED_SOURCE, version: PROTOCOL_VERSION, ...msg },
      this.origin,
      transfer ?? [],
    );
  }

  private request(type: string, data?: unknown, transfer?: Transferable[]): Promise<unknown> {
    return this.rpc.request((requestId) => ({ type, requestId, data }), {
      transfer,
      timeoutError: () => new Error(`${type} timed out (30s)`),
    });
  }

  // Internal listener system for handshake (separate from public events)
  private internalListeners = new Map<string, Set<(msg: EmbedMessageEnvelope) => void>>();

  private onceInternal(type: string, fn: (msg: EmbedMessageEnvelope) => void) {
    if (!this.internalListeners.has(type)) this.internalListeners.set(type, new Set());
    const wrapped = (msg: EmbedMessageEnvelope) => {
      fn(msg);
      this.internalListeners.get(type)?.delete(wrapped);
    };
    this.internalListeners.get(type)!.add(wrapped);
  }
}

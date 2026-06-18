/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * WebSocket platform bridge — routes geometry processing to a localhost native
 * backend (`ifc-lite-desktop-server`) over a WebSocket, so a plain browser tab
 * gets native-speed parsing/meshing (real Rayon over one shared heap, no
 * wasm32 4 GB cap) without a desktop install.
 *
 * It is a drop-in {@link IPlatformBridge}: `GeometryProcessor` selects it when a
 * `nativeBackendUrl` is configured and `init()` succeeds; if the helper is not
 * running, `init()` rejects and the processor falls back to WASM. The wire
 * format (binary packed shards + JSON control frames) is owned by the server
 * and decoded here with the same {@link decodePackedGeometryCacheShard} the
 * Tauri disk-cache path uses, so a WS-delivered shard is byte-identical to the
 * native desktop one.
 */

import { CoordinateHandler } from './coordinate-handler.js';
import { decodePackedGeometryCacheShard } from './packed-geometry-decoder.js';
import type {
  GeometryProcessingResult,
  GeometryStats,
  IPlatformBridge,
  StreamingOptions,
} from './platform-bridge.js';
import type { MeshData } from './types.js';

export interface WebSocketBridgeOptions {
  /** Backend URL. Accepts ws(s):// or http(s):// (mapped to ws(s)); the
   *  `/geometry` endpoint is appended when the path is empty. */
  url: string;
  /** Override the health-probe URL. Derived from `url` (→ http(s) `/health`) otherwise. */
  healthUrl?: string;
  /** Health-probe timeout (ms). Generous by default (20s) because the probe can
   *  surface a Local Network Access permission prompt the user must answer; an
   *  absent helper still fails fast (connection refused), so the long ceiling
   *  only bounds an ignored prompt. Default 20000. */
  healthTimeoutMs?: number;
}

const GEOMETRY_PATH = '/geometry';
const HEALTH_PATH = '/health';

function bytesOf(content: string | Uint8Array): Uint8Array {
  return typeof content === 'string' ? new TextEncoder().encode(content) : content;
}

function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

/** Normalize any ws(s)/http(s) URL to a ws(s) URL targeting `/geometry`. */
function normalizeGeometryUrl(raw: string): string {
  const url = new URL(raw);
  if (url.protocol === 'https:') url.protocol = 'wss:';
  else if (url.protocol === 'http:') url.protocol = 'ws:';
  if (url.protocol !== 'ws:' && url.protocol !== 'wss:') {
    throw new Error(`WebSocketBridge: unsupported protocol in "${raw}"`);
  }
  if (url.pathname === '' || url.pathname === '/') url.pathname = GEOMETRY_PATH;
  return url.toString();
}

/** Derive the http(s) `/health` URL from the geometry ws(s) URL. */
function deriveHealthUrl(geometryWsUrl: string): string {
  const url = new URL(geometryWsUrl);
  url.protocol = url.protocol === 'wss:' ? 'https:' : 'http:';
  url.pathname = HEALTH_PATH;
  return url.toString();
}

/** Map the server's `done` stats payload (camelCase) to {@link GeometryStats}. */
function toGeometryStats(raw: unknown): GeometryStats {
  const s = (raw ?? {}) as Record<string, number | undefined>;
  return {
    totalMeshes: s.totalMeshes ?? 0,
    totalVertices: s.totalVertices ?? 0,
    totalTriangles: s.totalTriangles ?? 0,
    parseTimeMs: s.parseTimeMs ?? 0,
    entityScanTimeMs: s.entityScanTimeMs,
    lookupTimeMs: s.lookupTimeMs,
    preprocessTimeMs: s.preprocessTimeMs,
    geometryTimeMs: s.geometryTimeMs ?? 0,
    totalTimeMs: s.totalTimeMs,
  };
}

interface ControlFrame {
  type?: string;
  stats?: unknown;
  message?: string;
  updates?: [number, [number, number, number, number]][];
}

export class WebSocketBridge implements IPlatformBridge {
  private readonly geometryUrl: string;
  private readonly healthUrl: string;
  private readonly healthTimeoutMs: number;
  private initialized = false;

  constructor(options: string | WebSocketBridgeOptions) {
    const opts = typeof options === 'string' ? { url: options } : options;
    this.geometryUrl = normalizeGeometryUrl(opts.url);
    this.healthUrl = opts.healthUrl ?? deriveHealthUrl(this.geometryUrl);
    this.healthTimeoutMs = opts.healthTimeoutMs ?? 20000;
  }

  /**
   * Probe `/health`. A reachable, healthy helper marks the bridge initialized;
   * anything else throws so `GeometryProcessor` can fall back to WASM.
   *
   * A public-origin page reaching a loopback target is gated by the browser's
   * Local Network Access permission (Chrome 142+ for fetch, 147+ for WebSocket;
   * Firefox rolling out). `targetAddressSpace: 'local'` on the probe is what
   * triggers that permission prompt; once the user grants it for this origin,
   * the WebSocket handshake to 127.0.0.1 is allowed too (the grant is per-origin,
   * and it also relaxes mixed-content for the local target). Requires the page to
   * carry `Permissions-Policy: loopback-network=(self)` (see vercel.json). The
   * server-side `Access-Control-Allow-Private-Network` header is the legacy PNA
   * mechanism and is NOT what unblocks this.
   */
  async init(): Promise<void> {
    // Short-circuit if the user has already denied the permission for this origin
    // (avoids re-prompting / hanging). Unknown permission name on other browsers
    // (Safari, older Chrome) throws — ignore and let the probe itself decide.
    try {
      const perm = await (navigator as Navigator & {
        permissions?: { query?: (d: { name: string }) => Promise<{ state: string }> };
      }).permissions?.query?.({ name: 'loopback-network' });
      if (perm?.state === 'denied') {
        throw new Error('native backend blocked: local-network permission denied');
      }
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('native backend blocked')) throw err;
      /* permission name unsupported here — proceed; the probe will surface the result */
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.healthTimeoutMs);
    try {
      // `targetAddressSpace` is not yet in lib.dom's RequestInit. Use 'loopback'
      // for 127.0.0.1/::1 — Chrome distinguishes 'loopback' from 'local' (RFC1918
      // private) and HARD-REJECTS a mismatch ("target IP address space of `local`
      // yet the resource is in address space `loopback`"). Firefox is lenient.
      const probeInit: RequestInit & { targetAddressSpace?: string } = {
        signal: controller.signal,
        cache: 'no-store',
        targetAddressSpace: 'loopback',
      };
      const res = await fetch(this.healthUrl, probeInit);
      if (!res.ok) throw new Error(`native backend health check failed: HTTP ${res.status}`);
    } finally {
      clearTimeout(timer);
    }
    this.initialized = true;
  }

  isInitialized(): boolean {
    return this.initialized;
  }

  getApi(): unknown | null {
    return null;
  }

  /** Non-streaming: collect every batch, then compute a coordinate frame. */
  async processGeometry(content: string | Uint8Array): Promise<GeometryProcessingResult> {
    const meshes: MeshData[] = [];
    let totalVertices = 0;
    let totalTriangles = 0;
    await this.processGeometryStreaming(content, {
      onBatch: (batch) => {
        for (const mesh of batch.meshes) {
          meshes.push(mesh);
          totalVertices += mesh.positions.length / 3;
          totalTriangles += mesh.indices.length / 3;
        }
      },
    });
    // The streaming path through GeometryProcessor recomputes the frame from the
    // running CoordinateHandler; this is only for the rarely-used all-at-once API.
    const coordinateInfo = new CoordinateHandler().processMeshes(meshes);
    return { meshes, totalVertices, totalTriangles, coordinateInfo };
  }

  /**
   * Stream geometry from the native backend: open the socket, send the whole
   * IFC file as one binary frame, decode each binary packed shard into a
   * {@link GeometryBatch}, and forward colour/done/error control frames to the
   * caller's callbacks. Resolves with the final stats on `done`.
   */
  processGeometryStreaming(content: string | Uint8Array, options: StreamingOptions): Promise<GeometryStats> {
    const bytes = bytesOf(content);
    return new Promise<GeometryStats>((resolve, reject) => {
      let settled = false;
      let sequence = 0;
      let socket: WebSocket;
      try {
        socket = new WebSocket(this.geometryUrl);
      } catch (error) {
        const err = toError(error);
        options.onError?.(err);
        reject(err);
        return;
      }
      socket.binaryType = 'arraybuffer';

      const fail = (err: Error) => {
        if (settled) return;
        settled = true;
        options.onError?.(err);
        try { socket.close(); } catch { /* already closing */ }
        reject(err);
      };

      socket.onopen = () => {
        // One binary frame: the whole file. `slice()` detaches from any
        // SharedArrayBuffer backing (WebSocket.send rejects SAB views) and
        // copies exactly these bytes.
        socket.send(bytes.slice());
      };

      socket.onmessage = (event) => {
        if (event.data instanceof ArrayBuffer) {
          try {
            options.onBatch?.(decodePackedGeometryCacheShard(event.data, Date.now(), sequence++));
          } catch (error) {
            fail(toError(error));
          }
          return;
        }
        let frame: ControlFrame;
        try {
          frame = JSON.parse(event.data as string) as ControlFrame;
        } catch {
          return; // ignore non-JSON text frames
        }
        if (frame.type === 'done') {
          if (settled) return;
          settled = true;
          const stats = toGeometryStats(frame.stats);
          options.onComplete?.(stats);
          try { socket.close(); } catch { /* already closing */ }
          resolve(stats);
        } else if (frame.type === 'error') {
          fail(new Error(frame.message ?? 'native backend error'));
        } else if (frame.type === 'colorUpdate' && frame.updates && options.onColorUpdate) {
          const map = new Map<number, [number, number, number, number]>();
          for (const [id, color] of frame.updates) map.set(id, color);
          options.onColorUpdate(map);
        }
      };

      socket.onerror = () => fail(new Error(`Cannot reach native backend at ${this.geometryUrl}. Is the ifc-lite helper running?`));
      socket.onclose = () => {
        if (!settled) fail(new Error('Native backend closed the connection before completing.'));
      };
    });
  }
}

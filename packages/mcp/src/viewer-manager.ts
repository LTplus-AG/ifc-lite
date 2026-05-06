/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * ViewerManager — owns the in-process WebGL viewer for a session.
 *
 * Responsibilities:
 *   • Start/stop the @ifc-lite/viewer HTTP server (no subprocess — same Node).
 *   • Forward bim.viewer.* / bim.visibility.* through the streaming adapters
 *     so any tool that touches the SDK paint surface "just works" once the
 *     viewer is open.
 *   • Subscribe to /events SSE on the viewer, parse `picked` actions, and
 *     keep an authoritative `selection` array. Selection changes broadcast
 *     to listeners → the MCP server relays them as
 *     `notifications/resources/updated` for `ifc-lite://viewer/selection`.
 *
 * Why in-process? The viewer server is a thin HTTP server + a static HTML
 * page. Spawning a subprocess just to add the viewer would mean the MCP
 * host process can't observe SSE without a second connection — easier to
 * keep it all in one event loop.
 */

import type { ViewerServer } from '@ifc-lite/viewer-core';
import {
  createStreamingViewerAdapter,
  createStreamingVisibilityAdapter,
  startViewerServer,
} from '@ifc-lite/viewer-core';
import { EntityNode } from '@ifc-lite/query';
import type { LoadedModel } from './context.js';

export interface SelectionEvent {
  expressId: number;
  ifcType?: string;
  globalId?: string;
}

export interface ViewerState {
  port: number;
  url: string;
  modelId: string | null;
  startedAt: number;
  clientCount: number;
  selection: SelectionEvent[];
}

export type SelectionListener = (selection: SelectionEvent[], model: LoadedModel | null) => void;

export class ViewerManager {
  private server: ViewerServer | null = null;
  private port = 0;
  private startedAt = 0;
  private modelId: string | null = null;
  private currentSelection: SelectionEvent[] = [];
  private listeners = new Set<SelectionListener>();
  private sseAbort: AbortController | null = null;
  private resolveModel: (id: string | null) => LoadedModel | null;

  constructor(resolveModel: (id: string | null) => LoadedModel | null) {
    this.resolveModel = resolveModel;
  }

  isOpen(): boolean {
    return this.server !== null;
  }

  state(): ViewerState | null {
    if (!this.server) return null;
    return {
      port: this.port,
      url: `http://localhost:${this.port}/`,
      modelId: this.modelId,
      startedAt: this.startedAt,
      clientCount: this.server.clientCount(),
      selection: [...this.currentSelection],
    };
  }

  /**
   * Start the viewer for `model`. If already running for the same model,
   * returns the existing state. If a different model is requested, the
   * caller must `close()` first — we don't auto-swap to avoid surprising
   * mid-session changes.
   */
  async open(model: LoadedModel, requestedPort = 0): Promise<ViewerState> {
    if (this.server) {
      if (this.modelId === model.id) {
        return this.state() as ViewerState;
      }
      throw new Error(
        `Viewer already open for model '${this.modelId}'. Call viewer_close before switching to '${model.id}'.`,
      );
    }
    if (!model.filePath) {
      throw new Error(
        `Cannot open viewer: model '${model.id}' has no on-disk file path. The viewer streams the .ifc directly from disk.`,
      );
    }

    let resolvedPort = requestedPort;
    this.server = await startViewerServer({
      filePath: model.filePath,
      fileName: model.name,
      port: requestedPort,
      onReady: (boundPort) => {
        resolvedPort = boundPort;
      },
    });
    this.port = resolvedPort;
    this.modelId = model.id;
    this.startedAt = Date.now();
    this.currentSelection = [];
    this.subscribeToEvents();
    return this.state() as ViewerState;
  }

  close(): void {
    this.sseAbort?.abort();
    this.sseAbort = null;
    if (this.server) {
      try { this.server.close(); } catch (err) {
        // Server already disposed — surface for diagnostics, then move on.
        // eslint-disable-next-line no-console
        console.error('[viewer-manager] close error', err);
      }
    }
    this.server = null;
    this.port = 0;
    this.modelId = null;
    this.currentSelection = [];
  }

  /** Subscribe to selection changes. Returns an unsubscribe handle. */
  onSelection(listener: SelectionListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Build viewer + visibility streaming adapters bound to the running port. */
  adapters(): { viewer: ReturnType<typeof createStreamingViewerAdapter>; visibility: ReturnType<typeof createStreamingVisibilityAdapter> } | null {
    if (!this.server) return null;
    return {
      viewer: createStreamingViewerAdapter(this.port),
      visibility: createStreamingVisibilityAdapter(this.port),
    };
  }

  /** Send a one-off command via the viewer's REST API. */
  async sendCommand(action: string, payload: Record<string, unknown> = {}): Promise<void> {
    if (!this.server) throw new Error('Viewer is not open. Call viewer_open first.');
    const res = await fetch(`http://localhost:${this.port}/api/command`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, ...payload }),
    });
    if (!res.ok) {
      throw new Error(`Viewer command '${action}' failed: HTTP ${res.status}`);
    }
  }

  // ── internals ──────────────────────────────────────────────────────────

  private subscribeToEvents(): void {
    this.sseAbort = new AbortController();
    void this.consumeSse(this.sseAbort.signal).catch((err: unknown) => {
      if ((err as { name?: string }).name === 'AbortError') return;
      // eslint-disable-next-line no-console
      console.error('[viewer-manager] SSE error', err);
    });
  }

  private async consumeSse(signal: AbortSignal): Promise<void> {
    const url = `http://localhost:${this.port}/events`;
    const res = await fetch(url, { signal, headers: { Accept: 'text/event-stream' } });
    if (!res.body) return;
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx = buf.indexOf('\n\n');
      while (idx !== -1) {
        const frame = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        this.handleSseFrame(frame);
        idx = buf.indexOf('\n\n');
      }
    }
  }

  private handleSseFrame(frame: string): void {
    // Each frame is one or more `data: ...` lines.
    const dataLines = frame.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim());
    if (dataLines.length === 0) return;
    const payload = dataLines.join('\n');
    let parsed: { action?: string; expressId?: number; ifcType?: string };
    try {
      parsed = JSON.parse(payload) as typeof parsed;
    } catch {
      return;
    }
    if (parsed.action === 'picked' && typeof parsed.expressId === 'number') {
      this.handlePicked(parsed.expressId, parsed.ifcType);
    }
  }

  private handlePicked(expressId: number, ifcType?: string): void {
    const model = this.resolveModel(this.modelId);
    let globalId: string | undefined;
    if (model && model.store.entityIndex.byId.has(expressId)) {
      try {
        globalId = new EntityNode(model.store, expressId).globalId || undefined;
      } catch {
        globalId = undefined;
      }
    }
    this.currentSelection = [{ expressId, ifcType, globalId }];
    for (const listener of this.listeners) {
      try { listener(this.currentSelection, model); }
      catch (err) {
        // eslint-disable-next-line no-console
        console.error('[viewer-manager] listener error', err);
      }
    }
  }
}

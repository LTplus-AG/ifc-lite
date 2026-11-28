/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Tool/resource execution context.
 *
 * A handler receives `ToolContext` containing:
 *   - the federated model registry (one or many `BimContext` + `IfcDataStore`)
 *   - the auth scope of the caller
 *   - a `ProgressReporter` (no-op when no token is attached)
 *   - a `Logger` for structured server logs
 *   - a cancellation signal
 *
 * The registry deliberately holds the parsed `IfcDataStore` next to the
 * `BimContext` because several tools (geometry bbox, audit, schema describe)
 * need direct store access that the SDK doesn't yet surface as namespaces.
 */

import type { BimContext } from '@ifc-lite/sdk';
import type { IfcDataStore } from '@ifc-lite/parser';
import type { AuthScope } from './auth/scope.js';
import type { HeadlessLikeBackend } from './headless-backend.js';
import type { ViewerManager } from './viewer-manager.js';
import type { ToolCatalogEntry } from './tool-catalog.js';

export interface LoadedModel {
  id: string;
  name: string;
  bim: BimContext;
  store: IfcDataStore;
  /** Concrete backend, retained so mutation tools can reach the editor without reflection. */
  backend: HeadlessLikeBackend;
  filePath?: string;
  /**
   * `sourceModelIdentity(name, postUnwrapBytes)` — the same string the viewer
   * stores as `FederatedModel.sourceFingerprint`, so a `.rules.json` rule set
   * whose `targets.modelFingerprints` were authored in the viewer resolves to
   * this model in `check_rules` too (#5138). Absent when the model did not come
   * from a file this process read (it then matches no fingerprint target).
   */
  sourceFingerprint?: string;
  /**
   * The parser's `scan:` diagnostics for this model: records the scan dropped
   * (an unterminated or unescaped string, #3695/#7541) or skipped (#3395).
   * Absent when every record the file declares was read. Answers about a model
   * that has them describe less than the file holds, so `model_load` returns
   * them to the caller (#7610).
   */
  scanWarnings?: readonly string[];
  loadedAt: number;
}

export interface ModelRegistry {
  list(): LoadedModel[];
  get(id: string): LoadedModel | null;
  /**
   * Resolve the model for a tool call.
   *
   * Returns the named model when `id` is provided, the single loaded model
   * when only one is loaded, or null if the caller needs to pick.
   */
  resolve(id?: string): LoadedModel | null;
  add(model: LoadedModel): void;
  remove(id: string): boolean;
  count(): number;
  /** Called after every add or remove. Returns the unsubscribe. Optional for custom registries. */
  onChange?(listener: () => void): () => void;
}

export class InMemoryModelRegistry implements ModelRegistry {
  private models = new Map<string, LoadedModel>();
  private listeners = new Set<() => void>();

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** The change is already committed: a failing listener is reported, never thrown at the add/remove caller. */
  private changed(): void {
    for (const listener of this.listeners) {
      try { listener(); } catch (err) { console.error('[ifc-lite-mcp] model registry listener failed:', err); }
    }
  }

  list(): LoadedModel[] {
    return Array.from(this.models.values());
  }

  get(id: string): LoadedModel | null {
    return this.models.get(id) ?? null;
  }

  resolve(id?: string): LoadedModel | null {
    if (id) return this.models.get(id) ?? null;
    if (this.models.size === 1) {
      const only = this.models.values().next().value as LoadedModel | undefined;
      return only ?? null;
    }
    return null;
  }

  add(model: LoadedModel): void {
    const previous = this.models.get(model.id);
    if (previous && previous !== model) previous.backend.dispose();
    this.models.set(model.id, model);
    model.backend.setPeerScopes(() => this.list().filter(peer => peer !== model).map(peer => ({ dataStore: peer.store, view: peer.backend.getMutationView() })));
    this.changed();
  }

  remove(id: string): boolean {
    this.models.get(id)?.backend.dispose();
    const removed = this.models.delete(id);
    if (removed) this.changed();
    return removed;
  }

  count(): number {
    return this.models.size;
  }
}

export interface ProgressReporter {
  report(progress: number, message?: string, total?: number): void;
}

export const NOOP_PROGRESS: ProgressReporter = {
  report(): void { /* no progress token attached */ },
};

export type LogLevel = 'debug' | 'info' | 'notice' | 'warning' | 'error' | 'critical';

export interface Logger {
  log(level: LogLevel, message: string, data?: Record<string, unknown>): void;
}

export const SILENT_LOGGER: Logger = {
  log(): void { /* default — server attaches a real logger */ },
};

/**
 * Who is calling, transport-wise. Multi-client transports (Streamable HTTP)
 * run one `MCPServer` per session, and per-session state — the layer
 * workspace in particular (#1030) — keys off `id`.
 */
export interface SessionIdentity {
  /** Transport session id; undefined for stdio/in-process (local mode). */
  id?: string;
  /** Authenticated user identity from `AuthScope.user`; undefined when unauthenticated. */
  principal?: string;
}

export interface ToolContext {
  registry: ModelRegistry;
  scope: AuthScope;
  /** Live authorization for operations that await source materialization. */
  currentScope?: () => AuthScope;
  progress: ProgressReporter;
  log: Logger;
  /** Honoured by long-running tools; aborts when client cancels. */
  signal: AbortSignal;
  /** Server-wide config (read-only flag, bSDD endpoint, allowed paths, …). */
  config: ServerConfig;
  /** Transport session + principal; absent only in hand-rolled test contexts. */
  session?: SessionIdentity;
  /** Optional: present when the server has a managed in-process viewer. */
  viewer?: ViewerManager;
  /** The tools this caller may see, for the server manifest. Set by the server on resource reads. */
  toolCatalog?: () => ToolCatalogEntry[];
}

export interface ServerConfig {
  readOnly: boolean;
  bsddEndpoint?: string;
  /** Glob patterns the stdio server is allowed to read from. */
  allowedPaths?: string[];
  /** OCI registry host[:port] allowlist. Remote model loads are disabled when empty. */
  ociHosts?: string[];
  /** Sampling capability is opt-in per spec §10. */
  samplingEnabled: boolean;
  /** When true, the MCP CLI auto-opens the viewer at startup. */
  autoOpenViewer?: boolean;
  /** Preferred viewer port (0 = auto). */
  viewerPort?: number;
}

export const DEFAULT_CONFIG: ServerConfig = {
  readOnly: false,
  samplingEnabled: false,
};

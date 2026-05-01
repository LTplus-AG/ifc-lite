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

export interface LoadedModel {
  id: string;
  name: string;
  bim: BimContext;
  store: IfcDataStore;
  /** Concrete backend, retained so mutation tools can reach the editor without reflection. */
  backend: HeadlessLikeBackend;
  filePath?: string;
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
}

export class InMemoryModelRegistry implements ModelRegistry {
  private models = new Map<string, LoadedModel>();

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
    this.models.set(model.id, model);
  }

  remove(id: string): boolean {
    return this.models.delete(id);
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

export interface ToolContext {
  registry: ModelRegistry;
  scope: AuthScope;
  progress: ProgressReporter;
  log: Logger;
  /** Honoured by long-running tools; aborts when client cancels. */
  signal: AbortSignal;
  /** Server-wide config (read-only flag, bSDD endpoint, allowed paths, …). */
  config: ServerConfig;
  /** Optional: present when the server has a managed in-process viewer. */
  viewer?: ViewerManager;
}

export interface ServerConfig {
  readOnly: boolean;
  bsddEndpoint?: string;
  /** Glob patterns the stdio server is allowed to read from. */
  allowedPaths?: string[];
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

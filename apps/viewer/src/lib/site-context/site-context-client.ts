/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The main-thread side of `workers/siteContext.worker.ts`, on the pattern of
 * `lib/import/rhino-import-client.ts`: one worker per build, terminated when
 * the build settles or is aborted (terminating it cancels every request in
 * flight), and an injectable worker factory for tests.
 */

import type {
  SiteContextBuildRequest,
  SiteContextCategoryMessage,
  SiteContextWorkerRequest,
  SiteContextWorkerResponse,
  SiteContextWorkerStats,
} from './site-context-job';
import type { SiteContextProgress } from '@ifc-lite/site-context';

export interface SiteContextWorkerLike {
  onmessage: ((event: MessageEvent<SiteContextWorkerResponse>) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
  postMessage(message: SiteContextWorkerRequest): void;
  terminate(): void;
}

/** The build failed as a whole (coverage, every service down), with what it cost. */
export class SiteContextBuildError extends Error {
  constructor(message: string, readonly coverage: boolean, readonly stats: SiteContextWorkerStats | null) {
    super(message);
    this.name = 'SiteContextBuildError';
  }
}

const createDefaultWorker = (): SiteContextWorkerLike =>
  new Worker(new URL('../../workers/siteContext.worker.ts', import.meta.url), { type: 'module' }) as SiteContextWorkerLike;

let createWorker: () => SiteContextWorkerLike = createDefaultWorker;

/** Tests only. Pass null to restore the real worker. */
export function __setSiteContextWorkerFactoryForTest(factory: (() => SiteContextWorkerLike) | null): void {
  createWorker = factory ?? createDefaultWorker;
}

let nextId = 1;

export interface SiteContextBuildHandlers {
  onProgress?(progress: SiteContextProgress): void;
  onCategory(category: SiteContextCategoryMessage): void;
}

/** Run one build; resolves with its request statistics, rejects with `SiteContextBuildError` or an `AbortError`. */
export function buildSiteContextInWorker(
  request: SiteContextBuildRequest,
  handlers: SiteContextBuildHandlers,
  signal?: AbortSignal,
): Promise<SiteContextWorkerStats> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('Site context cancelled', 'AbortError'));
      return;
    }
    let worker: SiteContextWorkerLike;
    try {
      worker = createWorker();
    } catch (error) {
      reject(new SiteContextBuildError(`Failed to start the site-context worker: ${error instanceof Error ? error.message : String(error)}`, false, null));
      return;
    }
    const id = nextId++;
    const onAbort = () => settle(() => reject(new DOMException('Site context cancelled', 'AbortError')));
    function settle(fn: () => void): void {
      signal?.removeEventListener('abort', onAbort);
      worker.onmessage = null;
      worker.onerror = null;
      worker.terminate();
      fn();
    }
    signal?.addEventListener('abort', onAbort, { once: true });
    worker.onmessage = (event) => {
      const message = event.data;
      if (!message || message.id !== id) return;
      switch (message.type) {
        case 'progress': handlers.onProgress?.(message.progress); return;
        case 'category': handlers.onCategory(message); return;
        case 'complete': settle(() => resolve(message.stats)); return;
        case 'error': settle(() => reject(new SiteContextBuildError(message.message, message.coverage, message.stats)));
      }
    };
    worker.onerror = (event) => settle(() => reject(new SiteContextBuildError(event.message || 'The site-context worker crashed', false, null)));
    try {
      worker.postMessage({ type: 'build', id, request });
    } catch (error) {
      settle(() => reject(error instanceof Error ? error : new Error(String(error))));
    }
  });
}

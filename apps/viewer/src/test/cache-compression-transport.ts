/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { mock } from 'node:test';
import { GeometryCompressionSession, type CompressionWorkerPort } from '../../../../packages/cache/src/workers/geometry-compression-client.js';
import { handleCompressionRequest } from '../../../../packages/cache/src/workers/geometry-compression-handler.js';
import type { CompressionRequest } from '../../../../packages/cache/src/workers/geometry-compression-protocol.js';

/** The same actual codec/structured-clone transport contract used by cache's
 * worker controls. No parser, mesh result, cache entry or compression bytes
 * are substituted. This CPU fixture does not claim worker-thread scheduling. */
class RealCodecTransport implements CompressionWorkerPort {
  onmessage: CompressionWorkerPort['onmessage'] = null;
  onerror: CompressionWorkerPort['onerror'] = null;
  onmessageerror: CompressionWorkerPort['onmessageerror'] = null;
  private terminated = false;
  readonly operations: Promise<void>[] = [];
  requests = 0;

  postMessage(request: CompressionRequest, transfers: ArrayBuffer[]): void {
    if (this.terminated) throw Error('Real cache codec transport already retired');
    const received = structuredClone(request, { transfer: transfers });
    this.requests++;
    const operation = handleCompressionRequest(received, (response, outgoing) => {
      const result = structuredClone(response, { transfer: outgoing });
      if (!this.terminated) this.onmessage?.(new MessageEvent('message', { data: result }));
    }).catch(error => {
      const message = error instanceof Error ? error.message : String(error);
      if (!this.terminated && this.onerror) {
        this.onerror(new ErrorEvent('error', { message, error }));
      } else {
        console.error('[actual cache codec transport] Handler failed after retirement:', error);
        throw error;
      }
    });
    this.operations.push(operation);
  }

  terminate(): void {
    this.terminated = true;
    this.onmessage = this.onerror = this.onmessageerror = null;
  }
}

/** Replace only the EXISTING private worker factory at the transport boundary.
 * The original session protocol, automatic writer, eligibility and four-chunk
 * concurrency remain active. Do not install a global Worker: it would change
 * the canonical parser/geometry path selected by the loader under test. */
export function installRealCacheCompressionTransport(): { readonly requests: number; dispose(): Promise<void> } {
  const ports: RealCodecTransport[] = [];
  const compress = GeometryCompressionSession.prototype.compress;
  const replacement = mock.method(GeometryCompressionSession.prototype, 'compress',
    function (this: GeometryCompressionSession, bytes: Uint8Array<ArrayBuffer>) {
      Reflect.set(this, 'createWorker', () => {
        const port = new RealCodecTransport();
        ports.push(port);
        return port;
      });
      return compress.call(this, bytes);
    });
  return { get requests() { return ports.reduce((sum, port) => sum + port.requests, 0); }, async dispose() {
    replacement.mock.restore();
    for (const port of ports) port.terminate();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const outcomes = await Promise.race([
        Promise.allSettled(ports.flatMap(port => port.operations)),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(Error('Actual cache codec transport cleanup timed out')), 30000);
        }),
      ]);
      const failures = outcomes.filter(outcome => outcome.status === 'rejected');
      if (failures.length) throw new AggregateError(failures.map(outcome => outcome.reason),
        'Actual cache codec transport cleanup failed');
    } finally { if (timer !== undefined) clearTimeout(timer); }
  } };
}

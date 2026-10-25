/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

export interface ParserWorkerEngineMessage {
  type: 'wasm-module';
  id: string;
  module: WebAssembly.Module | null;
}

/** The wrapper owns one parse per worker; an unrelated or late delivery cannot satisfy it. */
export class ParserWorkerEngineModule {
  private pending: { id: string; resolve: (module: WebAssembly.Module | null) => void } | null = null;

  begin(id: string): Promise<WebAssembly.Module | null> {
    if (this.pending) throw new Error('Parser worker already has an engine-module request');
    let resolve!: (module: WebAssembly.Module | null) => void;
    const promise = new Promise<WebAssembly.Module | null>(done => { resolve = done; });
    this.pending = { id, resolve };
    return promise;
  }
  deliver(message: ParserWorkerEngineMessage): void {
    if (this.pending?.id === message.id) this.pending.resolve(message.module);
  }
  end(id: string): void { if (this.pending?.id === id) this.pending = null; }
}

/** Start parsing immediately; compilation never gates worker spawn or abort settlement. */
export function deliverCompiledParserModule(worker: Worker, id: string,
  promise: Promise<WebAssembly.Module | null>, settled: () => boolean, cancel: (error: unknown) => void): void {
  const send = (module: WebAssembly.Module | null) => {
    if (settled()) return;
    try { worker.postMessage({ type: 'wasm-module', id, module } satisfies ParserWorkerEngineMessage); }
    catch (error) { cancel(error); }
  };
  void promise.then(send, error => {
    console.warn('[WorkerParser] shared compilation failed; scanner will initialize normally:', error);
    send(null);
  });
}

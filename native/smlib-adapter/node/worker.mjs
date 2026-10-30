// SPDX-License-Identifier: MPL-2.0
// Host the unmodified browser Worker (including fault fixtures) in worker_threads.
import { parentPort, workerData } from 'node:worker_threads';
import { memoryUsage } from 'node:process';

const heap = new BigUint64Array(workerData.heap);
function sampleHeap() {
  const bytes = BigInt(memoryUsage().heapUsed);
  let previous = Atomics.load(heap, 0);
  while (bytes > previous) {
    const actual = Atomics.compareExchange(heap, 0, previous, bytes);
    if (actual === previous) break;
    previous = actual;
  }
}
globalThis.self = {
  onmessage: undefined,
  postMessage(message, transfers) {
    sampleHeap();
    parentPort.postMessage(message, transfers);
  },
  close() { parentPort.close(); },
};
sampleHeap();
await import(workerData.workerUrl);
sampleHeap();
parentPort.on('message', (data) => {
  sampleHeap();
  self.onmessage?.({ data });
});

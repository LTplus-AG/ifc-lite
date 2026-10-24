// SPDX-License-Identifier: MPL-2.0
// Independent Worker instance: never a packet mock or a production test opcode.
export async function runPatchAccuracyContract() {
  const worker = new Worker(new URL('./tests/patch-accuracy-worker.mjs', import.meta.url), { type: 'module' });
  let timer;
  try {
    return await new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new Error('patch accuracy Worker deadline')), 60_000);
      worker.onerror = (event) => reject(new Error(`patch accuracy Worker: ${event.message}`));
      worker.onmessage = ({ data }) => {
        if (data.passed !== true) reject(new Error(`patch accuracy Worker oracle: ${JSON.stringify(data)}`));
        else resolve(data);
      };
    });
  } finally {
    clearTimeout(timer);
    worker.terminate();
  }
}

// SPDX-License-Identifier: MPL-2.0
// Actual Worker/SDK regressions; results require executing the browser runner.
import { uploadSweep } from './sweep.mjs';
import { rectangleRecipe, runSweepContract } from './sweep-contract.mjs';
import { assert, request, response } from './contract.mjs';
export async function runUploadLifecycleContract(client) {
  const original = client.batch.bind(client);
  let captured = client.incarnation;
  const session = response((await original([request(1)], captured))[0]);
  const sessionId = new DataView(session.buffer).getBigUint64(0, true);
  let injected = false;
  // With maxPending=1, an ABI query occupies admission immediately before
  // commit. Preserve its completion so abort can submit after the unsent error.
  client.batch = async (frames, token) => {
    if (!injected && new DataView(frames[0]).getUint32(8, true) === 15) {
      injected = true;
      const occupying = original([request(0)], token);
      try { return await original(frames, token); }
      finally { response((await occupying)[0]); }
    }
    return original(frames, token);
  };
  try {
    let rejected = false;
    try { await uploadSweep(client, sessionId, rectangleRecipe().bytes, { loops: 1, segments: 4 }, captured); }
    catch (error) { rejected = error.submitted === false; }
    assert(injected && rejected, 'actual pre-transfer commit admission rejection');
    client.batch = original;
    // Same live session: another begin succeeds only if old upload was cleaned.
    const handle = await uploadSweep(client, sessionId, rectangleRecipe().bytes, { loops: 1, segments: 4 }, captured);
    response((await original([request(8, session, new Uint8Array(handle.bytes))], captured))[0]);
  } finally {
    client.batch = original;
    if (client.incarnation === captured) response((await original([request(2, session)], captured))[0]);
  }
  injected = false;
  captured = client.incarnation;
  // postMessage detaches frames synchronously: inspect before invoking original.
  client.batch = (frames, token) => {
    const chunk = new DataView(frames[0]).getUint32(8, true) === 14;
    const pending = original(frames, token);
    if (!injected && chunk) { injected = true; client.restart(); }
    return pending;
  };
  try {
    let rejected = false;
    try { await runSweepContract(client, captured); } catch (error) { rejected = /restarted/.test(String(error)); }
    assert(injected && rejected, 'actual restart while upload chunk is in flight');
  } finally { client.batch = original; }
  assert(client.incarnation && client.incarnation !== captured, 'replacement survives old upload cleanup');
  const recovered = await runSweepContract(client, client.incarnation);
  return { unsentCommitCleaned: true, restartedUploadCleaned: true, recovered };
}

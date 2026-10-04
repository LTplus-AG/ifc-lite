/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Self-contained Playwright callback. Refusal evidence only, after the timer;
// neither this diagnostic nor a known envelope grants appearance eligibility.
export async function captureViewerInputDiagnostic() {
  const witness = globalThis.__ifc_lite_input_witness__;
  if (!witness || typeof witness.diagnostic !== 'function') return { status: 'unavailable', reason: 'input witness diagnostic absent' };
  const raw = witness.diagnostic(), deliveries = [];
  let bytes = 0;
  for (const item of raw.deliveries) {
    const row = { index: item.index, modelId: item.modelId, admittedByteLength: item.byteLength,
      byteLength: item.buffer.byteLength, ingestions: item.ingestions,
      admittedClass: item.empty ? 'canonical-empty-v1' : 'nonempty-or-unsupported',
      association: 'Raw store delivery; not identification of a particular failed native call' };
    try {
      const count = Math.min(8, Math.floor(item.buffer.byteLength / 4));
      row.headerWords = Array.from(new Uint32Array(item.buffer, 0, count));
      const knownEmpty = item.buffer.byteLength === 32 && row.headerWords.every((v, i) => v === (i === 0 ? 0x49464e53 : i === 1 ? 1 : 0));
      row.currentClass = knownEmpty ? 'canonical-empty-v1' : item.buffer.byteLength < 32 ? 'truncated-header' : 'nonempty-or-unsupported';
      if (item.buffer.byteLength > 64 * 1024 ** 2 || (bytes += item.buffer.byteLength) > 64 * 1024 ** 2) {
        row.hash = { status: 'unavailable', reason: 'fixed diagnostic byte cap' };
      } else {
        const copy = new Uint8Array(new Uint8Array(item.buffer)).buffer;
        row.hash = { status: 'observed', sha256: Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', copy)),
          byte => byte.toString(16).padStart(2, '0')).join('') };
      }
    } catch (error) { row.observationError = String(error); }
    deliveries.push(row);
  }
  return { status: 'refusal-diagnostic-only', failure: raw.failure, revision: raw.revision,
    calls: raw.calls, deliveryCount: raw.deliveryCount, inputCount: raw.inputCount,
    firstEmptyCall: raw.firstEmptyCall, retainedBytes: raw.retainedBytes, deliveries,
    omittedDeliveries: raw.deliveryCount - deliveries.length, frozen: raw.frozen,
    scope: 'First four and first undrained raw delivery, plus first empty-call scalar shape; no eligibility or failed-call pointer attribution' };
}

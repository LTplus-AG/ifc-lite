// SPDX-License-Identifier: MPL-2.0
// This transport carries the exact version-1 native request bodies, without the
// stdio length prefix. Only C++ interprets commands or touches kernel state.
export function dispatchOwned(module, frame) {
  if (!(frame instanceof ArrayBuffer) || frame.byteLength < 12 || frame.byteLength > 4096) {
    throw new Error('invalid request frame');
  }
  // Only opcode20 success may carry the bounded source-domain v2 extension.
  const opcode = new DataView(frame).getUint32(8, true);
  const request = module._malloc(frame.byteLength);
  const outputs = module._malloc(8);
  let response = 0;
  try {
    if (!request || !outputs) throw new Error('allocation failed');
    module.HEAPU8.set(new Uint8Array(frame), request);
    const status = module._ifclite_smlib_dispatch_owned(request, frame.byteLength, outputs, outputs + 4);
    // Kernel execution can grow memory; never retain a pre-call heap view.
    const view = new DataView(module.HEAPU8.buffer);
    response = view.getUint32(outputs, true);
    const size = view.getUint32(outputs + 4, true);
    if (status !== 0) throw new Error(`malformed request or trapped dispatcher (${status})`);
    const limit = opcode === 20 ? 24532 : 4096; // includes 12-byte header
    if (!response || size < 12 || size > limit || response > module.HEAPU8.length - size)
      throw new Error('invalid response allocation');
    if (size > 4096 && view.getInt32(response + 8, true) !== 0)
      throw new Error('oversized failure response');
    return module.HEAPU8.slice(response, response + size).buffer;
  } finally {
    if (response) module._free(response);
    if (outputs) module._free(outputs);
    if (request) module._free(request);
  }
}

// SPDX-License-Identifier: MPL-2.0
import createModule from './ifclite_smlib_browser.mjs';
import { dispatchOwned } from './module.mjs';
let poisoned = false;
const ready = createModule({ print: console.debug, printErr: console.error });
// Serialize batches even while asynchronous module initialization is pending.
let serial = Promise.resolve();
self.onmessage = ({ data }) => {
  serial = serial.then(async () => {
    if (poisoned) return;
    try {
      if (!Number.isSafeInteger(data.id) || !Array.isArray(data.frames) ||
          data.frames.length === 0 || data.frames.length > 256) throw new Error('invalid command batch');
      const module = await ready;
      const frames = data.frames.map((frame) => dispatchOwned(module, frame));
      self.postMessage({ id: data.id, frames }, frames);
    } catch (error) {
      poisoned = true;
      self.postMessage({ id: data.id, fatal: String(error) });
      self.close();
    }
  });
};

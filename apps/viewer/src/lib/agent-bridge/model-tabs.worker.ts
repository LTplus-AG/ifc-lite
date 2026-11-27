/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Each top-level viewer has a private port. Only the selected port receives the fragment.
const tabs = new Map<string, WeakRef<MessagePort>>();
self.addEventListener('connect', (raw) => {
  const port = (raw as MessageEvent).ports[0];
  const id = crypto.randomUUID();
  tabs.set(id, new WeakRef(port));
  port.onmessage = ({ data }) => {
    if (data.type === 'leave') tabs.delete(id);
    if (data.type === 'discover') {
      for (const [peer, ref] of tabs) {
        const target = ref.deref();
        if (!target) tabs.delete(peer);
        else if (peer !== id) target.postMessage({ type: 'query', from: id });
      }
    } else if (['offer', 'deliver', 'received'].includes(data.type)) {
      tabs.get(data.to)?.deref()?.postMessage({ ...data, from: id });
    }
  };
});
export {};

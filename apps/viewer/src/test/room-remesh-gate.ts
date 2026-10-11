/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { IfcAPI } from '@ifc-lite/wasm';
import { applyRemeshConfig, remeshOnApi, styleWireOnApi } from '../../../../packages/geometry/src/remesh/remesh-core.js';
import { setRemeshClientFactory } from '@/lib/remesh/remesh-service';

/** Delay the real canonical native mesher; never supply fabricated mesh output. */
export function nativeRoomRemeshGate(fail = false) {
  let start!: () => void, release!: () => void, complete!: () => void;
  const entered = new Promise<void>(resolve => { start = resolve; });
  const resumed = new Promise<void>(resolve => { release = resolve; });
  const completed = new Promise<void>(resolve => { complete = resolve; });
  const api = new IfcAPI();
  setRemeshClientFactory(async config => {
    applyRemeshConfig(api, config);
    return { alive: true, dispose: () => api.free(), setConfig: next => applyRemeshConfig(api, next),
      styleWire: async bytes => styleWireOnApi(api, bytes),
      remesh: async request => {
        start();
        await resumed;
        try {
          if (fail) throw new Error('Native remesh witness failure');
          return remeshOnApi(api, request);
        } finally { complete(); }
      },
    };
  });
  return { entered, release, completed };
}

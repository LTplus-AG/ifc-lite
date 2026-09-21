/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import init, { IfcAPI } from '@ifc-lite/wasm';
import type { LandXmlSourceBuffer } from './landXmlIngest.js';
import {
  inspectLandXmlAlignmentAtDistanceWithApi,
  probeLandXmlAlignmentAtDistanceWithApi,
  probeLandXmlAlignmentAtStationWithApi,
} from './landXmlAlignmentWasm.js';

type ProbeRequest = {
  buffer: LandXmlSourceBuffer;
  alignmentSourceId: string;
  mode: 'distance' | 'station';
  value: number;
  offsetRight: number;
};

const workerScope = self as unknown as {
  onmessage: ((event: MessageEvent<ProbeRequest>) => void) | null;
  postMessage(message: unknown): void;
};

workerScope.onmessage = async (event: MessageEvent<ProbeRequest>): Promise<void> => {
  try {
    await init();
    const api = new IfcAPI();
    try {
      const probes = event.data.mode === 'distance'
        ? [probeLandXmlAlignmentAtDistanceWithApi(api, event.data.buffer, event.data.alignmentSourceId, event.data.value, event.data.offsetRight)]
        : probeLandXmlAlignmentAtStationWithApi(api, event.data.buffer, event.data.alignmentSourceId, event.data.value, event.data.offsetRight);
      const probe = probes[0];
      if (!probe) throw new Error('The displayed station is in a station-equation gap.');
      const inspection = inspectLandXmlAlignmentAtDistanceWithApi(api, event.data.buffer, event.data.alignmentSourceId, probe.distance);
      workerScope.postMessage({ ok: true, probes, inspection });
    } finally {
      api.free();
    }
  } catch (error) {
    workerScope.postMessage({ ok: false, error: error instanceof Error ? error.message : String(error) });
  }
};

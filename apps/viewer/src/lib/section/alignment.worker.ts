/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import init, { AlignmentAxisJs } from '@ifc-lite/wasm';
import { safeUtf8Decode } from '@ifc-lite/data';
import { sourceBytesFromTransferable } from '@ifc-lite/parser';
import type { AlignmentRequest, AlignmentResponse } from './alignment-contract';

let axis: AlignmentAxisJs | undefined;
let initialized: Promise<unknown> | undefined;
const dispose = () => { axis?.free(); axis = undefined; };

// One tool-scoped realm owns one evaluator. Never pin a whole-source WASM
// allocation on the render thread or in the always-on overlay worker (#2183).
self.onmessage = async (event: MessageEvent<AlignmentRequest>) => {
  const request = event.data;
  try {
    if (request.kind === 'dispose') {
      try { dispose(); self.postMessage({ id: request.id, kind: 'disposed' }); }
      finally { self.close(); }
      return;
    }
    if (request.kind === 'open') {
      dispose();
      initialized ??= init();
      await initialized;
      const source = sourceBytesFromTransferable(request.source);
      axis = new AlignmentAxisJs(safeUtf8Decode(source.materialize()), request.expressId);
    }
    if (!axis) throw new Error('Alignment evaluator is not open');
    const distance = request.kind === 'evaluate' ? request.distance : 0;
    const sample = axis.evaluate(distance);
    const response: AlignmentResponse = {
      id: request.id, ok: true,
      metadata: { expressId: axis.expressId, GlobalId: axis.GlobalId, Name: axis.Name,
        geometricHorizontalLengthMeters: axis.geometricHorizontalLengthMeters,
        approximate: axis.approximate },
      sample: { geometricHorizontalDistanceMeters: sample[0],
        point: [sample[1], sample[2], sample[3]], tangent: [sample[4], sample[5], sample[6]] },
    };
    self.postMessage(response);
  } catch (error) {
    dispose();
    const response: AlignmentResponse = { id: request.id, ok: false,
      error: error instanceof Error ? error.message : String(error) };
    self.postMessage(response);
  }
};

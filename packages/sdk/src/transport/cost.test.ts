/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { existsSync, readFileSync } from 'node:fs';
import { MessageChannel } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { IfcParser } from '@ifc-lite/parser';
import { createCostBackend } from '../cost-backend.js';
import { BimHost } from '../host.js';
import type { BimBackend, SdkRequest } from '../types.js';
import { BroadcastTransport } from './broadcast.js';
import { MessagePortTransport } from './message-port.js';

const fixturePath = fileURLToPath(
  new URL('../../../../tests/models/cost/buildingsmart-cost-composition.ifc', import.meta.url),
);
const hasFixture = existsSync(fixturePath);
if (!hasFixture) console.warn('skip: canonical cost fixture missing — run `pnpm fixtures`');

async function fixtureBackend(): Promise<BimBackend> {
  const bytes = new Uint8Array(readFileSync(fixturePath));
  const store = await new IfcParser().parseColumnar(
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    { disableWorkerScan: true },
  );
  return {
    cost: createCostBackend(() => ({ modelId: 'transport-cost', store })),
    subscribe: () => () => {},
  } as unknown as BimBackend;
}

const evaluationRequest: SdkRequest = {
  id: 'cost-evaluation',
  namespace: 'cost',
  method: 'evaluateItem',
  args: [{ modelId: 'transport-cost', expressId: 42 }],
};

describe('#4855 cost host transport', () => {
  it.skipIf(!hasFixture)('dispatches an own cost method over MessagePortTransport', async () => {
    const host = new BimHost(await fixtureBackend());
    const channel = new MessageChannel();
    host.acceptPort(channel.port1 as unknown as MessagePort);
    const transport = new MessagePortTransport(channel.port2 as unknown as MessagePort);

    try {
      await expect(transport.send(evaluationRequest)).resolves.toMatchObject({
        id: 'cost-evaluation',
        result: { Amount: '2250', Currency: 'GBP' },
      });
    } finally {
      transport.close();
      host.close();
    }
  });

  it.skipIf(!hasFixture)('dispatches an own cost method over BroadcastTransport', async () => {
    const host = new BimHost(await fixtureBackend());
    const channelName = `ifc-lite-cost-4855-${process.pid}`;
    host.listenBroadcast(channelName);
    const transport = new BroadcastTransport(channelName, { timeoutMs: 2_000 });

    try {
      await expect(transport.send(evaluationRequest)).resolves.toMatchObject({
        id: 'cost-evaluation',
        result: { Amount: '2250', Currency: 'GBP' },
      });
    } finally {
      transport.close();
      host.close();
    }
  });
});

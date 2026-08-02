/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * B3.3 tamper battery: mutations shared by the v1 and v2 batteries.
 */

import path from 'node:path';
import { endpointKernelPayload, endpointRootPayload } from './trajectory.mjs';
import { REPO_ROOT } from './build-ifc.mjs';

let computeNodeHash;
let createCertificate;
try {
  ({ computeNodeHash, createCertificate } = await import(
    path.join(REPO_ROOT, 'packages/provenance/dist/index.js')
  ));
} catch (err) {
  throw new Error(
    `tamper battery needs the built provenance package (packages/provenance/dist). Run 'pnpm --filter @ifc-lite/provenance build' first. Underlying error: ${err.message}`,
  );
}

/** The hard case: fake the kernel numbers and recompute every hash and the
 *  endpoint certificate honestly. Only re-measurement can catch this. */
export async function consistentEndpointTamper(chain) {
  const ep = chain.endpoint;
  ep.kernel.carbon -= 1000;
  ep.kernelHash = await computeNodeHash('property-set', endpointKernelPayload(ep));
  ep.endpointRoot = await computeNodeHash(
    'element', endpointRootPayload(ep.stateRoot, ep.kernelHash));
  ep.certificate = createCertificate({
    kernelVersion: chain.kernelVersion,
    trustRoot: chain.trustRoot,
    reads: ep.certificate.reads,
    writes: [
      { nodeId: 'endpoint/kernel', hash: ep.kernelHash },
      { nodeId: 'endpoint/root', hash: ep.endpointRoot },
    ],
    claims: ep.certificate.claims,
  });
  return 'endpoint: kernel carbon -= 1000 kgCO2e with ALL hashes + certificate recomputed consistently';
}

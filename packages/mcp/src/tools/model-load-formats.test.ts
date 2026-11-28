/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { fullScope, readOnlyScope } from '../auth/scope.js';
import { DEFAULT_CONFIG, InMemoryModelRegistry, NOOP_PROGRESS, SILENT_LOGGER, type ToolContext } from '../context.js';
import { source } from './__fixtures__/export-session.js';
import { modelLoad } from './discovery.js';
import { exportTools } from './export.js';

function context(): ToolContext {
  return {
    registry: new InMemoryModelRegistry(), scope: fullScope(), log: SILENT_LOGGER,
    signal: new AbortController().signal, progress: NOOP_PROGRESS,
    config: { ...DEFAULT_CONFIG, ociHosts: [] },
  };
}

const digest = (bytes: Uint8Array | string): string =>
  `sha256:${createHash('sha256').update(bytes).digest('hex')}`;

// P5b follow-up to #11583.
it('loads a local IFCX model and reads wall attributes from its tabular store', async () => {
  const filePath = fileURLToPath(new URL('../../../../apps/viewer/public/samples/hello-wall.ifcx', import.meta.url));
  const ctx = context();
  const root = await realpath(await mkdtemp(join(tmpdir(), 'mcp-ifcx-load-')));
  ctx.config.allowedPaths = [dirname(filePath), root];
  ctx.scope = readOnlyScope();
  try {
    const result = await modelLoad.handler({ file_path: filePath }, ctx);
    expect(result.structuredContent).toMatchObject({ id: 'hello-wall', schema: 'IFC5' });
    const model = ctx.registry.get('hello-wall');
    expect(model?.bim.query().byType('IfcWall').toArray().length).toBeGreaterThan(0);
    await expect(exportTools.find((tool) => tool.name === 'export_ifc')!.handler(
      { file_path: join(root, 'must-not-write.ifc') }, ctx,
    )).rejects.toMatchObject({ code: 'UNSUPPORTED_OPERATION' });
  } finally {
    ctx.registry.get('hello-wall')?.backend.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

it('refuses unconfigured OCI hosts, then loads a digest-verified STEP layer from a trusted registry', async () => {
  const layer = {
    mediaType: 'application/x-step', digest: digest(source), size: source.byteLength,
    annotations: { 'org.opencontainers.image.title': 'oci-fixture.ifc' },
  };
  const manifest = JSON.stringify({
    schemaVersion: 2,
    mediaType: 'application/vnd.oci.image.manifest.v1+json',
    config: { mediaType: 'application/vnd.oci.empty.v1+json', digest: digest('{}'), size: 2 },
    layers: [layer],
  });
  let requests = 0;
  const server = createServer((request, response) => {
    requests++;
    if (request.url === '/v2/models/test/manifests/latest') {
      response.setHeader('Content-Type', 'application/vnd.oci.image.manifest.v1+json');
      response.end(manifest);
    } else if (request.url === `/v2/models/test/blobs/${layer.digest}`) {
      response.setHeader('Content-Type', layer.mediaType);
      response.end(source);
    } else {
      response.statusCode = 404;
      response.end();
    }
  });
  const ctx = context();
  await once(server.listen(0, '127.0.0.1'), 'listening');
  try {
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('Registry did not open a TCP port');
    const registry = `127.0.0.1:${address.port}`;
    const file_path = `oci://${registry}/models/test:latest`;
    await expect(modelLoad.handler({ file_path }, ctx)).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    expect(requests).toBe(0);
    ctx.config.ociHosts = [registry];
    await expect(modelLoad.handler({ file_path }, { ...ctx, scope: readOnlyScope() }))
      .rejects.toMatchObject({ code: 'PERMISSION_DENIED', message: 'Loading an OCI model requires mutate scope.' });
    expect(requests).toBe(0);
    const response = await modelLoad.handler({ file_path }, ctx);
    expect(response.structuredContent).toMatchObject({ id: 'oci-fixture', schema: 'IFC4' });
    expect(ctx.registry.get('oci-fixture')?.bim.query().byType('IfcWall').toArray()).toHaveLength(1);
  } finally {
    ctx.registry.get('oci-fixture')?.backend.dispose();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

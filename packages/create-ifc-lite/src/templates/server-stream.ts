/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { writeFileSync } from 'fs';
import { join } from 'path';

/** Write the standalone streaming client example. */
export function writeServerStreamingExample(targetDir: string): void {
  // src/example-stream.ts - Streaming example for large files
  writeFileSync(join(targetDir, 'src', 'example-stream.ts'), `/**
 * IFC-Lite Server Streaming Example
 *
 * This example demonstrates streaming parsing for large IFC files.
 * Geometry batches are received progressively, enabling immediate rendering
 * while the server continues processing.
 *
 * Best for: Files > 50MB where you want progressive rendering
 *
 * Prerequisites:
 *   1. Start the server: docker compose up -d
 *   2. Install optional deps: npm install parquet-wasm apache-arrow
 *   3. Run: npm run example:stream <path-to-ifc>
 */

import { IfcServerClient } from '@ifc-lite/server-client';
import { readFileSync, existsSync } from 'fs';

const SERVER_URL = process.env.SERVER_URL || 'http://localhost:3001';

async function main() {
  const client = new IfcServerClient({
    baseUrl: SERVER_URL,
    timeout: 600000, // 10 minutes for very large files
  });

  // Check server
  try {
    await client.health();
    console.log('Server connected');
  } catch {
    console.error('Server not available. Start with: docker compose up -d');
    process.exit(1);
  }

  const ifcPath = process.argv[2];
  if (!ifcPath || !existsSync(ifcPath)) {
    console.log('Usage: npm run example:stream <path-to-ifc-file>');
    process.exit(1);
  }

  const nodeBuffer = readFileSync(ifcPath);
  const buffer = nodeBuffer.buffer.slice(
    nodeBuffer.byteOffset,
    nodeBuffer.byteOffset + nodeBuffer.byteLength,
  ) as ArrayBuffer;
  console.log(\`\\nStreaming: \${ifcPath} (\${(nodeBuffer.length / 1024 / 1024).toFixed(1)} MB)\`);

  // Check Parquet support
  const parquetAvailable = await client.isParquetSupported();
  if (!parquetAvailable) {
    console.error('Streaming requires parquet-wasm and apache-arrow.');
    console.error('Install with: npm install parquet-wasm apache-arrow');
    process.exit(1);
  }

  const startTime = performance.now();
  let totalMeshes = 0;
  let batchCount = 0;

  try {
    // Stream with batch callback
    const result = await client.parseParquetStream(buffer, (batch) => {
      batchCount++;
      totalMeshes += batch.meshes.length;

      // In a real app, you would render each batch immediately
      console.log(
        \`  Batch #\${batch.batch_number}: +\${batch.meshes.length} meshes \` +
        \`(decode: \${batch.decode_time_ms.toFixed(0)}ms) - Total: \${totalMeshes}\`
      );
    });

    const elapsed = performance.now() - startTime;
    console.log(\`\\nStreaming complete!\`);
    console.log(\`  Total time: \${elapsed.toFixed(0)}ms\`);
    console.log(\`  Batches received: \${batchCount}\`);
    console.log(\`  Total meshes: \${result.total_meshes}\`);
    console.log(\`  Cache key: \${result.cache_key.substring(0, 16)}...\`);

    if (result.stats) {
      console.log(\`\\nServer processing:\`);
      console.log(\`  Parse: \${result.stats.parse_time_ms}ms\`);
      console.log(\`  Geometry: \${result.stats.geometry_time_ms}ms\`);
      console.log(\`  Triangles: \${result.stats.total_triangles}\`);
    }

    // Optionally fetch full data model for properties panel
    console.log(\`\\nFetching data model for properties...\`);
    try {
      const dataModel = await client.fetchDataModel(result.cache_key);
      if (dataModel) {
        console.log(\`  Data model size: \${(dataModel.byteLength / 1024).toFixed(1)} KB\`);
      }
    } catch (error) {
      console.warn('Optional properties unavailable; streaming geometry remains available:', error);
    }

  } catch (error) {
    console.error('Streaming failed:', error);
    process.exit(1);
  }
}

main().catch(console.error);
`);

}

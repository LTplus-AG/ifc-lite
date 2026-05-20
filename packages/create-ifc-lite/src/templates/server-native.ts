/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { getPackageVersion } from '../utils/config-fixers.js';

/**
 * Scaffold a native-binary IFC processing server with TypeScript client examples.
 * No Docker required -- the server binary is downloaded and run via npm scripts.
 */
export function createServerNativeTemplate(targetDir: string, projectName: string) {
  const serverBinVersion = getPackageVersion('@ifc-lite/server-bin');
  const serverClientVersion = getPackageVersion('@ifc-lite/server-client');

  // package.json
  writeFileSync(join(targetDir, 'package.json'), JSON.stringify({
    name: projectName,
    version: '0.1.0',
    type: 'module',
    description: 'IFC processing server (native binary) with TypeScript client',
    scripts: {
      'server:start': 'npx @ifc-lite/server-bin',
      'server:download': 'npx @ifc-lite/server-bin download',
      'server:info': 'npx @ifc-lite/server-bin info',
      'example': 'npx tsx src/example.ts',
      'example:stream': 'npx tsx src/example-stream.ts',
      'build': 'tsc',
      'typecheck': 'tsc --noEmit',
    },
    dependencies: {
      '@ifc-lite/server-bin': serverBinVersion,
      '@ifc-lite/server-client': serverClientVersion,
    },
    devDependencies: {
      'typescript': '^5.3.0',
      'tsx': '^4.0.0',
      '@types/node': '^20.0.0',
    },
    optionalDependencies: {
      'parquet-wasm': '^0.6.0',
      'apache-arrow': '^17.0.0',
    },
  }, null, 2));

  // tsconfig.json
  writeFileSync(join(targetDir, 'tsconfig.json'), JSON.stringify({
    compilerOptions: {
      target: 'ES2022',
      module: 'ESNext',
      moduleResolution: 'bundler',
      strict: true,
      esModuleInterop: true,
      skipLibCheck: true,
      outDir: 'dist',
      declaration: true,
      lib: ['ES2022'],
    },
    include: ['src'],
    exclude: ['node_modules', 'dist'],
  }, null, 2));

  // .env.example
  writeFileSync(join(targetDir, '.env.example'), `# IFC-Lite Server Configuration (Native Binary)
# These environment variables configure the server

# =============================================================================
# SERVER SETTINGS
# =============================================================================

# Server port
PORT=8080

# Log level: error, warn, info, debug, trace
RUST_LOG=info

# =============================================================================
# FILE PROCESSING
# =============================================================================

# Maximum IFC file size in megabytes
MAX_FILE_SIZE_MB=500

# Request timeout in seconds
REQUEST_TIMEOUT_SECS=300

# Number of worker threads for parallel processing
# Default: number of CPU cores
WORKER_THREADS=4

# =============================================================================
# STREAMING
# =============================================================================

# Initial batch size for fast first frame
INITIAL_BATCH_SIZE=100

# Maximum batch size for throughput
MAX_BATCH_SIZE=1000

# =============================================================================
# CACHING
# =============================================================================

# Cache directory (relative or absolute path)
CACHE_DIR=./.cache

# Cache retention in days
CACHE_MAX_AGE_DAYS=7
`);

  // .gitignore
  writeFileSync(join(targetDir, '.gitignore'), `# Dependencies
node_modules/

# Build output
dist/

# Environment files
.env
.env.local
.env.*.local

# Cache directory
.cache/

# IDE
.idea/
.vscode/
*.swp
*.swo

# OS
.DS_Store
Thumbs.db

# Logs
*.log
npm-debug.log*
`);

  // Create src directory
  mkdirSync(join(targetDir, 'src'));

  // src/example.ts
  writeFileSync(join(targetDir, 'src', 'example.ts'), `/**
 * IFC-Lite Native Server Example
 *
 * This example demonstrates using the IFC-Lite server with native binary.
 * No Docker required - the binary is downloaded and run automatically.
 *
 * Usage:
 *   1. Start the server: npm run server:start
 *   2. In another terminal: npm run example ./your-model.ifc
 */

import { IfcServerClient } from '@ifc-lite/server-client';
import { readFileSync, existsSync } from 'fs';

const SERVER_URL = process.env.SERVER_URL || 'http://localhost:8080';

async function main() {
  const client = new IfcServerClient({
    baseUrl: SERVER_URL,
    timeout: 300000,
  });

  // Check server
  console.log('Checking server health...');
  try {
    const health = await client.health();
    console.log(\`Server status: \${health.status}\`);
  } catch (error) {
    console.error('Failed to connect to server.');
    console.error('Start it with: npm run server:start');
    process.exit(1);
  }

  const ifcPath = process.argv[2];
  if (!ifcPath) {
    console.log(\`
Usage: npm run example <path-to-ifc-file>

Example:
  npm run example ./model.ifc
\`);
    return;
  }

  if (!existsSync(ifcPath)) {
    console.error(\`File not found: \${ifcPath}\`);
    process.exit(1);
  }

  const nodeBuffer = readFileSync(ifcPath);
  const buffer = nodeBuffer.buffer.slice(
    nodeBuffer.byteOffset,
    nodeBuffer.byteOffset + nodeBuffer.byteLength,
  ) as ArrayBuffer;
  console.log(\`\\nParsing: \${ifcPath}\`);
  console.log(\`File size: \${(nodeBuffer.length / 1024 / 1024).toFixed(2)} MB\`);

  const startTime = performance.now();

  try {
    const parquetAvailable = await client.isParquetSupported();

    if (parquetAvailable) {
      console.log('Using Parquet format (15x smaller)');
      const result = await client.parseParquet(buffer);
      const elapsed = performance.now() - startTime;

      console.log(\`\\nComplete in \${elapsed.toFixed(0)}ms\`);
      console.log(\`  Meshes: \${result.meshes.length}\`);
      console.log(\`  Payload: \${(result.parquet_stats.payload_size / 1024).toFixed(1)} KB\`);

      if (result.stats) {
        console.log(\`  Triangles: \${result.stats.total_triangles}\`);
      }
    } else {
      console.log('Using JSON format');
      const result = await client.parse(buffer);
      const elapsed = performance.now() - startTime;

      console.log(\`\\nComplete in \${elapsed.toFixed(0)}ms\`);
      console.log(\`  Meshes: \${result.meshes.length}\`);
    }
  } catch (error) {
    console.error('Parse failed:', error);
    process.exit(1);
  }
}

main().catch(console.error);
`);

  // src/example-stream.ts
  writeFileSync(join(targetDir, 'src', 'example-stream.ts'), `/**
 * IFC-Lite Native Server Streaming Example
 *
 * For large files (>50MB) - geometry arrives in batches.
 *
 * Usage:
 *   1. Start the server: npm run server:start
 *   2. In another terminal: npm run example:stream ./large-model.ifc
 */

import { IfcServerClient } from '@ifc-lite/server-client';
import { readFileSync, existsSync } from 'fs';

const SERVER_URL = process.env.SERVER_URL || 'http://localhost:8080';

async function main() {
  const client = new IfcServerClient({
    baseUrl: SERVER_URL,
    timeout: 600000,
  });

  try {
    await client.health();
    console.log('Server connected');
  } catch {
    console.error('Server not available. Start with: npm run server:start');
    process.exit(1);
  }

  const ifcPath = process.argv[2];
  if (!ifcPath || !existsSync(ifcPath)) {
    console.log('Usage: npm run example:stream <path-to-ifc-file>');
    process.exit(1);
  }

  const parquetAvailable = await client.isParquetSupported();
  if (!parquetAvailable) {
    console.error('Streaming requires parquet-wasm and apache-arrow.');
    console.error('Install with: npm install parquet-wasm apache-arrow');
    process.exit(1);
  }

  const nodeBuffer = readFileSync(ifcPath);
  const buffer = nodeBuffer.buffer.slice(
    nodeBuffer.byteOffset,
    nodeBuffer.byteOffset + nodeBuffer.byteLength,
  ) as ArrayBuffer;
  console.log(\`\\nStreaming: \${ifcPath} (\${(nodeBuffer.length / 1024 / 1024).toFixed(1)} MB)\`);

  const startTime = performance.now();
  let totalMeshes = 0;

  try {
    const result = await client.parseParquetStream(buffer, (batch) => {
      totalMeshes += batch.meshes.length;
      console.log(\`  Batch #\${batch.batch_number}: +\${batch.meshes.length} meshes (total: \${totalMeshes})\`);
    });

    const elapsed = performance.now() - startTime;
    console.log(\`\\nComplete in \${elapsed.toFixed(0)}ms\`);
    console.log(\`  Total meshes: \${result.total_meshes}\`);

  } catch (error) {
    console.error('Streaming failed:', error);
    process.exit(1);
  }
}

main().catch(console.error);
`);

  // src/index.ts
  writeFileSync(join(targetDir, 'src', 'index.ts'), `/**
 * ${projectName} - IFC Processing Server (Native Binary)
 *
 * Re-exports for custom integrations.
 */

export { IfcServerClient } from '@ifc-lite/server-client';
export type {
  ServerConfig,
  ParseResponse,
  ParquetParseResponse,
  StreamEvent,
  HealthResponse,
  MetadataResponse,
} from '@ifc-lite/server-client';

export const DEFAULT_SERVER_URL = 'http://localhost:8080';
`);

  // README.md
  writeFileSync(join(targetDir, 'README.md'), `# ${projectName}

IFC processing server using native binary - no Docker required.

## Quick Start

\`\`\`bash
# Install dependencies (downloads server binary automatically)
npm install

# Start the server
npm run server:start

# In another terminal, run the example
npm run example ./your-model.ifc
\`\`\`

## Features

| Feature | Description |
|---------|-------------|
| **No Docker Required** | Native binary runs directly |
| **Auto-Download** | Binary downloaded on first run |
| **Cross-Platform** | macOS, Linux, Windows support |
| **Content-Addressable Cache** | Same file = instant response |

## Scripts

| Command | Description |
|---------|-------------|
| \`npm run server:start\` | Start the IFC-Lite server |
| \`npm run server:download\` | Download binary without starting |
| \`npm run server:info\` | Show platform and binary info |
| \`npm run example\` | Basic parsing example |
| \`npm run example:stream\` | Streaming example for large files |

## Configuration

Set environment variables to configure the server:

\`\`\`bash
# Custom port
PORT=3001 npm run server:start

# Debug logging
RUST_LOG=debug npm run server:start

# Multiple options
PORT=3001 WORKER_THREADS=8 npm run server:start
\`\`\`

See \`.env.example\` for all options.

## API Endpoints

| Endpoint | Description |
|----------|-------------|
| \`GET /api/v1/health\` | Health check |
| \`POST /api/v1/parse\` | Full parse (JSON) |
| \`POST /api/v1/parse/parquet\` | Full parse (Parquet, 15x smaller) |
| \`POST /api/v1/parse/parquet-stream\` | Streaming parse |
| \`GET /api/v1/cache/check/:hash\` | Check cache |

## Supported Platforms

| Platform | Architecture | Status |
|----------|--------------|--------|
| macOS | Intel (x64) | ✅ |
| macOS | Apple Silicon (arm64) | ✅ |
| Linux | x64 | ✅ |
| Linux | arm64 | ✅ |
| Windows | x64 | ✅ |

## Alternatives

If native binaries don't work for your platform:

\`\`\`bash
# Use Docker instead
npx create-ifc-lite my-app --template server
\`\`\`

## Learn More

- [IFC-Lite Documentation](https://ltplus-ag.github.io/ifc-lite/)
- [GitHub Repository](https://github.com/LTplus-AG/ifc-lite)
`);

  console.log('  Created package.json');
  console.log('  Created tsconfig.json');
  console.log('  Created .env.example');
  console.log('  Created .gitignore');
  console.log('  Created src/example.ts');
  console.log('  Created src/example-stream.ts');
  console.log('  Created src/index.ts');
  console.log('  Created README.md');
}

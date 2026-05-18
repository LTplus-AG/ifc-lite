#!/usr/bin/env node

// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * IFC-Lite Server Binary CLI
 *
 * Downloads and runs the pre-built IFC-Lite server binary.
 *
 * Usage:
 *   npx @ifc-lite/server-bin [options]
 *   npx ifc-lite-server [options]
 *
 * Environment variables are passed through to the server.
 * See: https://github.com/LTplus-AG/ifc-lite/tree/main/apps/server
 */

import { runBinary, ensureBinary, getBinaryInfo, downloadBinary } from './binary.js';
import { getPlatformDescription } from './platform.js';

const HELP_TEXT = `
IFC-Lite Server - Pre-built Binary Runner

Usage:
  npx @ifc-lite/server-bin [command] [options]
  npx ifc-lite-server [command] [options]

Commands:
  start           Start the server (default)
  download        Download binary without starting
  info            Show binary and platform info
  help            Show this help message

Environment Variables:
  PORT                    Server port (default: 8080)
  RUST_LOG               Log level: error, warn, info, debug (default: info)
  MAX_FILE_SIZE_MB       Max upload size in MB (default: 500)
  WORKER_THREADS         Parallel processing threads (default: CPU cores)
  CACHE_DIR              Cache directory (default: ./.cache)
  REQUEST_TIMEOUT_SECS   Request timeout (default: 300)
  INITIAL_BATCH_SIZE     Streaming initial batch (default: 100)
  MAX_BATCH_SIZE         Streaming max batch (default: 1000)
  CACHE_MAX_AGE_DAYS     Cache retention days (default: 7)

Examples:
  # Start server on default port
  npx @ifc-lite/server-bin

  # Start on custom port
  PORT=3001 npx @ifc-lite/server-bin

  # Download binary only (for CI/CD)
  npx @ifc-lite/server-bin download

  # Show platform info
  npx @ifc-lite/server-bin info

Documentation:
  https://github.com/LTplus-AG/ifc-lite

Alternatives:
  - Docker: npx create-ifc-lite my-app --template server
  - From source: cargo run --release -p ifc-lite-server
`;

async function main() {
  const args = process.argv.slice(2);
  const command = args[0] || 'start';

  try {
    switch (command) {
      case 'help':
      case '--help':
      case '-h':
        console.log(HELP_TEXT);
        process.exit(0);
        break;

      case 'version':
      case '--version':
      case '-v': {
        const info = getBinaryInfo();
        const pkg = await import('../package.json', { with: { type: 'json' } });
        console.log(`@ifc-lite/server-bin v${pkg.default.version}`);
        process.exit(0);
        break;
      }

      case 'info': {
        const info = getBinaryInfo();
        console.log('\nIFC-Lite Server Binary Info\n');
        console.log(`Platform:     ${getPlatformDescription(info.platform)}`);
        console.log(`Target:       ${info.platform.targetTriple}`);
        console.log(`Binary name:  ${info.platform.binaryName}`);
        console.log(`Binary path:  ${info.binaryPath}`);
        console.log(`Cache dir:    ${info.cacheDir}`);
        console.log(`Cached:       ${info.isCached ? 'Yes' : 'No'}`);
        console.log('');
        process.exit(0);
        break;
      }

      case 'download': {
        console.log('\nDownloading IFC-Lite server binary...\n');
        await downloadBinary((downloaded, total) => {
          const percent = Math.round((downloaded / total) * 100);
          const mb = (downloaded / 1024 / 1024).toFixed(1);
          const totalMb = (total / 1024 / 1024).toFixed(1);
          process.stdout.write(`\rProgress: ${percent}% (${mb}/${totalMb} MB)`);
        });
        console.log('\n\nDownload complete!');
        process.exit(0);
        break;
      }

      case 'start':
      default: {
        // Filter out 'start' command from args if present
        const serverArgs = command === 'start' ? args.slice(1) : args;

        console.log('\nStarting IFC-Lite server...\n');

        const exitCode = await runBinary(serverArgs);
        process.exit(exitCode);
        break;
      }
    }
  } catch (error) {
    console.error('\nError:', error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

main();

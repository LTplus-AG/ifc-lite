#!/usr/bin/env node
// SPDX-License-Identifier: MPL-2.0
// Isolated test-peer staging. Never replace a real engine or qualify geometry.
import { rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { runtimePeerDirectory, stageRetainedRuntimePeer } from './stage-retained-runtime-peer.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
await stageRetainedRuntimePeer();
try {
  console.log('SMLib-free runtime tests: inert protocol peer; no geometry or parity evidence');
  const child = spawn('wasm-pack', ['test', '--headless', '--chrome', '--chromedriver',
    `${root}scripts/wasm-test-mime-driver.mjs`, 'rust/wasm-bindings', '--lib',
    '--features', 'retained-browser', '--', 'retained_browser_smlib_free'], {
    cwd: root, stdio: 'inherit', env: { ...process.env, WASM_BINDGEN_TEST_TIMEOUT: '120' },
  });
  process.exitCode = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', code => resolve(code ?? 1));
  });
} finally {
  await rm(runtimePeerDirectory, { recursive: true });
}

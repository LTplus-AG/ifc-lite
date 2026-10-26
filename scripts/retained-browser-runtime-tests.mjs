#!/usr/bin/env node
// SPDX-License-Identifier: MPL-2.0
// Test-only /smlib fixture staging. Never replace a real engine or qualify geometry.
import { mkdir, copyFile, writeFile, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const output = new URL('../rust/wasm-bindings/smlib/', import.meta.url);
const fixtures = new URL('./lib/__fixtures__/retained-driver/', import.meta.url);
// Nonrecursive mkdir deliberately refuses any existing staged SDK.
await mkdir(output);
try {
  for (const name of ['peer.mjs', 'client.mjs']) await copyFile(new URL(name, fixtures), new URL(name, output));
  for (const name of ['sweep.mjs', 'sweep-contract.mjs']) {
    await writeFile(new URL(name, output), '// SPDX-License-Identifier: MPL-2.0\nexport * from "./peer.mjs";\n');
  }
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
  await rm(output, { recursive: true });
}

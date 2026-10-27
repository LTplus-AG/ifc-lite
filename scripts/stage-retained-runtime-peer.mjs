#!/usr/bin/env node
// SPDX-License-Identifier: MPL-2.0
// Test-only module resolution, equivalent to the Node driver's fixture hooks.
// Keep it separate from /smlib so real-Worker tests can run in the same browser.
import { mkdir, readFile, copyFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMainEntry } from './lib/is-main-entry.mjs';

export const runtimePeerDirectory = fileURLToPath(new URL('../rust/wasm-bindings/retained-test/', import.meta.url));

export async function stageRetainedRuntimePeer(out = runtimePeerDirectory) {
  // Never replace either an existing fixture or a real engine directory.
  await mkdir(out);
  try {
    const source = await readFile(new URL('../rust/wasm-bindings/js/retained-driver.mjs', import.meta.url), 'utf8');
    const sdkImport = 'import(/* @vite-ignore */ path)';
    if (source.split(sdkImport).length !== 2) throw new Error('Expected exactly one retained SDK module loader');
    // The production driver is exercised unchanged apart from resolving its
    // SDK modules to the protocol peer, exactly as the Node test loader does.
    await writeFile(join(out, 'retained-driver.mjs'), source.replace(sdkImport, "import('./peer.mjs')"), { flag: 'wx' });
    await copyFile(new URL('./lib/__fixtures__/retained-driver/peer.mjs', import.meta.url), join(out, 'peer.mjs'));
  } catch (error) {
    await rm(out, { recursive: true });
    throw error;
  }
}

if (isMainEntry(import.meta.url)) {
  await stageRetainedRuntimePeer();
  console.log('Staged isolated retained runtime peer; no geometry or parity evidence');
}

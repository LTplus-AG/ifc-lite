/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { resolvePackageDirFromModuleUrl, resolveWasmAssetPath } from '../src/server.js';

describe('resolvePackageDirFromModuleUrl', () => {
  it('decodes Windows file URLs without duplicating the drive prefix', () => {
    const dir = resolvePackageDirFromModuleUrl(
      'file:///C:/Users/Luis%20Felipe/AppData/Roaming/npm/node_modules/@ifc-lite/wasm/pkg/ifc-lite.js',
    );

    assert.match(dir, /Luis Felipe/);
    assert.doesNotMatch(dir, /%20/);
    assert.equal(dir.match(/C:/g)?.length ?? 0, 1);
    assert.match(dir.replaceAll('\\', '/'), /\/node_modules\/@ifc-lite\/wasm$/);
  });

  it('resolves POSIX file URLs to the package root', () => {
    const dir = resolvePackageDirFromModuleUrl(
      'file:///Users/test/node_modules/@ifc-lite/wasm/pkg/ifc-lite.js',
    );

    assert.equal(dir, '/Users/test/node_modules/@ifc-lite/wasm');
  });
});

describe('resolveWasmAssetPath', () => {
  it('resolves snippet asset requests inside the wasm pkg directory', () => {
    const assetPath = resolveWasmAssetPath(
      '/Users/test/node_modules/@ifc-lite/wasm',
      '/wasm/snippets/ifc-lite-wasm-abc123/src/helper.js',
    );

    assert.equal(
      assetPath,
      '/Users/test/node_modules/@ifc-lite/wasm/pkg/snippets/ifc-lite-wasm-abc123/src/helper.js',
    );
  });

  it('rejects path traversal outside the wasm pkg directory', () => {
    const assetPath = resolveWasmAssetPath(
      '/Users/test/node_modules/@ifc-lite/wasm',
      '/wasm/snippets/../../package.json',
    );

    assert.equal(assetPath, null);
  });

  it('rejects request paths that do not start with /wasm/, even when the remainder would resolve inside the pkg dir', () => {
    // Same length prefix as '/wasm/' (6 chars) so that, were the prefix
    // check removed, slicing off the first 6 chars would still leave a
    // plain relative path ('snippets/helper.js') resolving *inside*
    // wasmDir/pkg — i.e. this case is NOT caught by the traversal check,
    // only by the '/wasm/' prefix check itself.
    const assetPath = resolveWasmAssetPath(
      '/Users/test/node_modules/@ifc-lite/wasm',
      '/xasm/snippets/helper.js',
    );

    assert.equal(assetPath, null);
  });

  it('rejects a request that resolves to the pkg directory itself', () => {
    const assetPath = resolveWasmAssetPath(
      '/Users/test/node_modules/@ifc-lite/wasm',
      '/wasm/.',
    );

    assert.equal(assetPath, null);
  });
});

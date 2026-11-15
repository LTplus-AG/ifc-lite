/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Copy draco3d's decoder wasm into dist so the package can export it as
// `@ifc-lite/tiles3d/draco_decoder.wasm`: a bundler then serves it from the
// app without the app depending on draco3d itself (strict pnpm hides it).
import { copyFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(join(root, 'package.json'));
const source = join(dirname(require.resolve('draco3d/package.json')), 'draco_decoder.wasm');
mkdirSync(join(root, 'dist'), { recursive: true });
copyFileSync(source, join(root, 'dist', 'draco_decoder.wasm'));

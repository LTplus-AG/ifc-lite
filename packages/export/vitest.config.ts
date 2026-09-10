/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import path from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      // Before the bare `@ifc-lite/codegen` below, as the two schema subpaths
      // already are: these keys are matched as PREFIXES in declaration order,
      // so the root entry would otherwise rewrite
      // `@ifc-lite/codegen/schema-hierarchy` into the nonexistent
      // `codegen/src/index.ts/schema-hierarchy`.
      '@ifc-lite/codegen/schema-hierarchy': path.resolve(__dirname, '../codegen/src/schema-hierarchy.ts'),
      '@ifc-lite/codegen/ifc4': path.resolve(__dirname, '../codegen/generated/ifc4/index.ts'),
      '@ifc-lite/codegen/ifc4x3': path.resolve(__dirname, '../codegen/generated/ifc4x3/index.ts'),
      '@ifc-lite/codegen': path.resolve(__dirname, '../codegen/src/index.ts'),
      '@ifc-lite/data': path.resolve(__dirname, '../data/src/index.ts'),
      '@ifc-lite/encoding': path.resolve(__dirname, '../encoding/src/index.ts'),
      '@ifc-lite/geometry': path.resolve(__dirname, '../geometry/src/index.ts'),
      '@ifc-lite/ifcx': path.resolve(__dirname, '../ifcx/src/index.ts'),
      '@ifc-lite/mutations': path.resolve(__dirname, '../mutations/src/index.ts'),
      '@ifc-lite/parser': path.resolve(__dirname, '../parser/src/index.ts'),
      // `@ifc-lite/mutations` imports this; it publishes only `./dist`, and the
      // schema-conformance workflow runs this suite straight after
      // `pnpm install --ignore-scripts` with nothing built, so the bare
      // specifier fails to resolve there. Dependency-free, so src is safe.
      '@ifc-lite/regex-guard': path.resolve(__dirname, '../regex-guard/src/index.ts'),
      // ifcx's entity-extractor imports @ifc-lite/pointcloud; alias it to src so
      // the suite resolves on a clean checkout without built dists. pointcloud's
      // src pulls in no further workspace deps (only laz-perf + node builtins).
      '@ifc-lite/pointcloud': path.resolve(__dirname, '../pointcloud/src/index.ts'),
    },
  },
  test: {
    environment: 'node',
  },
});

<!-- This Source Code Form is subject to the terms of the Mozilla Public
     License, v. 2.0. If a copy of the MPL was not distributed with this
     file, You can obtain one at https://mozilla.org/MPL/2.0/. -->

# Canonical SDK stream measurement client (#6537)

This diagnostic endpoint consumes the public default
`GeometryProcessor.processParallel` stream. A fresh page accepts one exact
manifest-pinned public IFC file. Preparation verifies its size and SHA-256
before the timer starts. The timer covers processor initialization, complete
stream drain, bounded output retention and processor disposal. Hashing follows
the timer. Worker and geometry options retain their public defaults.

The copied client files preserve the previously reviewed consumer and output
identity contract. Identity covers produced flat/template positions, supported
normal arrays (including empty arrays), indices, colors, origins, decoded IFNS
occurrences/transforms and the declared complete coordinate channels. Unsupported
channels, partial normals, missing occurrences, incomplete drain and exceeded
work/retention/deadline bounds refuse. Geometry identity alone establishes no
rendered appearance, metadata completeness or faithful IFC geometry.

Bundle against a clean source worktree with a freshly built WASM runtime and
installed viewer build dependencies:

```sh
node scripts/perf/sdk-build.mjs /ABSOLUTE/SOURCE_WORKTREE \
  EXACT_SOURCE_40_HEX /ABSOLUTE/NEW_OUTPUT_DIRECTORY
```

The output must be new and outside that source worktree. The bundler resolves
Vite and plugins from that worktree and aliases geometry, data, encoding and
wasm-lifecycle to its source. A server must provide COOP/COEP isolation; the
endpoint requires the actual default pool to publish at least two workers.
This command is a bundle correctness check, not a source-build receipt,
resource admission, paired comparison or performance verdict.

Run root Turbo typechecking first to build workspace dependencies. The explicit
`pnpm typecheck:perf-sdk` no-emit program also checks these client test sources.
`pnpm test:perf-sdk-identity` runs 21 behavior controls against built runtime
dependencies, with a separate runtime resolution configuration so committed
WASM declarations are not imported as executable JavaScript. Both commands are
wired into the PR node-tests job. No end-to-end speed claim follows from them.

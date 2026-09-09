# License Headers for ifc-lite

All new source files must include the Mozilla Public License 2.0 header at the top.

Two spellings count as a declaration: the prose notice below, and the SPDX
one-liner. Either one alone is complete. Never put both on the same file.

### TypeScript / JavaScript / CSS (`.ts`, `.tsx`, `.js`, `.mjs`, `.cjs`, `.mts`, `.cts`, `.css`)
```text
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
```

### Rust (`.rs`)
```text
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
```

### Python (`.py`)
```text
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.
```

### The SPDX one-liner

```text
// SPDX-License-Identifier: MPL-2.0
```

`rust/export` uses this form throughout, and the gate accepts it there and
anywhere else. It is a complete MPL-2.0 declaration on its own, so a file
carrying it must not also get the prose notice stacked on top.

For a new file, write the prose notice for its file type unless the tree you
are adding to already uses SPDX, in which case match its neighbours.

### Where the notice goes

First line of the file, except when the file opens with a shebang. Then the
notice goes directly after it: `#!` is only a shebang when it is the first two
bytes, and a header pushed above it turns an `.mjs` file into a syntax error
and a `.py` file into a non-executable one.

A shebang is a leading `#!` in a `.js`/`.mjs`/`.cjs`/`.ts`/`.tsx`/`.mts`/`.cts`
or `.py` file. In Rust a leading `#![...]` is an INNER ATTRIBUTE, not a
shebang, and the notice goes ABOVE it on line 1 —
`rust/core/fuzz/fuzz_targets/parse_entity.rs` is the one file in the repo where
this comes up.

### Enforcement

```sh
node scripts/add-license-headers.mjs --check   # reports what is missing
node scripts/add-license-headers.mjs           # writes the missing headers
```

CI runs the `--check` mode as the `license-headers` job in
`.github/workflows/test.yml`. The file types in scope, the two accepted
spellings, and the generated trees that are exempt are all defined in
`scripts/lib/license-header.mjs`, which is where to change them.

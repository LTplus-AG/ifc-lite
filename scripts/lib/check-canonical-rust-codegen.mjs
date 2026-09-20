/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Regenerate and compare the two public Rust artifacts. These live beside
 * the crate-private version registries, so their freshness must be proven
 * independently (#4203/#5054).
 */
export function checkCanonicalRustCodegen({ root, tmp, runCodegenCli }) {
  const canonicalOut = join(tmp, 'rust-canonical');
  const schemas = join(root, 'packages/codegen/schemas');
  runCodegenCli(
    root,
    join(schemas, 'IFC4X3.exp'),
    join(tmp, 'canonical-ts'),
    canonicalOut,
    {
      supplementalSchemas: [
        join(schemas, 'IFC4_ADD2_TC1.exp'),
        join(schemas, 'IFC2X3_TC1.exp'),
      ],
    },
  );

  return ['schema.rs', 'type_ids.rs'].map((file) => {
    const fresh = join(canonicalOut, file);
    const committed = join(root, 'rust/core/src/generated', file);
    const bothExist = existsSync(fresh) && existsSync(committed);
    return {
      name: `rust/core/src/generated/${file} (canonical IFC4X3 type universe)`,
      ok: bothExist && readFileSync(fresh).equals(readFileSync(committed)),
      missing: existsSync(committed) && !existsSync(fresh) ? [file] : [],
      extra: existsSync(fresh) && !existsSync(committed) ? [file] : [],
      differing: bothExist && !readFileSync(fresh).equals(readFileSync(committed)) ? [file] : [],
    };
  });
}

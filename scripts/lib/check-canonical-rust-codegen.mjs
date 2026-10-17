/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Regenerate and compare the public Rust artifacts (schema, type ids, mod, slots). These live beside
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
      // Every other bundled release feeds the generated typed slots (F3e-0b).
      slotSchemas: [
        join(schemas, 'IFC2X3_TC1.exp'),
        join(schemas, 'IFC4_ADD2_TC1.exp'),
        join(schemas, 'IFC4X1.exp'),
        join(schemas, 'IFC4X2.exp'),
      ],
      slotRenames: join(schemas, 'attribute-renames.json'),
    },
  );

  // mod.rs is emitted unformatted by the same canonical run (its re-exports
  // are public API, e.g. `SchemaVersion` since #7780), so it is compared too.
  return ['schema.rs', 'type_ids.rs', 'mod.rs', 'slots.rs', 'slots_table.rs'].map((file) => {
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

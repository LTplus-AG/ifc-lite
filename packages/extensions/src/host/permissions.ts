/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Capability → SandboxPermissions translation.
 *
 * The existing `@ifc-lite/sandbox` uses a coarse boolean-flag permission
 * model (one flag per `bim.<namespace>`). The extension system declares
 * fine-grained capabilities (`model.mutate:Pset_*.FireRating`). This
 * module is the **defence-in-depth outer ring**: it derives the
 * coarsest matching permission flags so the sandbox can refuse a whole
 * namespace when nothing in it was granted. Per-method capability
 * checking happens in the bridge adapter (see `runtime.ts`), not here.
 *
 * Mapping rules (see `02-security.md §3.1` for the canonical capability
 * catalogue):
 *
 *   model.read      → query: true, model: true
 *   model.mutate:*  → mutate: true
 *   model.create    → store: true       // creation modifies the document
 *   model.delete    → store: true
 *   viewer.<any>    → viewer: true
 *   export.<any>    → export: true, files: true
 *   storage.local   → (handled by ctx.storage; no sandbox flag)
 *   network.fetch:* → (handled by ctx.fetch; no sandbox flag)
 *   command.invoke  → (handled by host dispatcher; no sandbox flag)
 *   ui.<any>        → (slot system; no sandbox flag)
 *
 * Note: lens permission stays true by default — `bim.lens.presets()`
 * is metadata, not authority.
 */

import type { Capability } from '../types.js';

/**
 * Subset of @ifc-lite/sandbox's `SandboxPermissions` we are responsible
 * for setting. Importing the real type from `@ifc-lite/sandbox` would
 * couple this package to a runtime we want to keep optional, so we
 * mirror the shape. The host that owns both wires them together; the
 * compile-time check sits at that boundary.
 */
export interface SandboxPermissionsLike {
  model?: boolean;
  query?: boolean;
  viewer?: boolean;
  mutate?: boolean;
  store?: boolean;
  lens?: boolean;
  export?: boolean;
  files?: boolean;
}

/**
 * Derive sandbox permissions from a granted capability set.
 *
 * Every flag defaults to false unless at least one capability in the
 * set unlocks it. Anything not gated by a SandboxPermissions flag
 * (storage, network, command, ui) is the caller's responsibility — the
 * runtime handles those via the `ctx` object, not the sandbox.
 */
export function capabilitiesToPermissions(
  grants: readonly Capability[],
): Required<SandboxPermissionsLike> {
  const perms: Required<SandboxPermissionsLike> = {
    model: false,
    query: false,
    viewer: false,
    mutate: false,
    store: false,
    lens: true, // metadata only — always available
    export: false,
    files: false,
  };

  for (const cap of grants) {
    switch (cap.scope) {
      case 'model':
        switch (cap.action) {
          case 'read':
            perms.model = true;
            perms.query = true;
            break;
          case 'mutate':
            perms.model = true;
            perms.query = true;
            perms.mutate = true;
            break;
          case 'create':
          case 'delete':
            perms.model = true;
            perms.query = true;
            perms.store = true;
            break;
          // unknown model.* actions: leave flags conservative (false).
        }
        break;
      case 'viewer':
        perms.viewer = true;
        break;
      case 'export':
        perms.export = true;
        perms.files = true;
        break;
      // storage, network, command, ui — outside the sandbox flag surface.
    }
  }

  return perms;
}

/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The viewer's structural write path (#9668): the SDK factory and, through
 * it, every `@ifc-lite/create` structural builder. Loaded on its own by
 * `store-adapter-structural.ts`; import it only through that module.
 *
 * It holds nothing else on purpose. The collab gate and undo tracking live in
 * the facade, which is eager anyway: a lazy module that imports from an eager
 * one makes the bundler split the shared code into new startup chunks, which
 * gave back most of what moving the builders saved (scripts/perf/README.md).
 */

export { createStructuralStoreBackend } from '@ifc-lite/sdk';

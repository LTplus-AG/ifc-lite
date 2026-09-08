/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The two Vite-isms that stop a viewer component from being imported under
 * `tsx --test`, resolved once for the whole suite (#2434).
 *
 * Both of these read as permanent walls the first time you hit them, and three
 * test files wrote them down as one: "reads the store directly via
 * `useViewerStore`, so it cannot be mounted under `tsx --test`" (a fourth,
 * measure-parity.test.tsx, records the icons half of it separately). That
 * conclusion was wrong — the store is a module-level Zustand store and
 * `useViewerStore.setState()` seeds it fine — but the two real blockers under
 * it are genuine, and neither is fixable from inside a test file:
 *
 *   1. `~icons/viewer/*` are unplugin-icons VIRTUAL modules (vite.config.ts).
 *      Node has never heard of them, so importing anything that reaches
 *      `@/icons` dies with ERR_MODULE_NOT_FOUND before a line of test code
 *      runs. `resolve` below maps them to one stub component.
 *
 *   2. `import.meta.env` is a Vite define. Under Node it is `undefined`, so
 *      `isCollabEnabled()` and friends throw on property access. `load`
 *      prepends a defaulting prelude to repo modules that touch it.
 *
 * WHY `--import` AND NOT `setup-dom.ts`: module resolution for a static import
 * graph completes BEFORE any module body evaluates, so a `register()` call
 * inside the first-imported module is already too late — the `~icons` specifier
 * has been resolved (and thrown) by then. This has to be on the process's
 * `--import` flag. That non-obviousness is most of why the wall looked
 * permanent; see `apps/viewer/package.json`'s `test` script.
 *
 * Scope is deliberately narrow: `resolve` only claims the `~icons/` prefix,
 * and `load` only touches files under this repo whose source actually mentions
 * `import.meta.env`. Everything else falls through to the default loader.
 */

import { register } from 'node:module';

// The hooks themselves live in a sibling module because they run on the loader
// thread, which cannot import from here.
register('./vite-module-hooks-impl.mjs', import.meta.url);

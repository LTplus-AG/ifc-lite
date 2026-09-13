/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

export {} // module boundary (stripped by transpiler)

// Compile-only type pin — not a user-facing template. Deliberately not
// imported by ../templates.ts, so it never reaches the script editor's
// template list; it exists only so `pnpm check:templates` type-checks the
// generated `bim.structural` recursion against `bim-globals.d.ts`.
//
// Before this file's originating fix, a nested structural-load `Value` was
// declared `unknown`, so reading `.Components` off it was a TS2339 error.
// If that regresses — `Value` widening back to `unknown`, or `Components`
// losing its `Record<string, number>` shape — this assignment fails to
// compile.
const nestedComponents: Record<string, number> | undefined =
  bim.structural.activities()[0]?.AppliedLoad?.Configuration?.Entries[0]?.Value?.Components
void nestedComponents

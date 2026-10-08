/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Building a lint context: the schema tables shared with the grounding gate. */

import type { CustomPsetDecl } from '../document/types.js';
import { createGateContext, type GateContext } from '../gate/context.js';
import type { LintContext } from './types.js';

/**
 * Load the schema tables (once per process) and build a lint context.
 * Pass an existing gate context to share its tables and custom library.
 */
export async function createLintContext(
  options: { gate?: GateContext; custom?: readonly CustomPsetDecl[] } = {},
): Promise<LintContext> {
  return { gate: options.gate ?? (await createGateContext({ custom: options.custom })) };
}

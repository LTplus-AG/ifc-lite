/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Building a lint context: the schema tables shared with the grounding gate. */

import { getAttributes, type IfcAttributeInfo, type IfcSchemaVersion } from '@ifc-lite/data';
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
  const gate = options.gate ?? (await createGateContext({ custom: options.custom }));
  return { gate, attributes: await loadAttributes() };
}

const VERSIONS: readonly IfcSchemaVersion[] = ['IFC2X3', 'IFC4', 'IFC4X3', 'IFC4X3_ADD2'];

let shared: Promise<LintContext['attributes']> | undefined;

function loadAttributes(): Promise<LintContext['attributes']> {
  const byName = async (v: IfcSchemaVersion) => new Map((await getAttributes(v)).map((a: IfcAttributeInfo) => [a.name.toLowerCase(), a]));
  shared ??= Promise.all(VERSIONS.map(byName)).then(([IFC2X3, IFC4, IFC4X3, IFC4X3_ADD2]) => ({ IFC2X3, IFC4, IFC4X3, IFC4X3_ADD2 }));
  return shared;
}

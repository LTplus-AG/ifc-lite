/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Assembles the IFC catalog: a pruned basic catalog plus the IFC components
 * and functions. `createIfcCatalog` builds the API-only catalog (agent side,
 * validation, the published JSON document). A renderer passes its own
 * implementations through `createIfcCatalog({ components, functions })` and
 * gets the same id, version and instructions, so both sides cannot drift.
 */

import {
  BASIC_COMPONENTS,
  Catalog,
  V10_SPEC_FUNCTION_APIS,
  type ComponentApi,
  type FunctionApi,
} from '@a2ui/web_core/v1_0';
import { A2UI_PROTOCOL_VERSION, IFC_CATALOG_ID } from '../policy.js';
import { BASIC_COMPONENT_NAMES, IFC_COMPONENT_APIS } from './components.js';
import { BASIC_FUNCTION_NAMES, IFC_FUNCTION_APIS } from './functions.js';
import { IFC_CATALOG_INSTRUCTIONS } from './instructions.js';

const basicComponentNames = new Set<string>(BASIC_COMPONENT_NAMES);
const basicFunctionNames = new Set<string>(BASIC_FUNCTION_NAMES);

/** Every component API in the IFC catalog, basic subset first. */
export const IFC_CATALOG_COMPONENT_APIS: readonly ComponentApi[] = [
  ...BASIC_COMPONENTS.filter((c) => basicComponentNames.has(c.name)),
  ...IFC_COMPONENT_APIS,
];

/** Every function API in the IFC catalog, basic subset first. */
export const IFC_CATALOG_FUNCTION_APIS: readonly FunctionApi[] = [
  ...V10_SPEC_FUNCTION_APIS.filter((f) => basicFunctionNames.has(f.name)),
  ...IFC_FUNCTION_APIS,
];

export interface CreateIfcCatalogOptions<T extends ComponentApi, F extends FunctionApi> {
  components?: readonly T[];
  functions?: readonly F[];
}

export function createIfcCatalog<T extends ComponentApi = ComponentApi, F extends FunctionApi = FunctionApi>(
  options: CreateIfcCatalogOptions<T, F> = {},
): Catalog<T, F> {
  const components = (options.components ?? IFC_CATALOG_COMPONENT_APIS) as readonly T[];
  const functions = (options.functions ?? IFC_CATALOG_FUNCTION_APIS) as readonly F[];
  assertSameNames('component', IFC_CATALOG_COMPONENT_APIS, components);
  assertSameNames('function', IFC_CATALOG_FUNCTION_APIS, functions);
  return new Catalog<T, F>(IFC_CATALOG_ID, A2UI_PROTOCOL_VERSION, components, functions, {
    instructions: IFC_CATALOG_INSTRUCTIONS,
    title: 'ifc-lite IFC catalog',
    description: 'Layout primitives plus IFC result components bound to the loaded building models.',
  });
}

function assertSameNames(kind: string, expected: readonly { name: string }[], actual: readonly { name: string }[]): void {
  const want = new Set(expected.map((e) => e.name));
  const have = new Set(actual.map((a) => a.name));
  const missing = [...want].filter((n) => !have.has(n));
  const extra = [...have].filter((n) => !want.has(n));
  if (missing.length || extra.length) {
    throw new Error(`IFC catalog ${kind} mismatch: missing [${missing.join(', ')}], unexpected [${extra.join(', ')}]`);
  }
}

let cachedDocument: Record<string, unknown> | undefined;

/** The published catalog JSON document (what agents and MCP hosts negotiate). */
export function ifcCatalogDocument(): Record<string, unknown> {
  cachedDocument ??= createIfcCatalog().toJson();
  return structuredClone(cachedDocument);
}

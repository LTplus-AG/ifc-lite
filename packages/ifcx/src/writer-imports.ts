/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { IfcxNode, ImportNode } from './types.js';

const IFCX_SCHEMA_IMPORTS = {
  IFC_CORE: 'https://ifcx.dev/@standards.buildingsmart.org/ifc/core/ifc@v5a.ifcx',
  IFC_PROP: 'https://ifcx.dev/@standards.buildingsmart.org/ifc/core/prop@v5a.ifcx',
  USD: 'https://ifcx.dev/@openusd.org/usd@v1.ifcx',
} as const;

/** Standard schema URIs needed by attributes actually emitted. */
export function collectRequiredImports(nodes: IfcxNode[]): ImportNode[] {
  let needsIfcCore = false;
  let needsIfcProp = false;
  let needsUsd = false;

  for (const node of nodes) {
    if (!node.attributes) continue;
    for (const key of Object.keys(node.attributes)) {
      if (!needsIfcCore && (
        key === 'bsi::ifc::class' ||
        key.startsWith('bsi::ifc::presentation::') ||
        key === 'bsi::ifc::material' ||
        key === 'bsi::ifc::spaceBoundary'
      )) needsIfcCore = true;
      if (!needsIfcProp && key.startsWith('bsi::ifc::prop::')) needsIfcProp = true;
      if (!needsUsd && key.startsWith('usd::')) needsUsd = true;
      if (needsIfcCore && needsIfcProp && needsUsd) break;
    }
    if (needsIfcCore && needsIfcProp && needsUsd) break;
  }

  const imports: ImportNode[] = [];
  if (needsIfcCore) imports.push({ uri: IFCX_SCHEMA_IMPORTS.IFC_CORE });
  if (needsIfcProp) imports.push({ uri: IFCX_SCHEMA_IMPORTS.IFC_PROP });
  if (needsUsd) imports.push({ uri: IFCX_SCHEMA_IMPORTS.USD });
  return imports;
}

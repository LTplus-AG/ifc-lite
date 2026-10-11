/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Attribute `<value>` against the attribute's own type (IDS-006). An IFC
 * attribute has an XSD primitive type per entity (`IfcTask.IsMilestone`
 * is `xs:boolean`, `IfcStairFlight.NumberOfRisers` is `xs:integer`), so a
 * value that is no literal of that type (`FALSE`, `42.0`, `42,3`), or a
 * restriction on an incompatible base (an `xs:string` pattern on an
 * `xs:double` attribute), can never match.
 *
 * Checked only when the attribute's type is unambiguous: one XSD type
 * across every attribute the name resolves to on the applicability
 * entity's inheritance chain.
 */

import { getAttributeXsdTypes, type IfcEntityInfo, type IfcSchemaVersion } from '@ifc-lite/data';
import { assertGuardedRegexPattern } from '@ifc-lite/regex-guard';
import type { IDSFacet } from '../../types.js';
import type { IDSAuditIssue } from '../types.js';
import { checkRestrictionBase, checkSimpleValueLexical } from './datatype-check.js';

/** Attribute names on `chain` that the facet's name constraint selects. */
function resolveAttributeNames(name: Extract<IDSFacet, { type: 'attribute' }>['name'], chain: readonly IfcEntityInfo[]): string[] {
  const declared = chain.flatMap((entity) => entity.attributes);
  switch (name.type) {
    case 'simpleValue':
      return declared.filter((a) => a === name.value);
    case 'enumeration':
      return declared.filter((a) => name.values.includes(a));
    case 'pattern': {
      // An unsafe or uncompilable pattern resolves to nothing here; the
      // regex guard and the coherence audit are what report it.
      try {
        assertGuardedRegexPattern(name.pattern);
        const rx = new RegExp(`^(?:${name.pattern})$`);
        return declared.filter((a) => rx.test(a));
      } catch {
        return [];
      }
    }
    default:
      return [];
  }
}

function xsdTypesOnChain(version: IfcSchemaVersion, chain: readonly IfcEntityInfo[], attribute: string): readonly string[] {
  for (const entity of chain) {
    const types = getAttributeXsdTypes(version, entity.name, attribute);
    if (types) return types;
  }
  return [];
}

export function auditAttributeValueType(
  facet: Extract<IDSFacet, { type: 'attribute' }>,
  version: IfcSchemaVersion,
  chain: readonly IfcEntityInfo[],
  path: string,
  issues: IDSAuditIssue[],
): void {
  if (!facet.value) return;
  const types = new Set<string>();
  const attributes = resolveAttributeNames(facet.name, chain);
  for (const attribute of attributes) {
    const own = xsdTypesOnChain(version, chain, attribute);
    // An attribute without a known XSD type (entity- or select-typed) makes the union unknowable.
    if (own.length === 0) return;
    for (const type of own) types.add(type);
  }
  if (types.size !== 1) return;
  const [xsdType] = types;
  const label = attributes.length === 1 ? attributes[0] : attributes.join(' | ');
  checkSimpleValueLexical(facet.value, xsdType, label, `${path}.value`, 'attribute', issues);
  checkRestrictionBase(facet.value, xsdType, label, `${path}.value`, issues, 'attribute');
}

/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * What a schema conversion writes for an enum member the TARGET schema does
 * not define (#5365, the charter split from #5202 finding 1).
 *
 * Every case resolves to exactly one outcome, chosen from the target's own
 * declaration of the entity, and never invents a member:
 *
 *  1. `userdefined`: the target enum has `USERDEFINED` and the entity has a
 *     slot for the user-defined label (`ObjectType`/`ElementType`/
 *     `ProcessType`/`ResourceType` for a `PredefinedType`, or
 *     `UserDefined<Attribute>` for any other enum). The member becomes
 *     `.USERDEFINED.` and its name moves into that slot, the IFC idiom for
 *     "a kind this schema has no member for". The source keeps its meaning.
 *  2. `notdefined`: otherwise, if the target enum has `NOTDEFINED`, it takes
 *     that. The kind is lost, and the converter reports it.
 *  3. `omit`: otherwise, if the attribute is OPTIONAL in the target, it
 *     becomes `$`. The value is lost, and the converter reports it.
 *  4. `refuse`: otherwise there is no valid output for this value. It stays as
 *     written, the file is not valid against its header, and the converter
 *     reports it by entity and member.
 *
 * Pure, and free of package imports, so `scripts/generate-enum-reconciliation.mjs`
 * can run the same policy over the registries to write the reviewed ledger
 * (`docs/architecture/schema-enum-reconciliation.md`, `--check` in CI).
 */

/** The attribute shape this needs, a subset of the registry's `AttributeMetadata`. */
export interface EnumPolicyAttribute {
  readonly name: string;
  readonly type: string;
  readonly optional: boolean;
}

export type EnumResolution =
  | { readonly kind: 'userdefined'; readonly labelIndex: number }
  | { readonly kind: 'notdefined' }
  | { readonly kind: 'omit' }
  | { readonly kind: 'refuse' };

/** The user-defined label slot a `PredefinedType` pairs with, by supertype. */
const PREDEFINED_TYPE_LABEL_SLOTS = ['ObjectType', 'ElementType', 'ProcessType', 'ResourceType'];

/**
 * Resolve a member the target enum lacks, for the enum attribute at `index`
 * of an entity whose target attribute list is `attributes`, given the target
 * enum's `members`.
 */
export function resolveMissingEnumMember(
  attributes: readonly EnumPolicyAttribute[],
  index: number,
  members: readonly string[],
): EnumResolution {
  const attribute = attributes[index];
  if (members.includes('USERDEFINED')) {
    const labelIndex = attribute.name === 'PredefinedType'
      ? attributes.findIndex((a) => PREDEFINED_TYPE_LABEL_SLOTS.includes(a.name))
      : attributes.findIndex((a) => a.name === `UserDefined${attribute.name}`);
    if (labelIndex >= 0) return { kind: 'userdefined', labelIndex };
  }
  if (members.includes('NOTDEFINED')) return { kind: 'notdefined' };
  if (attribute.optional) return { kind: 'omit' };
  return { kind: 'refuse' };
}

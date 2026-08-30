/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Scrub pass for the "anonymized isolated export" feature (#2934, plan A5):
 * deterministic per-type pseudonyms for `Name`/`LongName`/`Description`/`Tag`
 * on every included `IfcRoot`, `GlobalId` regeneration (the old->new map is
 * handed back as `guidMap` rather than written into the file — see
 * `AnonymizeResult.guidMap` on `anonymize-types.ts`), owner-history scrubbing
 * (`IfcPerson`/`IfcOrganization`/`IfcPersonAndOrganization`), and clearing an
 * included `IfcTypeObject`'s `HasPropertySets` slot.
 *
 * Expressed as mutations on a private `MutablePropertyView`, never as a text
 * rewrite — see the plan's "Key mechanism choice": the effective-index
 * closure walk (`effective-index.ts`) already reacts to a queued
 * `setAttribute`/`setPositionalAttribute`, so these mutations are visible to
 * `step-collection.ts`'s subset closure the same way any other overlay edit
 * is, with no second code path that could disagree about what got scrubbed.
 *
 * Deliberately does NOT use `store.entities.getTypeName` for the pseudonym
 * label despite the plan sketch spelling it that way: that table only
 * indexes product-ish entities and answers `'Unknown'` for the rest (see its
 * own doc) — including `IfcPropertySet` (an `IfcRoot` descendant this module
 * must be able to pseudonymize under `keepPropertySets`) and every
 * `IfcRel*` relationship (also `IfcRoot` descendants, per `IFC_ROOT_TYPES`).
 * `'Unknown-1'`, `'Unknown-2'`, … colliding across every such class would be
 * both a worse pseudonym AND a residual identifying signal (two entities
 * sharing a label leaks that they were originally the SAME kind of thing).
 * `normalizeIfcTypeName` off the effective index's own class answer has no
 * such gap.
 */

import type { IfcSourceBytes } from '@ifc-lite/parser';
import { getAttributeNamesAcrossSchemas, normalizeIfcTypeName } from '@ifc-lite/parser';
import { decodeStepStringLiteral, generateIfcGuid } from '@ifc-lite/encoding';
import type { MutablePropertyView } from '@ifc-lite/mutations';
import type { EffectiveEntityIndex } from './effective-index.js';
import type { AnonymizeOptions } from './anonymize-types.js';
import { attrIndex, readEntityArgs, stepSourceSchema } from './subset-entity-reader.js';
import { IFC_ROOT_TYPES } from './subset-roots.js';
import { HAS_PROPERTY_SETS_SLOT, isTypeClass } from './type-owned-psets.js';

/** `Name`/`LongName`/`Description`/`Tag` — the `IfcRoot`-declared text
 *  fields a subset export pseudonymizes when the class declares them and
 *  the source value is actually set (not already `$`). Per the decision
 *  doc: "pseudonymize Name/LongName/Description/Tag on every exported
 *  IfcRoot as `<IfcType>-<n>`". */
const PSEUDONYM_ATTRIBUTES = ['Name', 'LongName', 'Description', 'Tag'] as const;

/** Extra root-entity text fields covered by `pseudonymizeAllNames`:
 *  `IfcObject.ObjectType` (authoring tools put the family/type name there —
 *  "Basic Wall: <project> Exterior 300") and `IfcProject.Phase`. */
// `ElementType` must be HERE, not in NON_ROOT_NAME_ATTRIBUTES: `slotsFor`
// short-circuits on IFC_ROOT_TYPES, so that list is inert for IfcWallType (#3351).
const ROOT_ALL_NAMES_ATTRIBUTES = ['ObjectType', 'Phase', 'ElementType', 'ApplicableOccurrence'] as const;

/** Non-`IfcRoot` text fields covered by `pseudonymizeAllNames`. Only a
 *  quoted-string token is ever rewritten, so an enum-valued `Name`
 *  (`IfcSIUnit.Name = .METRE.`) or a `$` passes through untouched. */
// `Category` is authored text in practice ("ACME Acoustic Batt") (#3351).
const NON_ROOT_NAME_ATTRIBUTES = ['Name', 'LongName', 'Description', 'ProfileName', 'LayerSetName', 'Category'] as const;

/** Non-root classes whose `Name` is schema semantics rather than authored
 *  text, left alone by `pseudonymizeAllNames`: the authoring application
 *  (kept by decision — it is debugging signal), and property / quantity
 *  names (`FireRating`, `Width`), which are only exported at all under
 *  `keepPropertySets` and are what a property-debugging repro needs. */
function isNonRootNameExempt(typeUpper: string): boolean {
  return typeUpper === 'IFCAPPLICATION'
    // Owner-history actors are `scrubOwnerHistory`'s job (their whole
    // attribute list, not just Name), and must stay untouched when it is off.
    || typeUpper === 'IFCPERSON'
    || typeUpper === 'IFCORGANIZATION'
    || typeUpper === 'IFCPERSONANDORGANIZATION'
    || typeUpper.startsWith('IFCPROPERTY')
    || typeUpper.startsWith('IFCPHYSICAL')
    || typeUpper.startsWith('IFCQUANTITY');
}

/** The subset of `AnonymizeOptions` this pass reads. */
export type ScrubOptions = Pick<
  AnonymizeOptions,
  | 'pseudonymizeNames'
  | 'pseudonymizeAllNames'
  | 'regenerateGlobalIds'
  | 'scrubOwnerHistory'
  | 'neutralizeCurrency'
  | 'keepPropertySets'
  | 'guidRandom'
>;

/** What one `applyScrub` call produced. */
export interface ScrubResult {
  /** Original `GlobalId` -> regenerated `GlobalId`, one entry per
   *  `includedIds` `IfcRoot` entity whose GlobalId this pass actually
   *  regenerated. Empty when `regenerateGlobalIds` is `false`. */
  guidMap: Map<string, string>;
  /** How many entities this pass wrote at least one mutation for: every
   *  scrubbed `includedIds` root, plus every `IfcPerson`/`IfcOrganization`/
   *  `IfcPersonAndOrganization` found anywhere in `index` and scrubbed. */
  scrubbedCount: number;
  /** Non-fatal notices — an `includedIds` root this pass could not read (no
   *  source bytes, or a record that does not parse) or whose `GlobalId`
   *  could not be decoded, left untouched by the affected sub-step. */
  warnings: string[];
}

/**
 * Scrub `includedIds`' `IfcRoot` entities plus every owner-history entity in
 * `index`, queuing every change on `view` (never writing into `store`).
 *
 * `index` must be the EFFECTIVE index (`getEffectiveEntityIndex`), not a
 * bare source index — see that module's doc for why an overlay-created or
 * retyped entity answers differently through it. `store` need only expose
 * `source`: `readEntityArgs` reads SOURCE-backed records only, which is the
 * entire domain of what this pass mutates (it creates no entities).
 */
export function applyScrub(
  store: { readonly source: IfcSourceBytes; readonly schemaVersion?: string },
  index: EffectiveEntityIndex,
  includedIds: ReadonlySet<number>,
  view: MutablePropertyView,
  opts: ScrubOptions = {},
): ScrubResult {
  // Model's OWN schema (#3309 review finding): the sweeps below walk
  // arbitrary types, and the bundled schemas don't always agree on order.
  const schema = stepSourceSchema(store.schemaVersion);
  const pseudonymizeNames = opts.pseudonymizeNames ?? true;
  const pseudonymizeAllNames = opts.pseudonymizeAllNames ?? true;
  const regenerateGlobalIds = opts.regenerateGlobalIds ?? true;
  const scrubOwnerHistory = opts.scrubOwnerHistory ?? true;
  const neutralizeCurrency = opts.neutralizeCurrency ?? true;
  const keepPropertySets = opts.keepPropertySets ?? false;

  const guidMap = new Map<string, string>();
  const warnings: string[] = [];
  let scrubbedCount = 0;

  // Ascending expressId order, per plan A5 ("per-type counter in ascending
  // expressId order") — determinism depends on this sort, not on Set
  // insertion order, which `includedIds` makes no promise about.
  const rootIds = [...includedIds]
    .filter((id) => IFC_ROOT_TYPES.has(index.typeOf(id) ?? ''))
    .sort((a, b) => a - b);
  const pseudonymCounters = new Map<string, number>();

  for (const id of rootIds) {
    const type = index.typeOf(id);
    if (type === undefined) continue; // gone from the effective model (tombstoned); nothing to scrub

    const record = readEntityArgs(store, index, id);
    if (!record) {
      warnings.push(
        `Entity #${id} (${normalizeIfcTypeName(type)}): its source record could not be read, `
          + 'so its name/GlobalId scrub was skipped and it is exported unmodified.',
      );
      continue;
    }
    let touched = false;

    if (regenerateGlobalIds) {
      const guidIdx = attrIndex(type, 'GlobalId', schema);
      const oldGuid = guidIdx !== -1 ? decodeQuotedStepString(record.args[guidIdx]) : null;
      if (oldGuid !== null) {
        const newGuid = generateIfcGuid(opts.guidRandom);
        // Positional: `setAttribute` re-resolves the slot by name at
        // serialize time via `step-attribute-mutations.ts`'s own (still
        // pinned-IFC4-first) lookup, undoing `guidIdx` above (#3309).
        view.setPositionalAttribute(id, guidIdx, newGuid);
        guidMap.set(oldGuid, newGuid);
        touched = true;
      } else {
        warnings.push(
          `Entity #${id} (${normalizeIfcTypeName(type)}): its GlobalId could not be read, `
            + 'so it was not regenerated.',
        );
      }
    }

    if (pseudonymizeNames || pseudonymizeAllNames) {
      const pseudonym = nextPseudonym(pseudonymCounters, type);
      const attrs: readonly string[] = [
        ...(pseudonymizeNames ? PSEUDONYM_ATTRIBUTES : []),
        ...(pseudonymizeAllNames ? ROOT_ALL_NAMES_ATTRIBUTES : []),
      ];
      for (const attr of attrs) {
        const idx = attrIndex(type, attr, schema);
        if (idx === -1 || idx >= record.args.length || !isQuotedStepString(record.args[idx])) continue;
        view.setPositionalAttribute(id, idx, pseudonym); // positional — see the GlobalId write above
        touched = true;
      }
    }

    if (!keepPropertySets && isTypeClass(type)) {
      view.setPositionalAttribute(id, HAS_PROPERTY_SETS_SLOT, null);
      touched = true;
    }

    if (touched) scrubbedCount += 1;
  }

  if (pseudonymizeAllNames) {
    scrubbedCount += pseudonymizeNonRootNames(store, index, view, pseudonymCounters);
  }

  if (scrubOwnerHistory || neutralizeCurrency) {
    for (const [id, ref] of index) {
      const type = index.typeOf(id) ?? ref.type.toUpperCase();
      if (type === 'IFCMONETARYUNIT') {
        if (neutralizeCurrency && neutralizeMonetaryUnit(store, index, view, id)) scrubbedCount += 1;
        continue;
      }
      if (!scrubOwnerHistory) continue;
      // Below (and IFCMONETARYUNIT above): FIXED literal types, each
      // slot checked directly against all three `ENTITIES_*` tables — no
      // `schema` argument needed (unlike the arbitrary-type sweeps above).
      switch (type) {
        case 'IFCPERSON':
          scrubPerson(view, id);
          scrubbedCount += 1;
          break;
        case 'IFCORGANIZATION':
          scrubOrganization(view, id);
          scrubbedCount += 1;
          break;
        case 'IFCPERSONANDORGANIZATION': {
          const rolesIdx = attrIndex('IFCPERSONANDORGANIZATION', 'Roles');
          if (rolesIdx !== -1) view.setPositionalAttribute(id, rolesIdx, null);
          scrubbedCount += 1;
          break;
        }
        case 'IFCOWNERHISTORY': {
          // Dates pin the model to a project timeline: creation -> epoch 0
          // (the attribute is mandatory, an IfcTimeStamp INTEGER), last
          // modification -> $ (optional).
          const createdIdx = attrIndex('IFCOWNERHISTORY', 'CreationDate');
          const modifiedIdx = attrIndex('IFCOWNERHISTORY', 'LastModifiedDate');
          if (createdIdx !== -1) view.setPositionalAttribute(id, createdIdx, 0);
          if (modifiedIdx !== -1) view.setPositionalAttribute(id, modifiedIdx, null);
          scrubbedCount += 1;
          break;
        }
        case 'IFCAPPLICATION': {
          // Keep ApplicationFullName/ApplicationIdentifier (the tool), drop
          // Version (a vendor build string can carry the licence region).
          const versionIdx = attrIndex('IFCAPPLICATION', 'Version');
          if (versionIdx !== -1) view.setPositionalAttribute(id, versionIdx, null);
          scrubbedCount += 1;
          break;
        }
        default:
          break;
      }
    }
  }

  return { guidMap, scrubbedCount, warnings };
}

/**
 * `IfcMonetaryUnit.Currency` -> US dollars, in the source file's own spelling:
 * IFC2X3 declares it as the `IfcCurrencyEnum` (`.NOK.`), IFC4+ as an
 * `IfcLabel` (`'NOK'`). Returns whether a mutation was queued.
 */
function neutralizeMonetaryUnit(
  store: { readonly source: IfcSourceBytes },
  index: EffectiveEntityIndex,
  view: MutablePropertyView,
  id: number,
): boolean {
  const idx = attrIndex('IFCMONETARYUNIT', 'Currency');
  if (idx === -1) return false;
  const record = readEntityArgs(store, index, id);
  const token = record?.args[idx];
  if (token === undefined || token === '$') return false;
  const usd = token.startsWith('.') ? '.USD.' : 'USD';
  if (token === '.USD.' || token === "'USD'") return false;
  view.setPositionalAttribute(id, idx, usd);
  return true;
}

/** Next `<IfcType>-<n>` for `typeUpper`, advancing its per-type counter. */
function nextPseudonym(counters: Map<string, number>, typeUpper: string): string {
  const typeName = normalizeIfcTypeName(typeUpper);
  const n = (counters.get(typeName) ?? 0) + 1;
  counters.set(typeName, n);
  return `${typeName}-${n}`;
}

function isQuotedStepString(token: string | undefined): boolean {
  return token !== undefined && token.length >= 2 && token[0] === "'" && token[token.length - 1] === "'";
}

/**
 * `pseudonymizeAllNames` for the non-`IfcRoot` half: walk EVERY entity in
 * `index` (not just `includedIds` — styles, materials, layers and profiles
 * reach the export through the forward closure, which only exists after the
 * exporter runs) and pseudonymize each quoted-string
 * `NON_ROOT_NAME_ATTRIBUTES` slot. A mutation queued on an entity the
 * closure never reaches is simply never serialized, so over-approximating
 * here costs nothing but time, and the per-type slot lookup is cached so the
 * walk touches source bytes only for classes that declare such a slot.
 * Returns how many entities received at least one mutation.
 */
function pseudonymizeNonRootNames(
  store: { readonly source: IfcSourceBytes; readonly schemaVersion?: string },
  index: EffectiveEntityIndex,
  view: MutablePropertyView,
  counters: Map<string, number>,
): number {
  // Same schema-aware resolution as `applyScrub`'s root pass: this walks
  // every non-root type (materials, styles, layers, profiles, …), e.g.
  // IFC2X3's `IfcApprovalRelationship.Name` sits at slot 3, IFC4's at 0.
  const schema = stepSourceSchema(store.schemaVersion);
  const slotsByType = new Map<string, ReadonlyArray<readonly [name: string, idx: number]>>();
  const slotsFor = (typeUpper: string) => {
    let slots = slotsByType.get(typeUpper);
    if (slots === undefined) {
      slots = IFC_ROOT_TYPES.has(typeUpper) || isNonRootNameExempt(typeUpper)
        ? []
        : NON_ROOT_NAME_ATTRIBUTES
          .map((name) => [name, attrIndex(typeUpper, name, schema)] as const)
          .filter(([, idx]) => idx !== -1);
      slotsByType.set(typeUpper, slots);
    }
    return slots;
  };

  // Ascending expressId for the same determinism guarantee as the root pass.
  const ids: number[] = [];
  for (const [id] of index) ids.push(id);
  ids.sort((a, b) => a - b);

  let scrubbed = 0;
  for (const id of ids) {
    const type = index.typeOf(id);
    if (type === undefined) continue;
    const slots = slotsFor(type);
    if (slots.length === 0) continue;
    const record = readEntityArgs(store, index, id);
    if (!record) continue; // overlay-created (e.g. the placement clones) or unreadable: nothing authored to scrub
    let pseudonym: string | null = null;
    for (const [, idx] of slots) {
      if (idx >= record.args.length || !isQuotedStepString(record.args[idx])) continue;
      pseudonym ??= nextPseudonym(counters, type);
      view.setPositionalAttribute(id, idx, pseudonym); // positional — same reasoning as `applyScrub`'s writes
    }
    if (pseudonym !== null) scrubbed += 1;
  }
  return scrubbed;
}

/**
 * Decode a raw STEP string-literal token (`'…'`, quotes still attached, as
 * `SubsetEntityArgs.args` holds it — see `subset-entity-reader.ts`) to its
 * Unicode value, or `null` when the token is not a quoted string: `$`, a
 * numeric/enum/reference token, or simply absent because the record's
 * trailing optional arguments were omitted short.
 */
function decodeQuotedStepString(token: string | undefined): string | null {
  if (token === undefined || token.length < 2 || token[0] !== "'" || token[token.length - 1] !== "'") {
    return null;
  }
  return decodeStepStringLiteral(token.slice(1, -1));
}

/** `IfcPerson.FamilyName` -> `'Anonymous'`; every other declared attribute
 *  (`Identification`, `GivenName`, `MiddleNames`, `PrefixTitles`,
 *  `SuffixTitles`, `Roles`, `Addresses`) -> `$`. Per the decision doc the
 *  ENTIRE attribute list is identifying fields/Roles/Addresses, but a total
 *  wipe emits `IFCPERSON($,$,$,$,$,$,$,$)`, which violates the schema's
 *  `IdentifiablePersonName` WHERE rule (`Identification`, `FamilyName`, or
 *  `GivenName` must be set) — a validator or strict viewer can then reject
 *  the very file this export exists to hand to a maintainer. Keeping one
 *  fixed, non-identifying `FamilyName` satisfies the rule without leaking
 *  anything. Schema-driven (`getAttributeNamesAcrossSchemas`) rather than a
 *  hardcoded slot count, the same way every other positional write in this
 *  package resolves slots. */
function scrubPerson(view: MutablePropertyView, id: number): void {
  const names = getAttributeNamesAcrossSchemas('IFCPERSON');
  const familyNameIdx = names.indexOf('FamilyName');
  for (let i = 0; i < names.length; i++) {
    if (i === familyNameIdx) continue;
    view.setPositionalAttribute(id, i, null);
  }
  view.setAttribute(id, 'FamilyName', 'Anonymous');
}

/** `IfcOrganization.Name` -> `'Anonymous'`; every other declared attribute
 *  (`Identification`, `Description`, `Roles`, `Addresses`) -> `$`. */
function scrubOrganization(view: MutablePropertyView, id: number): void {
  const names = getAttributeNamesAcrossSchemas('IFCORGANIZATION');
  const nameIdx = names.indexOf('Name');
  for (let i = 0; i < names.length; i++) {
    if (i === nameIdx) continue;
    view.setPositionalAttribute(id, i, null);
  }
  view.setAttribute(id, 'Name', 'Anonymous');
}

/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `exportAnonymizedSubset` (#2934, the "anonymized isolated export" feature,
 * plan A2 "Orchestrator" row): given a caller-picked `includedIds` selection
 * (typically `RelatedEntities.all` from `related-entities.ts`), produces a
 * STEP file that contains ONLY that subset, with every project-identifying
 * signal removed while the geometry-relevant local transformations
 * (rotations, non-orthogonal cuts) survive — so a parsing bug reproduction
 * keeps reproducing.
 *
 * Per the plan's "Key mechanism choice": anonymization is expressed as
 * mutations on a PRIVATE `MutablePropertyView` + `StoreEditor` — never a text
 * post-pass — fed to the same `StepExporter` every other export mode uses.
 * The overlay is scoped to one call: nothing here writes into `store`, and
 * the view is discarded once `export()` returns, so two calls against the
 * same `store` never interact.
 *
 * Call order matters and is fixed:
 *  1. `pruneUnresolvableRelationships` — ahead of everything else, so a
 *     relationship this export cannot legally emit (its own mandatory,
 *     single-valued reference — or every member of a SET/LIST reference —
 *     names an entity outside `includedIds`) is removed from the ROOT set
 *     BEFORE `StepExporter` ever sees it, rather than discovered mid-closure
 *     and withheld with the generic `relationshipWithheldWarning`
 *     (`step-export-types.ts`). Reported distinctly, as
 *     `stats.prunedRelationshipIds`, for exactly this reason: a caller
 *     should be able to tell "this association is gone because the anonymizer
 *     pruned it" from "this association is gone for some other export-time
 *     reason" without grepping warning text.
 *  2. `applyPlacementAnonymization` (`anonymize-placement.ts`) — root
 *     placement zeroing and georeferencing/address blanking.
 *  3. `applyScrub` (`anonymize-scrub.ts`) — pseudonyms, GlobalId
 *     regeneration, owner-history scrub, `HasPropertySets` clearing.
 *  4. `StepExporter.export` with `subsetEntityIds` set to the PRUNED id set
 *     and the header scrubbed (`author`/`organization`/`authorization`
 *     blanked, per the decision doc — `originating_system` and
 *     `preprocessor_version` are deliberately left alone).
 *
 * 2 and 3 both read `store`/`index` and queue their edits onto the SAME
 * `view`/`editor` pair, so `StepExporter`'s closure walk (which reads the
 * overlay through `effective-index.ts`) sees every edit from both passes at
 * once — never two overlays that could disagree about the same entity.
 */

import type { IfcDataStore, IfcSourceBytes } from '@ifc-lite/parser';
import { MutablePropertyView, StoreEditor } from '@ifc-lite/mutations';
import type { IfcSchemaVersion } from './schema-converter.js';
import { getEffectiveEntityIndex, type EffectiveEntityIndex } from './effective-index.js';
import { getSubsetEntityIds, IFC_ROOT_TYPES, identifyingTypesFor } from './subset-roots.js';
import { attrIndex, readEntityArgs, stepSourceSchema } from './subset-entity-reader.js';
import {
  collectReferencedEntityIds,
  refGroupFromArg,
  relationshipRefsSurviveExclusion,
} from './reference-collector.js';
import { applyPlacementAnonymization } from './anonymize-placement.js';
import { applyScrub } from './anonymize-scrub.js';
import { StepExporter } from './step-exporter.js';
import type { AnonymizeOptions, AnonymizeResult } from './anonymize-types.js';
import { isPropertySetDefinitionClass } from './type-owned-psets.js';

/**
 * Drop every `IfcPropertySet`/`IfcElementQuantity` id out of `includedIds`
 * unless `keepPropertySets` is on (#3351 item 2, the SDK-path half `#3361`
 * left open): `applyScrub`'s `keepPropertySets` handling only ever clears an
 * `IfcTypeObject`'s `HasPropertySets` SLOT, so a pset that reached
 * `includedIds` some other way — a caller's own
 * `collectRelatedEntities(..., { IfcRelDefinesByProperties: true })` walk, or
 * a hand-built id set — survived complete, values included, with
 * `keepPropertySets` at its documented `false` default.
 *
 * DROP means EXCLUDE, not "emit scrubbed": this pass never queues a mutation
 * on a pset entity, it removes the id from the set the exporter's closure
 * ever sees, the same way the CLI's `--keep-psets` already behaves (it
 * drives both this exclusion, via `RelatedEntityOptions.IfcRelDefinesByProperties`,
 * and `keepPropertySets` from one flag) and the same way the viewer's two
 * toggles are now coupled (`AnonymizationOptionsPanel.tsx`). Scrubbing in
 * place was considered and rejected: a property/quantity VALUE is left
 * unscrubbed by design everywhere else in this module (only NAMES are
 * pseudonymized), so a scrubbed-but-kept pset would still carry
 * `IFCPROPERTYSINGLEVALUE('Owner',$,IFCTEXT('jane.doe@acme-corp.example'),$)`
 * verbatim — exactly the leak this exists to close. Exclusion is the only
 * one of the two that actually removes it.
 *
 * Must run BEFORE `pruneUnresolvableRelationships`: dropping a pset id here
 * feeds straight into that pass's `getSubsetEntityIds` exclusion set, so an
 * `IfcRelDefinesByProperties` whose `RelatingPropertyDefinition` named only a
 * now-dropped pset is pruned the same way any other relationship with an
 * excluded mandatory single-valued reference is — never left dangling.
 *
 * Returns the surviving set plus every id this pass dropped, reported
 * distinctly (the same shape `prunedRelationshipIds` already uses on
 * `AnonymizeResult.stats`) so a caller can tell "excluded because it is a
 * property set" from any other reason an id might be missing, without
 * grepping `warnings` text.
 */
function excludePropertySetsUnlessKept(
  index: EffectiveEntityIndex,
  includedIds: ReadonlySet<number>,
  keepPropertySets: boolean,
): { includedIds: Set<number>; droppedPropertySetIds: number[] } {
  if (keepPropertySets) return { includedIds: new Set(includedIds), droppedPropertySetIds: [] };

  const kept = new Set<number>();
  const droppedPropertySetIds: number[] = [];
  for (const id of includedIds) {
    if (isPropertySetDefinitionClass(index.typeOf(id))) {
      droppedPropertySetIds.push(id);
    } else {
      kept.add(id);
    }
  }
  droppedPropertySetIds.sort((a, b) => a - b);
  return { includedIds: kept, droppedPropertySetIds };
}

/**
 * Null `PropertyReference` when an emitted `IfcPropertyReferenceValue` names
 * an entity the subset excludes. The value can be reached by the forward
 * closure rather than appearing in the caller's seed set, hence `closureIds`.
 */
function dropExcludedPropertyReferences(
  store: { readonly source: IfcSourceBytes },
  index: EffectiveEntityIndex,
  closureIds: ReadonlySet<number>,
  excludedIds: ReadonlySet<number>,
  view: MutablePropertyView,
  schema: ReturnType<typeof stepSourceSchema>,
): number[] {
  const droppedIds: number[] = [];

  for (const id of closureIds) {
    if ((index.typeOf(id) ?? '') !== 'IFCPROPERTYREFERENCEVALUE') continue;
    const record = readEntityArgs(store, index, id);
    if (!record) continue;

    const idx = attrIndex('IFCPROPERTYREFERENCEVALUE', 'PropertyReference', schema);
    if (idx === -1 || idx >= record.args.length) continue;

    const ref = refGroupFromArg(record.args[idx]);
    if (typeof ref !== 'number' || !excludedIds.has(ref)) continue;

    view.setPositionalAttribute(id, idx, null);
    droppedIds.push(id);
  }

  return droppedIds;
}

/**
 * Every id in `includedIds` whose EXPRESS type is an `IfcRel*` (an
 * `IFC_ROOT_TYPES` member starting `IFCREL`), and whose own STEP record
 * `relationshipRefsSurviveExclusion` would refuse to bridge or emit — i.e.
 * one that names, in a single-valued attribute, an id NOT in `includedIds`
 * (and not infrastructure), or whose every member of a SET/LIST attribute is
 * likewise excluded. Everything ELSE in `includedIds` is left exactly as the
 * caller passed it: this only ever REMOVES relationship ids, never adds or
 * removes anything else.
 *
 * "Excluded" here is computed the same way the export's own closure would
 * (`getSubsetEntityIds`'s `excludedIds` — every `IFC_ROOT_TYPES` /
 * `IDENTIFYING_TYPES` id not in `includedIds`), so a relationship this
 * function prunes is exactly one `StepExporter` would otherwise have had to
 * withhold on its own.
 */
function pruneUnresolvableRelationships(
  store: { readonly source: IfcSourceBytes },
  index: EffectiveEntityIndex,
  includedIds: ReadonlySet<number>,
): { prunedRelationshipIds: number[]; finalIncludedIds: Set<number> } {
  // Deliberately the DEFAULT identifying set, not the caller's narrowed one:
  // this pass only decides which relationship members to trim, and a kept
  // georeference entity is rooted by `getSubsetEntityIds` before it gets here.
  // Threading the narrowed set in was measured dead -- mutating it failed zero
  // tests -- so it is not carried.
  const { excludedIds } = getSubsetEntityIds(index, includedIds);
  const isExcluded = (id: number): boolean => excludedIds.has(id);

  const relationshipIds = [...includedIds]
    .filter((id) => (index.typeOf(id) ?? '').startsWith('IFCREL'))
    .sort((a, b) => a - b);

  const prunedRelationshipIds: number[] = [];
  const finalIncludedIds = new Set(includedIds);

  for (const id of relationshipIds) {
    const record = readEntityArgs(store, index, id);
    // Unreadable (no source bytes, or an unparseable line): leave it for
    // `StepExporter`'s own gates to decide, rather than guessing here.
    if (!record) continue;

    const groups = record.args
      .map(refGroupFromArg)
      .filter((g): g is number | number[] => g !== undefined);
    if (!relationshipRefsSurviveExclusion(groups, isExcluded)) {
      prunedRelationshipIds.push(id);
      finalIncludedIds.delete(id);
    }
  }

  return { prunedRelationshipIds, finalIncludedIds };
}

/**
 * Export `includedIds` (plus infrastructure and their forward closure — see
 * `subset-roots.ts`) as an anonymized STEP file. Every `AnonymizeOptions`
 * field defaults to the maximally-scrubbed direction (see that interface's
 * own doc), so calling this with no options at all is the intended common
 * case, not a partial anonymization a caller must opt further into.
 *
 * Throws when `store` has no source bytes to read entity records from — a
 * server-parsed or synthetic store with `source.byteLength === 0` has
 * nothing for `readEntityArgs`/`StepExporter`'s source-iteration pass to
 * read, and every module this orchestrator calls assumes source-backed
 * records exist for at least the infrastructure/relationship entities it
 * touches.
 */
export function exportAnonymizedSubset(
  store: IfcDataStore,
  includedIds: ReadonlySet<number>,
  options: AnonymizeOptions = {},
): AnonymizeResult {
  if (!store.source || store.source.byteLength <= 0) {
    throw new Error(
      'exportAnonymizedSubset: the store has no source bytes to export from '
        + '(a server-parsed or synthetic store with source.byteLength === 0 '
        + 'cannot be anonymized — this feature reads and rewrites the original '
        + 'STEP records).',
    );
  }

  // One private overlay for this call only — never the caller's own
  // mutation view, and never written into `store`. See the module doc.
  const view = new MutablePropertyView(null, 'anonymize');
  const editor = new StoreEditor(store, view);
  const index = getEffectiveEntityIndex(store, view, true);

  // Runs BEFORE relationship pruning — see that function's own doc for why
  // the order matters (a dropped pset must be visible to the exclusion set
  // relationship pruning reads).
  const { includedIds: psetFilteredIds, droppedPropertySetIds } = excludePropertySetsUnlessKept(
    index,
    includedIds,
    options.keepPropertySets ?? false,
  );

  const { prunedRelationshipIds, finalIncludedIds } = pruneUnresolvableRelationships(
    store,
    index,
    psetFilteredIds,
  );

  const subsetIdentifyingTypes = identifyingTypesFor(options?.removeGeoreferencing !== false);
  const subset = getSubsetEntityIds(index, finalIncludedIds, subsetIdentifyingTypes);
  const exportClosure = collectReferencedEntityIds(
    subset.roots,
    store.source,
    index,
    subset.excludedIds,
  );
  const droppedPropertyReferenceIds = dropExcludedPropertyReferences(
    store,
    index,
    exportClosure,
    subset.excludedIds,
    view,
    stepSourceSchema(store.schemaVersion),
  );

  const placementResult = applyPlacementAnonymization(store, index, finalIncludedIds, editor, view, options);
  const scrubResult = applyScrub(store, index, finalIncludedIds, view, options);

  const exportResult = new StepExporter(store, view).export({
    schema: store.schemaVersion as IfcSchemaVersion,
    subsetEntityIds: finalIncludedIds,
    subsetIdentifyingTypes,
    filename: options.filename ?? 'anonymized.ifc',
    // Header scrub per the decision doc: author/organization/authorization
    // blanked outright (never inherited from the source header — an empty
    // string is a deliberate override, not "no override", per
    // `step-header.ts`'s `??` wiring). `description` gets the same
    // unconditional override: `buildStepHeader` falls through to the SOURCE
    // FILE_DESCRIPTION items verbatim whenever this orchestrator leaves
    // `description` undefined — an authoring tool's free-text
    // "Comment [...]" item there is exactly as identifying as the
    // author/organization fields beside it, so it is blanked the same way,
    // not merely left to whatever the source happened to carry.
    // `originating_system` is blanked under `scrubOwnerHistory` (a
    // vendor build string such as `26.0.0 NOR FULL` encodes the licence
    // region); `preprocessor_version` comes from `application`, left unset
    // here (defaults to 'ifc-lite').
    author: '',
    organization: '',
    authorization: '',
    description: '',
    ...((options.scrubOwnerHistory ?? true) ? { originatingSystem: '' } : {}),
    timeStamp: options.timeStamp,
    guidRandom: options.guidRandom,
  });

  const includedRootEntityCount = [...finalIncludedIds]
    .filter((id) => IFC_ROOT_TYPES.has(index.typeOf(id) ?? '')).length;

  return {
    content: exportResult.content,
    guidMap: scrubResult.guidMap,
    stats: {
      entityCount: exportResult.stats.entityCount,
      includedRootEntityCount,
      prunedRelationshipIds,
      droppedPropertySetIds,
      droppedPropertyReferenceIds,
      zeroedPlacements: placementResult.zeroedPlacements,
      warnings: [
        ...placementResult.warnings,
        ...scrubResult.warnings,
        ...exportResult.stats.warnings,
      ],
    },
  };
}

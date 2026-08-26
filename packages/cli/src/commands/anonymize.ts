/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * ifc-lite anonymize <file.ifc> --out F
 *
 * "Anonymized isolated export" (#2934): pick a seed selection (`--id`/
 * `--guid`/`--type`/`--storey`, unioned like `extract-entities`), expand it
 * by relationship context (host walls, openings/fillers, type objects,
 * materials, aggregate parents/children, the spatial containment chain up to
 * IfcProject, and optionally structurally connected neighbours), then export
 * EXACTLY that subset as a STEP file with every project-identifying signal
 * removed while the geometry-relevant local transformations (rotations in
 * the placement chain, non-orthogonal cuts) survive — so a parsing-bug
 * reproduction keeps reproducing without the source model that triggered it
 * ever leaving the caller's machine.
 *
 * Thin CLI wiring over `@ifc-lite/export`'s `collectRelatedEntities` /
 * `exportAnonymizedSubset` — the viewer's anonymized-export dialog drives the
 * same two functions directly. See `docs/guide/exporting.md`.
 */

import { writeFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { EntityNode } from '@ifc-lite/query';
import {
  collectRelatedEntities,
  exportAnonymizedSubset,
  type RelatedEntityOptions,
  type AnonymizeOptions,
} from '@ifc-lite/export';
import type { IfcDataStore } from '@ifc-lite/parser';
import { createHeadlessContext } from '../loader.js';
import { getFlag, getAllFlags, hasFlag, fatal, printJson, validateLimit } from '../output.js';

const USAGE =
  'Usage: ifc-lite anonymize <file.ifc> --out F\n' +
  '  [--id N,...] [--guid G,...] [--type T] [--storey S]\n' +
  '  [--keep-psets] [--keep-names] [--keep-other-names] [--keep-currency]\n' +
  '  [--no-hosts] [--no-openings] [--no-types] [--no-materials] [--no-aggregates]\n' +
  '  [--connect-depth N] [--guid-map F] [--json]';

/** Auto-prefix `Ifc` for `--type`, same convention as `export`/`mutate`. */
function normalizeTypeName(typeStr: string): string {
  return typeStr
    .split(',')
    .map((t) => {
      const trimmed = t.trim();
      if (/^ifc/i.test(trimmed)) return trimmed;
      const prefixed = 'Ifc' + trimmed;
      process.stderr.write(`Note: Auto-corrected type "${trimmed}" -> "${prefixed}"\n`);
      return prefixed;
    })
    .join(',');
}

/**
 * GlobalId -> expressId for the whole store, built once so N `--guid`
 * selectors cost one pass over the store rather than N. Mirrors the
 * precedence-free lookup `packages/mcp/src/tools/util.ts`'s
 * `findByGlobalId` does for a live store, minus the overlay handling this
 * freshly-loaded, unmutated CLI store never needs.
 */
function buildGlobalIdIndex(store: IfcDataStore): Map<string, number> {
  const index = new Map<string, number>();
  for (const [, ids] of store.entityIndex.byType) {
    for (const id of ids) index.set(new EntityNode(store, id).globalId, id);
  }
  return index;
}

export async function anonymizeCommand(args: string[]): Promise<void> {
  const filePath = args.find((a) => !a.startsWith('-'));
  if (!filePath) {
    fatal(USAGE);
    return;
  }
  const outPath = getFlag(args, '--out');
  if (!outPath) {
    fatal(`--out is required.\n${USAGE}`);
    return;
  }

  const { bim, store } = await createHeadlessContext(filePath);

  // ── Seed selection — every selector is unioned, and each fails loudly on
  // zero matches (never silently selects nothing), matching extract-entities'
  // `resolveToId` contract. ──
  const seeds = new Set<number>();

  for (const token of getAllFlags(args, '--id').flatMap((v) => v.split(','))) {
    const t = token.trim();
    if (!t) continue;
    const expressId = parseInt(t.startsWith('#') ? t.slice(1) : t, 10);
    if (Number.isNaN(expressId) || !bim.entity({ modelId: 'default', expressId })) {
      fatal(`--id: entity not found: ${token}`);
      return;
    }
    seeds.add(expressId);
  }

  const guidTokens = getAllFlags(args, '--guid').flatMap((v) => v.split(','));
  if (guidTokens.length > 0) {
    const guidIndex = buildGlobalIdIndex(store);
    for (const token of guidTokens) {
      const t = token.trim();
      if (!t) continue;
      const id = guidIndex.get(t);
      if (id === undefined) {
        fatal(`--guid: GlobalId not found: ${t}`);
        return;
      }
      seeds.add(id);
    }
  }

  const typeFlag = getFlag(args, '--type');
  if (typeFlag) {
    const normalized = normalizeTypeName(typeFlag);
    const matched = bim.query().byType(...normalized.split(',')).toArray();
    if (matched.length === 0) {
      fatal(`--type: no entities matched: ${normalized}`);
      return;
    }
    for (const e of matched) seeds.add(e.ref.expressId);
  }

  const storeyFlag = getFlag(args, '--storey');
  if (storeyFlag) {
    const storeys = bim.storeys();
    const matchedStorey =
      storeys.find((s) => s.globalId === storeyFlag) ??
      storeys.find((s) => String(s.ref.expressId) === storeyFlag) ??
      storeys.find((s) => s.name === storeyFlag) ??
      storeys.find((s) => s.name?.toLowerCase().includes(storeyFlag.toLowerCase()));
    if (!matchedStorey) {
      const names = storeys.map((s) => s.name).filter(Boolean).join(', ');
      fatal(`--storey: not found: ${storeyFlag} (available: ${names || '(none)'})`);
      return;
    }
    const contained = bim.contains(matchedStorey.ref);
    if (contained.length === 0) {
      fatal(`--storey: no entities contained in storey: ${storeyFlag}`);
      return;
    }
    for (const e of contained) seeds.add(e.ref.expressId);
  }

  if (seeds.size === 0) {
    fatal(`No entities selected. Use --id, --guid, --type, or --storey.\n${USAGE}`);
    return;
  }

  // ── Relationship expansion (RelatedEntityOptions) ──
  const keepPsets = hasFlag(args, '--keep-psets');
  const noAggregates = hasFlag(args, '--no-aggregates');
  const connectDepth = validateLimit(getFlag(args, '--connect-depth'), '--connect-depth') ?? 0;

  const relatedOptions: RelatedEntityOptions = {
    IfcRelVoidsElement: !hasFlag(args, '--no-hosts'),
    IfcRelFillsElement: !hasFlag(args, '--no-openings'),
    IfcRelDefinesByType: !hasFlag(args, '--no-types'),
    IfcRelAssociatesMaterial: !hasFlag(args, '--no-materials'),
    IfcRelAggregates: noAggregates ? 'none' : 'both',
    IfcRelNests: noAggregates ? 'none' : 'down',
    IfcRelConnectsPathElementsDepth: connectDepth,
    // `--keep-psets` alone only stops `exportAnonymizedSubset` from clearing
    // `HasPropertySets` on whatever ends up included — it doesn't pull
    // property sets into the selection that were never walked to. Turning
    // the walk on too is what makes `--keep-psets` actually keep anything.
    IfcRelDefinesByProperties: keepPsets,
  };

  const related = collectRelatedEntities(store, seeds, relatedOptions);

  const anonymizeOptions: AnonymizeOptions = {
    keepPropertySets: keepPsets,
    // `--keep-names`: IfcRoot Name/LongName/Description/Tag stay as authored.
    pseudonymizeNames: !hasFlag(args, '--keep-names'),
    // `--keep-other-names`: ObjectType, Phase, and non-IfcRoot names (surface
    // styles, materials, layers, profiles, colours) stay as authored.
    pseudonymizeAllNames: !hasFlag(args, '--keep-other-names'),
    // `--keep-currency`: IfcMonetaryUnit.Currency stays as authored instead of USD.
    neutralizeCurrency: !hasFlag(args, '--keep-currency'),
    filename: basename(outPath),
  };

  let result: ReturnType<typeof exportAnonymizedSubset>;
  try {
    result = exportAnonymizedSubset(store, related.all, anonymizeOptions);
  } catch (err) {
    fatal(err instanceof Error ? err.message : String(err));
    return;
  }

  await writeFile(outPath, result.content);

  const guidMapPath = getFlag(args, '--guid-map');
  if (guidMapPath) {
    await writeFile(guidMapPath, JSON.stringify(Object.fromEntries(result.guidMap), null, 2));
  }

  if (hasFlag(args, '--json')) {
    printJson({
      seedCount: seeds.size,
      includedCount: related.all.size,
      entityCount: result.stats.entityCount,
      includedRootEntityCount: result.stats.includedRootEntityCount,
      prunedRelationshipIds: result.stats.prunedRelationshipIds,
      zeroedPlacements: result.stats.zeroedPlacements,
      warnings: result.stats.warnings,
      truncated: related.truncated,
      guidMap: guidMapPath ?? null,
      out: outPath,
    });
    return;
  }

  process.stderr.write(
    `Anonymized ${seeds.size} seed(s) -> ${related.all.size} related entities -> ${result.stats.entityCount} exported entities -> ${outPath}\n`,
  );
  if (related.truncated) {
    process.stderr.write(
      'Warning: related-entity walk hit its work budget before reaching a fixpoint; the result may be an incomplete reproduction.\n',
    );
  }
  for (const w of result.stats.warnings) process.stderr.write(`Warning: ${w}\n`);
  if (guidMapPath) {
    process.stderr.write(
      `GUID map written to ${guidMapPath} — it links back to the original, identifying model; ` +
        `keep it separate from ${outPath} and do not share it alongside it.\n`,
    );
  }
}

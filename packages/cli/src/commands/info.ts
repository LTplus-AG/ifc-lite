/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * ifc-lite info <file.ifc>
 *
 * Print a summary of an IFC file: schema, entity counts, spatial structure.
 */

import { loadIfcFile } from '../loader.js';
import { printJson, formatTable, hasFlag, fatal } from '../output.js';
import { EntityNode } from '@ifc-lite/query';
import { IFC_ENTITY_NAMES } from '@ifc-lite/data';
import type { ClassCensusEntry } from '@ifc-lite/parser';

export async function infoCommand(args: string[]): Promise<void> {
  const filePath = args.find(a => !a.startsWith('-'));
  if (!filePath) fatal('Usage: ifc-lite info <file.ifc> [--format json|table]');

  const jsonOutput = hasFlag(args, '--json') || args.includes('--format') && args[args.indexOf('--format') + 1] === 'json';

  const store = await loadIfcFile(filePath);

  // Collect type counts
  const typeCounts: Record<string, number> = {};
  for (const [typeName, ids] of store.entityIndex.byType) {
    if (ids.length > 0) {
      // Convert UPPERCASE STEP type name to PascalCase for display
      const displayName = IFC_ENTITY_NAMES[typeName] ?? typeName;
      typeCounts[displayName] = (typeCounts[displayName] ?? 0) + ids.length;
    }
  }

  // Collect storeys
  const storeyIds = store.entityIndex.byType.get('IFCBUILDINGSTOREY') ?? [];
  const storeys = storeyIds.map(id => {
    const node = new EntityNode(store, id);
    return { name: node.name, expressId: id };
  });

  // Semantic drop census (#4208): report honestly whether it ran, distinct
  // from "it ran and found nothing" — an absent `dropCensus` on the store
  // must never render the same as zero drops.
  const dropCensus = store.dropCensus;
  const dropCensusSummary = dropCensus
    ? {
        ran: true as const,
        totalScanned: dropCensus.totalScanned,
        totalRetained: dropCensus.totalRetained,
        totalSkipped: dropCensus.totalSkipped,
        skippedClasses: dropCensus.skippedClasses.map((c: ClassCensusEntry) => ({ type: c.type, scanned: c.scanned, knownInSchema: c.knownInSchema })),
        // Split so a JSON consumer doesn't have to re-derive "is this a real
        // regression or universal geometry noise" itself — see
        // ClassCensusEntry.isRootDescendant in @ifc-lite/parser's drop-census.ts.
        expectedSkippedClasses: dropCensus.expectedSkippedClasses.map((c: ClassCensusEntry) => ({ type: c.type, scanned: c.scanned, knownInSchema: c.knownInSchema })),
        unexpectedSkippedClasses: dropCensus.unexpectedSkippedClasses.map((c: ClassCensusEntry) => ({ type: c.type, scanned: c.scanned, knownInSchema: c.knownInSchema })),
        unknownClasses: dropCensus.unknownClasses.map((c: ClassCensusEntry) => ({ type: c.type, scanned: c.scanned })),
        relClassesSeen: dropCensus.relClassesSeen,
        relClassesIndexed: dropCensus.relClassesIndexed,
        unindexedRelClasses: dropCensus.unindexedRelClasses.map((c: ClassCensusEntry) => ({ type: c.type, scanned: c.scanned })),
      }
    : { ran: false as const };

  const summary = {
    file: filePath,
    schema: store.schemaVersion,
    fileSize: store.fileSize,
    fileSizeHuman: formatSize(store.fileSize),
    entityCount: store.entityCount,
    parseTime: `${store.parseTime.toFixed(0)}ms`,
    storeys: storeys.map(s => s.name),
    typeCounts,
    dropCensus: dropCensusSummary,
  };

  if (jsonOutput) {
    printJson(summary);
    return;
  }

  // Table output
  process.stdout.write(`\n  File:     ${filePath}\n`);
  process.stdout.write(`  Schema:   ${store.schemaVersion}\n`);
  process.stdout.write(`  Size:     ${summary.fileSizeHuman}\n`);
  process.stdout.write(`  Entities: ${store.entityCount.toLocaleString()}\n`);
  process.stdout.write(`  Parsed:   ${summary.parseTime}\n`);

  if (storeys.length > 0) {
    process.stdout.write(`\n  Storeys:\n`);
    for (const s of storeys) {
      process.stdout.write(`    - ${s.name || '(unnamed)'}\n`);
    }
  }

  // Split entity types into building elements vs geometry/infrastructure
  const BUILDING_ELEMENT_PREFIXES = [
    'IfcWall', 'IfcSlab', 'IfcBeam', 'IfcColumn', 'IfcDoor', 'IfcWindow',
    'IfcRoof', 'IfcStair', 'IfcRailing', 'IfcMember', 'IfcPlate', 'IfcCovering',
    'IfcFooting', 'IfcPile', 'IfcCurtainWall', 'IfcRamp', 'IfcSpace',
    'IfcBuildingElementProxy', 'IfcFurnishingElement', 'IfcFlowTerminal',
    'IfcFlowSegment', 'IfcFlowFitting', 'IfcDistributionElement',
    'IfcOpeningElement', 'IfcSite', 'IfcBuilding', 'IfcBuildingStorey',
  ];
  const isBuilding = (name: string) => BUILDING_ELEMENT_PREFIXES.some(p => name.startsWith(p));
  const isInfrastructure = (name: string) =>
    !name.startsWith('IfcRel') && !name.startsWith('IfcProperty') && !name.startsWith('IfcQuantity');

  const buildingElements = Object.entries(typeCounts)
    .filter(([name]) => isBuilding(name))
    .sort((a, b) => b[1] - a[1]);

  const otherTypes = Object.entries(typeCounts)
    .filter(([name]) => isInfrastructure(name) && !isBuilding(name))
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10);

  if (buildingElements.length > 0) {
    process.stdout.write(`\n  Building elements:\n`);
    process.stdout.write(formatTable(
      ['Type', 'Count'],
      buildingElements.map(([name, count]) => [name, count.toLocaleString()]),
    ).split('\n').map(l => '    ' + l).join('\n') + '\n');
  }

  if (otherTypes.length > 0) {
    process.stdout.write(`\n  Other types (top ${otherTypes.length}):\n`);
    process.stdout.write(formatTable(
      ['Type', 'Count'],
      otherTypes.map(([name, count]) => [name, count.toLocaleString()]),
    ).split('\n').map(l => '    ' + l).join('\n') + '\n');
  }

  // Semantic drop census (#4208)
  if (!dropCensusSummary.ran) {
    process.stdout.write(`\n  Drop census: did not run (no dropCensus on this store).\n`);
  } else {
    process.stdout.write(
      `\n  Drop census: ${dropCensusSummary.totalScanned.toLocaleString()} scanned, `
      + `${dropCensusSummary.totalRetained.toLocaleString()} retained, `
      + `${dropCensusSummary.totalSkipped.toLocaleString()} skipped.\n`
    );
    if (dropCensusSummary.unexpectedSkippedClasses.length > 0) {
      // Classes with a GlobalId (IfcRoot descendants) that fell to CAT_SKIP
      // anyway — the shape of a real regression, not routine geometry noise.
      process.stdout.write(`  Skipped classes with a GlobalId (unexpected):\n`);
      process.stdout.write(formatTable(
        ['Type', 'Count', 'In schema'],
        dropCensusSummary.unexpectedSkippedClasses.map((c: { type: string; scanned: number; knownInSchema: boolean }) => [c.type, c.scanned.toLocaleString(), c.knownInSchema ? 'yes' : 'no']),
      ).split('\n').map(l => '    ' + l).join('\n') + '\n');
    }
    if (dropCensusSummary.expectedSkippedClasses.length > 0) {
      // Geometry/placement/style resource classes with no GlobalId — this
      // fires on nearly every file and is not, by itself, a problem.
      process.stdout.write(`  Skipped classes with no GlobalId (expected — geometry/placement/style resources):\n`);
      process.stdout.write(formatTable(
        ['Type', 'Count', 'In schema'],
        dropCensusSummary.expectedSkippedClasses.map((c: { type: string; scanned: number; knownInSchema: boolean }) => [c.type, c.scanned.toLocaleString(), c.knownInSchema ? 'yes' : 'no']),
      ).split('\n').map(l => '    ' + l).join('\n') + '\n');
    }
    if (dropCensusSummary.unindexedRelClasses.length > 0) {
      process.stdout.write(`  IFCREL* classes seen but not indexed as edges:\n`);
      process.stdout.write(formatTable(
        ['Type', 'Count'],
        dropCensusSummary.unindexedRelClasses.map((c: { type: string; scanned: number }) => [c.type, c.scanned.toLocaleString()]),
      ).split('\n').map(l => '    ' + l).join('\n') + '\n');
    }
    if (dropCensusSummary.unknownClasses.length > 0) {
      // Classes not recognised by the bundled schema registry at all —
      // vendor extensions or a registry gap. Loud signal; must not be
      // silently dropped from the human-readable output while it's still
      // in the JSON payload.
      process.stdout.write(`  Classes not recognised by the schema registry (unknown):\n`);
      process.stdout.write(formatTable(
        ['Type', 'Count'],
        dropCensusSummary.unknownClasses.map((c: { type: string; scanned: number }) => [c.type, c.scanned.toLocaleString()]),
      ).split('\n').map(l => '    ' + l).join('\n') + '\n');
    }
  }

  process.stdout.write('\n');
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

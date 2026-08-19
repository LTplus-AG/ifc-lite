/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * ifc-lite analyze <file.ifc> --viewer <port> [options]
 *
 * High-level analysis command that queries entities, checks properties,
 * and pushes visual results to a running 3D viewer.
 *
 * Examples:
 *   ifc-lite analyze model.ifc --viewer 3456 --type IfcWall --missing "Pset_WallCommon.FireRating" --color red
 *   ifc-lite analyze model.ifc --viewer 3456 --type IfcSlab --where "GrossArea>100" --color orange
 *   ifc-lite analyze model.ifc --viewer 3456 --type IfcWall --heatmap "Qto_WallBaseQuantities.GrossSideArea"
 *   ifc-lite analyze model.ifc --viewer 3456 --rules rules.json
 */

import { readFile } from 'node:fs/promises';
import { createStreamingContext } from '../loader.js';
import { fatal, getFlag, hasFlag, printJson, validateViewerPort, writeOutput } from '../output.js';
import type { BimContext, EntityRef, EntityData } from '@ifc-lite/sdk';

interface AnalyzeRule {
  name?: string;
  type: string;
  missing?: string;
  where?: string;
  heatmap?: string;
  palette?: string;
  color?: string;
  isolate?: boolean;
  flyto?: boolean;
}

interface MatchResult {
  rule: string;
  matched: number;
  total: number;
  entities: number[];
}

const NAMED_COLORS: Record<string, [number, number, number, number]> = {
  red: [1, 0, 0, 1],
  green: [0, 0.7, 0, 1],
  blue: [0, 0.3, 1, 1],
  yellow: [1, 0.9, 0, 1],
  orange: [1, 0.5, 0, 1],
  purple: [0.6, 0.2, 0.8, 1],
  cyan: [0, 0.8, 0.8, 1],
  white: [1, 1, 1, 1],
  pink: [1, 0.4, 0.7, 1],
  gray: [0.5, 0.5, 0.5, 1],
};

function resolveColor(c: string | undefined): [number, number, number, number] {
  if (!c) return [1, 0, 0, 1];
  if (NAMED_COLORS[c.toLowerCase()]) return NAMED_COLORS[c.toLowerCase()];
  const parts = c.split(',').map(Number);
  if (parts.length >= 3) return [parts[0], parts[1], parts[2], parts[3] ?? 1];
  return [1, 0, 0, 1];
}

function interpolateColor(
  t: number,
  palette: string,
): [number, number, number, number] {
  t = Math.max(0, Math.min(1, t));
  switch (palette) {
    case 'green-red':
      return [t, 1 - t, 0, 1];
    case 'rainbow': {
      // HSL hue 0-240 mapped to t 0-1
      const h = (1 - t) * 240;
      const s = 1, l = 0.5;
      const c = (1 - Math.abs(2 * l - 1)) * s;
      const x = c * (1 - Math.abs((h / 60) % 2 - 1));
      const m = l - c / 2;
      let r = 0, g = 0, b = 0;
      if (h < 60) { r = c; g = x; }
      else if (h < 120) { r = x; g = c; }
      else if (h < 180) { g = c; b = x; }
      else if (h < 240) { g = x; b = c; }
      return [r + m, g + m, b + m, 1];
    }
    case 'blue-red':
    default:
      return [t, 0, 1 - t, 1];
  }
}

function getPropertyValue(
  bim: BimContext,
  ref: EntityRef,
  psetName: string,
  propName: string,
): unknown {
  const psets = bim.properties(ref);
  for (const pset of psets) {
    if (pset.name === psetName) {
      for (const prop of pset.properties) {
        if (prop.name === propName) return prop.value;
      }
    }
  }
  return undefined;
}

function getQuantityValue(
  bim: BimContext,
  ref: EntityRef,
  qsetName: string | undefined,
  qName: string,
): number | undefined {
  const qsets = bim.quantities(ref);
  for (const qset of qsets) {
    if (qsetName && qset.name !== qsetName) continue;
    for (const q of qset.quantities) {
      if (q.name === qName) return typeof q.value === 'number' ? q.value : undefined;
    }
  }
  return undefined;
}

function getNumericValue(
  bim: BimContext,
  ref: EntityRef,
  path: string,
): number | undefined {
  const parts = path.split('.');
  if (parts.length === 2) {
    // Try as property first, then quantity
    const val = getPropertyValue(bim, ref, parts[0], parts[1]);
    if (typeof val === 'number') return val;
    return getQuantityValue(bim, ref, parts[0], parts[1]);
  }
  // Single name — search all quantity sets
  return getQuantityValue(bim, ref, undefined, path);
}

function evaluateWhere(
  bim: BimContext,
  ref: EntityRef,
  whereClause: string,
): boolean {
  // Parse simple conditions: "PropName>100", "Pset.Prop=true", "GrossArea<50"
  const match = whereClause.match(/^([^<>=!]+)(<=|>=|!=|=|<|>)(.+)$/);
  if (!match) return false;
  const [, path, op, rawExpected] = match;
  const value = getNumericValue(bim, ref, path.trim());
  const expected = rawExpected.trim();

  if (expected === 'true' || expected === 'false') {
    const pv = path.includes('.')
      ? getPropertyValue(bim, ref, path.split('.')[0], path.split('.')[1])
      : undefined;
    const boolVal = pv === true || pv === 'true' || pv === '.T.';
    const expectedBool = expected === 'true';
    switch (op) {
      case '=': return boolVal === expectedBool;
      case '!=': return boolVal !== expectedBool;
      default: return false;
    }
  }

  const numExpected = parseFloat(expected);
  if (value === undefined || isNaN(numExpected)) return false;
  switch (op) {
    case '>': return value > numExpected;
    case '<': return value < numExpected;
    case '>=': return value >= numExpected;
    case '<=': return value <= numExpected;
    case '=': return value === numExpected;
    case '!=': return value !== numExpected;
    default: return false;
  }
}

async function sendViewerCommand(port: number, cmd: Record<string, unknown>): Promise<void> {
  await fetch(`http://localhost:${port}/api/command`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(cmd),
  }).catch(() => {});
}

async function runRule(
  bim: BimContext,
  viewerPort: number,
  rule: AnalyzeRule,
): Promise<MatchResult> {
  // Get all entities of the specified type
  const allEntities = bim.query().byType(rule.type).toArray();
  const matched: EntityData[] = [];

  for (const entity of allEntities) {
    let passes = true;

    if (rule.missing) {
      const parts = rule.missing.split('.');
      if (parts.length === 2) {
        const val = getPropertyValue(bim, entity.ref, parts[0], parts[1]);
        passes = val === undefined || val === null || val === '';
      }
    }

    if (rule.where) {
      passes = evaluateWhere(bim, entity.ref, rule.where);
    }

    if (passes) matched.push(entity);
  }

  const matchedIds = matched.map(e => e.ref.expressId);

  // Push visualization — isolate BEFORE colorize so colors aren't wiped
  if (rule.isolate && matchedIds.length > 0) {
    await sendViewerCommand(viewerPort, {
      action: 'isolateEntities',
      ids: matchedIds,
    });
  }

  if (rule.heatmap) {
    const palette = rule.palette ?? 'blue-red';
    const values = matched.map(e => ({
      id: e.ref.expressId,
      value: getNumericValue(bim, e.ref, rule.heatmap!) ?? 0,
    }));
    const numericValues = values.map(v => v.value);
    const min = Math.min(...numericValues);
    const max = Math.max(...numericValues);
    const range = max - min || 1;

    // Batch by color bucket (~20 steps) to minimize HTTP roundtrips
    const BUCKET_COUNT = 20;
    const buckets = new Map<number, number[]>();
    for (const v of values) {
      const t = (v.value - min) / range;
      const bucket = Math.min(BUCKET_COUNT - 1, Math.floor(t * BUCKET_COUNT));
      if (!buckets.has(bucket)) buckets.set(bucket, []);
      buckets.get(bucket)!.push(v.id);
    }
    for (const [bucket, ids] of buckets) {
      const t = (bucket + 0.5) / BUCKET_COUNT;
      const color = interpolateColor(t, palette);
      await sendViewerCommand(viewerPort, {
        action: 'colorizeEntities',
        ids,
        color,
      });
    }
  } else if (matchedIds.length > 0) {
    const color = resolveColor(rule.color);
    await sendViewerCommand(viewerPort, {
      action: 'colorizeEntities',
      ids: matchedIds,
      color,
    });
  }

  if (rule.flyto && matchedIds.length > 0) {
    await sendViewerCommand(viewerPort, {
      action: 'flyto',
      ids: matchedIds,
    });
  }

  return {
    rule: rule.name ?? `${rule.type} ${rule.missing ? 'missing ' + rule.missing : rule.where ?? rule.heatmap ?? ''}`.trim(),
    matched: matched.length,
    total: allEntities.length,
    entities: matchedIds,
  };
}

export async function analyzeCommand(args: string[]): Promise<void> {
  const viewerPortStr = getFlag(args, '--viewer');
  if (!viewerPortStr) {
    fatal('Usage: ifc-lite analyze <file.ifc> --viewer <port> [--out file] [options]\n\n--viewer is required to push results to the 3D viewer.');
  }
  const viewerPort = validateViewerPort(viewerPortStr)!;

  const rulesFile = getFlag(args, '--rules');
  const jsonOutput = hasFlag(args, '--json');
  const outPath = getFlag(args, '--out');

  // Find the IFC file
  const positional = args.filter(
    a => !a.startsWith('-') &&
    !['--viewer', '--rules', '--type', '--missing', '--where', '--color',
      '--heatmap', '--palette', '--out'].includes(args[args.indexOf(a) - 1] ?? ''),
  );
  if (positional.length === 0) {
    fatal('Usage: ifc-lite analyze <file.ifc> --viewer <port> [options]');
  }
  const filePath = positional[0];

  // Load model with streaming viewer support
  process.stderr.write(`Loading ${filePath}...\n`);
  const { bim } = await createStreamingContext(filePath, viewerPort);

  let rules: AnalyzeRule[];

  if (rulesFile) {
    const content = await readFile(rulesFile, 'utf-8');
    rules = JSON.parse(content);
  } else {
    // Build a single rule from CLI flags
    const type = getFlag(args, '--type');
    if (!type) {
      fatal('Either --type or --rules is required.');
    }
    rules = [{
      name: getFlag(args, '--name') ?? undefined,
      type,
      missing: getFlag(args, '--missing') ?? undefined,
      where: getFlag(args, '--where') ?? undefined,
      heatmap: getFlag(args, '--heatmap') ?? undefined,
      palette: getFlag(args, '--palette') ?? undefined,
      color: getFlag(args, '--color') ?? undefined,
      isolate: hasFlag(args, '--isolate'),
      flyto: hasFlag(args, '--flyto'),
    }];
  }

  const results: MatchResult[] = [];
  for (const rule of rules) {
    const result = await runRule(bim, viewerPort, rule);
    results.push(result);

    if (!jsonOutput) {
      process.stderr.write(
        `  ${result.rule}: ${result.matched}/${result.total} matched\n`,
      );
    }
  }

  if (outPath) {
    // --out was previously excluded from positional-arg detection (so its
    // value was never mistaken for the input file) but never actually
    // written — a silent no-op. Route the results there, mirroring the
    // writeOutput convention used by every other file-producing command.
    await writeOutput(JSON.stringify(results, null, 2) + '\n', outPath);
  } else if (jsonOutput) {
    printJson(results);
  } else {
    // Summary line
    const totalMatched = results.reduce((s, r) => s + r.matched, 0);
    process.stderr.write(`\n${totalMatched} entities matched across ${results.length} rule(s)\n`);
  }
}

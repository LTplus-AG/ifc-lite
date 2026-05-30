/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * ifc-lite clash <file.ifc> [options]
 *
 * Detect geometric clashes between elements in an IFC model. Meshes the model
 * headlessly, maps it to representation-agnostic clash elements, then runs the
 * clash engine with either a single ad-hoc rule (--a/--b) or the standard
 * discipline matrix (--matrix). Results print as a concise human summary or
 * machine-readable JSON, and can be exported as a BCF archive (--bcf).
 */

import { readFile, writeFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { createHeadlessContext } from '../loader.js';
import { getFlag, hasFlag, fatal, printJson } from '../output.js';
import { GeometryProcessor, type MeshData } from '@ifc-lite/geometry';
import type { IfcDataStore } from '@ifc-lite/parser';
import {
  createClashEngine,
  disciplineMatrixRules,
  groupClashes,
  type Clash,
  type ClashMode,
  type ClashResult,
  type ClashRule,
} from '@ifc-lite/clash';
import { elementsFromStep } from '@ifc-lite/clash/step';
import { createBCFFromClashResult } from '@ifc-lite/clash/bcf';
import { writeBCF } from '@ifc-lite/bcf';

/** Maximum number of clashes embedded in --json output before truncation. */
const JSON_CLASH_CAP = 1000;
/** Maximum number of clash rows shown in the human summary. */
const HUMAN_CLASH_CAP = 20;

/**
 * Mesh a model once and cache the meshes by model id so repeated clash runs
 * within a single process never re-mesh the same file.
 */
const meshCache = new Map<string, MeshData[]>();

let sharedProcessor: GeometryProcessor | undefined;

async function getProcessor(): Promise<GeometryProcessor> {
  if (!sharedProcessor) {
    const processor = new GeometryProcessor();
    await processor.init();
    sharedProcessor = processor;
  }
  return sharedProcessor;
}

/**
 * Mesh the whole model. Prefers the parsed `store.source` bytes; falls back to
 * reading the file path from disk when the store did not retain its source.
 */
async function meshModel(store: IfcDataStore, modelId: string, filePath: string): Promise<MeshData[]> {
  const cached = meshCache.get(modelId);
  if (cached) return cached;

  let bytes: Uint8Array | undefined = store.source;
  if (!bytes || bytes.byteLength === 0) {
    const buffer = await readFile(filePath);
    bytes = new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  }

  const processor = await getProcessor();
  const result = await processor.process(bytes);
  meshCache.set(modelId, result.meshes);
  return result.meshes;
}

function parseMode(raw: string | undefined): ClashMode {
  const mode = raw ?? 'hard';
  if (mode !== 'hard' && mode !== 'clearance') {
    fatal(`Invalid --mode "${mode}". Supported modes: hard, clearance`);
  }
  return mode;
}

function parseNumberFlag(raw: string | undefined, flag: string): number | undefined {
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    fatal(`Invalid ${flag} value "${raw}" (must be a number)`);
  }
  return value;
}

type ClashGroupByCli = 'cluster' | 'rule' | 'typePair' | 'element';

function parseGroupBy(raw: string | undefined): ClashGroupByCli {
  const g = raw ?? 'cluster';
  if (g !== 'cluster' && g !== 'rule' && g !== 'typePair' && g !== 'element') {
    fatal(`Invalid --group "${g}". Supported: cluster, rule, typePair, element`);
  }
  return g as ClashGroupByCli;
}

function buildRules(args: string[], mode: ClashMode, tolerance: number | undefined, clearance: number | undefined): ClashRule[] {
  if (hasFlag(args, '--matrix')) {
    return disciplineMatrixRules(mode, clearance);
  }

  const a = getFlag(args, '--a') ?? '*';
  const b = getFlag(args, '--b');
  const rule: ClashRule = {
    id: 'cli-rule',
    name: b ? `${a} vs ${b}` : `${a} self-clash`,
    a,
    mode,
  };
  if (b !== undefined) rule.b = b;
  if (tolerance !== undefined) rule.tolerance = tolerance;
  if (clearance !== undefined) rule.clearance = clearance;
  return [rule];
}

function formatClashRow(clash: Clash): string {
  const aName = clash.a.name ? `${clash.a.tag} "${clash.a.name}"` : clash.a.tag;
  const bName = clash.b.name ? `${clash.b.tag} "${clash.b.name}"` : clash.b.tag;
  const distance = clash.distance < 0
    ? `penetration ${Math.abs(clash.distance).toFixed(3)}m`
    : `gap ${clash.distance.toFixed(3)}m`;
  return `  [${clash.severity}] ${aName} x ${bName} (${clash.status}, ${distance})`;
}

function printHumanSummary(result: ClashResult): void {
  const { summary } = result;
  process.stdout.write(`\n  Clash Detection Results\n`);
  process.stdout.write(`  -----------------------\n`);
  process.stdout.write(`  Total clashes: ${summary.total}\n`);
  process.stdout.write(`  By severity:   critical ${summary.bySeverity.critical}, major ${summary.bySeverity.major}, minor ${summary.bySeverity.minor}, info ${summary.bySeverity.info}\n`);

  if (result.truncated) {
    process.stdout.write(`  Truncated:     ${result.truncated.reason} (${result.truncated.droppedPairs} pairs dropped)\n`);
  }

  if (summary.total > 0) {
    const shown = result.clashes.slice(0, HUMAN_CLASH_CAP);
    process.stdout.write(`\n  Top ${shown.length} of ${summary.total} clashes:\n`);
    for (const clash of shown) {
      process.stdout.write(`${formatClashRow(clash)}\n`);
    }
    const dropped = summary.total - shown.length;
    if (dropped > 0) {
      process.stdout.write(`\n  ... ${dropped} more clash(es) not shown (use --json for the full list).\n`);
    }
  }
  process.stdout.write('\n');
}

export async function clashCommand(args: string[]): Promise<void> {
  const filePath = args.find(a => !a.startsWith('-'));
  if (!filePath) {
    fatal('Usage: ifc-lite clash <file.ifc> [--a <selector>] [--b <selector>] [--mode hard|clearance] [--tolerance N] [--clearance N] [--matrix] [--bcf <out.bcfzip>] [--group cluster|rule|typePair|element] [--bcf-status <status>] [--max-topics N] [--json]');
  }

  const jsonOutput = hasFlag(args, '--json');
  const mode = parseMode(getFlag(args, '--mode'));
  const tolerance = parseNumberFlag(getFlag(args, '--tolerance'), '--tolerance');
  const clearance = parseNumberFlag(getFlag(args, '--clearance'), '--clearance');
  const bcfPath = getFlag(args, '--bcf');
  const bcfGroupBy = parseGroupBy(getFlag(args, '--group'));
  const bcfStatus = getFlag(args, '--bcf-status');
  const maxTopics = parseNumberFlag(getFlag(args, '--max-topics'), '--max-topics');

  const { store } = await createHeadlessContext(filePath);

  const modelId = basename(filePath);
  if (!jsonOutput) process.stderr.write(`  Meshing ${modelId} ...\n`);
  const meshes = await meshModel(store, modelId, filePath);

  const { elements, exclusions } = elementsFromStep({ store, meshes, modelId });

  const rules = buildRules(args, mode, tolerance, clearance);

  const engine = createClashEngine({ backend: 'ts' });
  const result = await engine.run(elements, rules, {
    exclusions,
    tolerance,
    onProgress: (p) => {
      if (!jsonOutput) {
        process.stderr.write(`\r  Clashing: ${p.phase} ${p.rule} (${p.done}/${p.total})`);
      }
    },
  });
  if (!jsonOutput) process.stderr.write('\n');

  if (bcfPath) {
    const groups = groupClashes(result, { by: bcfGroupBy });
    const project = await createBCFFromClashResult(result, groups, {
      author: 'ifc-lite clash',
      projectName: 'Clash report',
      // Headless: no snapshots (no renderer) — viewer export embeds those.
      ...(bcfStatus ? { status: bcfStatus } : {}),
      ...(maxTopics != null ? { maxTopics } : {}),
    });
    const blob = await writeBCF(project);
    const buffer = Buffer.from(await blob.arrayBuffer());
    await writeFile(bcfPath, buffer);
    process.stderr.write(`  BCF report written to ${bcfPath} (${groups.length} topic group(s), grouped by ${bcfGroupBy})\n`);
  }

  if (jsonOutput) {
    const total = result.clashes.length;
    const clashes = result.clashes.slice(0, JSON_CLASH_CAP);
    const truncated = total > clashes.length
      ? { reason: `capped at ${JSON_CLASH_CAP} clashes for display`, dropped: total - clashes.length }
      : null;
    printJson({ summary: result.summary, truncated, clashes });
    return;
  }

  printHumanSummary(result);
}

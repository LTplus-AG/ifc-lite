/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * ifc-lite bsdd <subcommand> [options]
 *
 * Query the buildingSMART Data Dictionary (bSDD) for IFC class info,
 * property sets, and search for related classifications.
 *
 * Subcommands:
 *   class    <IfcType>    Get class info and properties
 *   search   <query>      Search bSDD for classes
 *   psets    <IfcType>    List standard property sets
 *   qsets    <IfcType>    List standard quantity sets
 */

import { hasFlag, fatal, printJson, formatTable } from '../output.js';
import type { BsddClassInfo, BsddClassProperty, BsddSearchResult } from '@ifc-lite/sdk';

export async function bsddCommand(args: string[]): Promise<void> {
  const subcommand = args.find(a => !a.startsWith('-'));
  if (!subcommand) fatal('Usage: ifc-lite bsdd <class|search|psets|qsets> <type-or-query>');

  const jsonOutput = hasFlag(args, '--json');
  const positional = args.filter(a => !a.startsWith('-'));

  // Lazy-load BsddNamespace to avoid importing SDK at startup
  const { BsddNamespace } = await import('@ifc-lite/sdk');
  const bsdd = new BsddNamespace();

  switch (subcommand) {
    case 'class': {
      const ifcType = positional[1];
      if (!ifcType) fatal('Usage: ifc-lite bsdd class <IfcType>');
      const info = await bsdd.fetchClassInfo(ifcType);
      if (!info) fatal(`No bSDD info found for ${ifcType}`);
      if (jsonOutput) printJson(info);
      else printClassInfo(info);
      break;
    }
    case 'search': {
      const query = positional[1];
      if (!query) fatal('Usage: ifc-lite bsdd search <query>');
      const results = await bsdd.search(query);
      if (jsonOutput) printJson(results);
      else printSearchResults(results);
      break;
    }
    case 'psets': {
      const ifcType = positional[1];
      if (!ifcType) fatal('Usage: ifc-lite bsdd psets <IfcType>');
      const psets = await bsdd.getPropertySets(ifcType);
      if (jsonOutput) printJson(Object.fromEntries(psets));
      else printPropertySets(psets, 'property');
      break;
    }
    case 'qsets': {
      const ifcType = positional[1];
      if (!ifcType) fatal('Usage: ifc-lite bsdd qsets <IfcType>');
      const qsets = await bsdd.getQuantitySets(ifcType);
      if (jsonOutput) printJson(Object.fromEntries(qsets));
      else printPropertySets(qsets, 'quantity');
      break;
    }
    default:
      fatal(`Unknown bsdd subcommand: ${subcommand}. Use: class, search, psets, qsets`);
  }
}

// ---------------------------------------------------------------------------
// Human-readable output (default, no --json)
// ---------------------------------------------------------------------------

function printClassInfo(info: BsddClassInfo): void {
  process.stdout.write(`${info.code}  ${info.name}\n`);
  process.stdout.write(`${info.uri}\n`);
  if (info.definition) process.stdout.write(`\n${info.definition}\n`);
  if (info.classProperties.length > 0) {
    process.stdout.write('\n');
    process.stdout.write(`${formatTable(
      ['Property', 'Set', 'Type', 'Description'],
      info.classProperties.map((p) => [p.name, p.propertySet ?? '(attribute)', p.dataType ?? '', p.description ?? '']),
    )}\n`);
  }
}

function printSearchResults(results: readonly BsddSearchResult[]): void {
  if (results.length === 0) {
    process.stderr.write('No results.\n');
    return;
  }
  process.stdout.write(`${formatTable(
    ['Code', 'Name', 'Dictionary'],
    results.map((r) => [r.code, r.name, r.dictionaryUri]),
  )}\n`);
}

function printPropertySets(sets: ReadonlyMap<string, BsddClassProperty[]>, label: 'property' | 'quantity'): void {
  if (sets.size === 0) {
    process.stderr.write(`No ${label} sets found.\n`);
    return;
  }
  const rows: string[][] = [];
  for (const [setName, props] of sets) {
    for (const p of props) rows.push([setName, p.name, p.dataType ?? '', p.description ?? '']);
  }
  process.stdout.write(`${formatTable(['Set', 'Name', 'Type', 'Description'], rows)}\n`);
}

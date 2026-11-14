/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Read the parser's structural analysis model without changing the file. */
import { extractStructuralOnDemand, structuralCounterparts } from '@ifc-lite/parser';
import { loadIfcFile } from '../loader.js';
import { printJson, formatTable, hasFlag, fatal } from '../output.js';

export async function structuralCommand(args: string[]): Promise<void> {
  const filePath = args.find(a => !a.startsWith('-'));
  if (!filePath) fatal('Usage: ifc-lite structural <file.ifc> [--json]');
  const jsonOutput = hasFlag(args, '--json');
  const store = await loadIfcFile(filePath);
  const data = extractStructuralOnDemand(store);
  const { activities, ...collections } = data;
  const result = {
    ...collections,
    loads: activities.filter(a => a.kind === 'Action'),
    reactions: activities.filter(a => a.kind === 'Reaction'),
    links: [...data.members, ...data.connections].flatMap(item => {
      const counterparts = structuralCounterparts(data, item.expressId);
      return counterparts?.side === 'physical' ? counterparts.expressIds.map(physicalElementId => ({
        structuralItemId: item.expressId, physicalElementId,
      })) : [];
    }),
  };
  if (jsonOutput) {
    printJson(result);
    return;
  }
  process.stdout.write(formatTable(['Collection', 'Count'], [
    ['Analysis models', String(result.analysisModels.length)],
    ['Members', String(result.members.length)],
    ['Connections', String(result.connections.length)],
    ['Loads (actions)', String(result.loads.length)],
    ['Load groups / cases', String(result.loadGroups.length)],
    ['Reactions', String(result.reactions.length)],
    ['Result groups', String(result.resultGroups.length)],
    ['Physical links', String(result.links.length)],
  ]) + '\n');
  if (result.loadsTruncated) process.stderr.write('Warning: applied load extraction was truncated; inspect --json for details.\n');
}

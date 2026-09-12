/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `ifc-lite clash --csv <out.csv>`: the run as a flat table, one row per clash
 * with both elements' GlobalIds, for spreadsheets and BI tools (#3944).
 *
 * Every clash, uncapped: the `--json` cap is a DISPLAY limit, while a table is
 * what a reader loads into Excel or Power BI, where a hidden remainder is a
 * wrong total. The headless run has no federation, so an element's `ref` IS
 * its express id and the storey comes straight off the one meshed model's
 * spatial hierarchy.
 */
import { writeFile } from 'node:fs/promises';
import { CLASH_TABLE_COLUMNS, clashTableRows, type ClashElementRef, type ClashResult } from '@ifc-lite/clash';
import { tableToCsv } from '@ifc-lite/export';
import type { IfcDataStore } from '@ifc-lite/parser';

export async function writeClashCsv(
  csvPath: string,
  result: Pick<ClashResult, 'clashes'>,
  store: IfcDataStore,
  modelId: string,
): Promise<number> {
  const storeyOf = (ref: ClashElementRef): string | undefined => {
    const storeyId = store.spatialHierarchy?.elementToStorey.get(ref.ref);
    return storeyId ? store.entities.getName(storeyId) || undefined : undefined;
  };
  const rows = clashTableRows(result.clashes, { storeyOf, modelNameOf: () => modelId });
  await writeFile(csvPath, tableToCsv(CLASH_TABLE_COLUMNS, rows), 'utf8');
  return rows.length;
}

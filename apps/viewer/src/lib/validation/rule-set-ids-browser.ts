/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Browser half of the rule set <-> IDS interchange (#5225): the conversion
 * itself is `@ifc-lite/rules`' `ruleSetToIds` / `idsToRuleSet`; this file
 * only saves the `.ids` through the one download path and reads a picked
 * IDS file. Mirrors `rule-set-io-browser.ts`.
 */

import { trackExportCompleted } from '@/lib/analytics';
import type { IFCVersion } from '@ifc-lite/ids';
import { IDSParseError, parseIDS } from '@ifc-lite/ids';
import {
  idsToRuleSet,
  ruleSetToIds,
  type IdsToRuleSetResult,
  type RuleSetFile,
  type RuleSetToIdsResult,
  type EvaluatorModel,
} from '@ifc-lite/rules';
import { downloadFile, sanitizeFilename } from '../export/download.js';

/** The IDS `ifcVersion` value for each loadable model schema. IFC5 has none. */
const IDS_VERSION_OF: Readonly<Record<string, IFCVersion | undefined>> = {
  IFC2X3: 'IFC2X3',
  IFC4: 'IFC4',
  IFC4X3: 'IFC4X3_ADD2',
};

/** The IDS versions the loaded models use; the exporter's default when none maps. */
export function idsVersionsForSchemas(schemas: Iterable<string>): IFCVersion[] {
  const out = new Set<IFCVersion>();
  for (const schema of schemas) {
    const version = IDS_VERSION_OF[schema];
    if (version) out.add(version);
  }
  return [...out];
}

/**
 * Convert `file` and, when at least one rule exported, save it as
 * `<name>.ids`. Returns the conversion result either way, so the caller can
 * show what was refused and why.
 */
export function exportRuleSetAsIds(
  file: RuleSetFile,
  ifcVersions: IFCVersion[],
  models: ReadonlyArray<EvaluatorModel>,
): RuleSetToIdsResult {
  // The models resolve the unit each model-unit numeric check is stored in,
  // so it can be written to the IDS in SI (#5225).
  const result = ruleSetToIds(file, { ifcVersions, models });
  if (result.xml !== null) {
    const name = sanitizeFilename(file.name, { fallback: 'ruleset' });
    downloadFile(result.xml, `${name}.ids`, 'application/xml');
    trackExportCompleted({ format: 'ids', surface: 'ids_panel' });
  }
  return result;
}

export type IdsImportOutcome =
  | { ok: true; result: IdsToRuleSetResult }
  | { ok: false; error: string };

/** Read + parse a picked `.ids` file and convert its simple specifications. Never rejects. */
export async function importIdsFileAsRuleSet(file: File): Promise<IdsImportOutcome> {
  let text: string;
  try {
    text = await file.text();
  } catch (err) {
    return { ok: false, error: `Failed to read "${file.name}": ${(err as Error).message}` };
  }
  try {
    return { ok: true, result: idsToRuleSet(parseIDS(text)) };
  } catch (err) {
    const detail = err instanceof IDSParseError ? (err.details ?? err.message) : (err as Error).message;
    return { ok: false, error: `"${file.name}" is not a readable IDS file: ${detail}` };
  }
}

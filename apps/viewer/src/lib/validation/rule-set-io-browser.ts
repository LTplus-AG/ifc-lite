/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Browser-only half of `rule-set-io` (#5138 PR 7a): `exportRuleSet` /
 * `importRuleSetFile` need DOM (`downloadFile`, `FileReader`), which a
 * published Node-compatible package must not depend on — everything else
 * (`parseRuleSetFile`, `serializeRuleSet`, the `RuleSetFile` shape) moved to
 * `@ifc-lite/rules`'s `rule-set-io.ts`; this file is what's left in the
 * viewer, calling back into the package for the actual parse/serialize.
 */

import { trackExportCompleted } from '@/lib/analytics';
import type { RuleSetFile, RuleSetParseResult } from '@ifc-lite/rules';
import { parseRuleSetFile, serializeRuleSet } from '@ifc-lite/rules';
import { downloadFile, sanitizeFilename } from '../export/download.js';

/** Download `file` as `<name>.rules.json` — mirrors `lib/lists/persistence.ts`'s
 *  `exportListDefinition`. */
export function exportRuleSet(file: RuleSetFile): void {
  const name = sanitizeFilename(file.name, { fallback: 'ruleset' });
  downloadFile(serializeRuleSet(file), `${name}.rules.json`, 'application/json');
  trackExportCompleted({ format: 'json', surface: 'ids_panel' });
}

/** Read + parse a `.rules.json` `File` (the browser file-picker result).
 *  Never rejects: an unreadable file or malformed JSON comes back as
 *  `{ ok: false, error }`, same as `parseRuleSetFile`. */
export function importRuleSetFile(file: File): Promise<RuleSetParseResult> {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const parsed: unknown = JSON.parse(reader.result as string);
        resolve(parseRuleSetFile(parsed));
      } catch (err) {
        resolve({ ok: false, error: `"${file.name}" is not valid JSON: ${(err as Error).message}` });
      }
    };
    reader.onerror = () => resolve({ ok: false, error: `Failed to read "${file.name}"` });
    reader.readAsText(file);
  });
}

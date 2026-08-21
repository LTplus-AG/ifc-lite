/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The header/assembly tail of `StepExporter.export()` (#2475, the last seam
 * this issue names): building the FILE_DESCRIPTION/HEADER text and turning
 * the finished `ExportPass.entities` into the returned `StepExportResult`.
 *
 * Both functions here are pure — neither reads `this.dataStore`,
 * `this.mutationView`, nor any of `ExportPass`'s three adversarial-review
 * predicates (`isOmittedFromOutput`, `mayNameOmittedRefs`,
 * `hasAnyUnreadableSourceRef`). Those stay in `step-exporter.ts`: their last
 * reader is `writeOverlayCreatedEntities`, several statements before this
 * tail begins, and nothing here reads them back. That is the same test
 * `step-collection.ts` applied when it left them in place (#2475 collection
 * step) — moving them here would relocate a dependency, not remove one.
 *
 * `buildStepHeader` is `pass.buildHeader`'s body, unchanged: `export()`
 * still builds the closure (it needs to close over the per-call `options`
 * and the two call sites still read `pass.buildHeader`), but the closure
 * now just forwards here instead of carrying the logic itself.
 *
 * `assembleExportResult` is the true final phase from the original
 * decomposition table (settle the ledger, build the header, assemble): it is
 * NOT used by the earlier `deltaOnly`-empty-export early return, which
 * hand-builds its own (shorter) `StepExportResult` because it skips
 * `assembleStepBytes` entirely — see the comment at that call site in
 * `step-exporter.ts`.
 */

import type { IfcSourceHeader } from '@ifc-lite/parser';
import { generateHeader } from '@ifc-lite/parser';
import { assembleStepBytes } from './step-file-assembly.js';
import type { ExportPass, StepExportOptions, StepExportResult } from './step-exporter.js';

/**
 * Build the STEP HEADER section text. `modifications` is read last, at each
 * call site, once the real count is known — see the two callers in
 * `step-exporter.ts` (the `deltaOnly`-empty early return, and
 * {@link assembleExportResult} below) — so the provenance item it appends
 * reflects what this export actually wrote, not a guess made at setup time.
 */
export function buildStepHeader(
  options: StepExportOptions,
  sourceHeader: IfcSourceHeader | undefined,
  schemaToken: string,
  modifications: number,
): string {
  // FILE_DESCRIPTION items: an explicit option wins, else the source items
  // verbatim, else the generic default.
  const description: string[] =
    options.description !== undefined
      ? [options.description]
      : sourceHeader && sourceHeader.description.length > 0
        ? [...sourceHeader.description]
        : ['Exported from ifc-lite'];
  // Honest provenance: never claim untouched source output. Append (never
  // overwrite) one item when ifc-lite actually changed the file.
  if (modifications > 0) {
    description.push(
      `Re-exported by ifc-lite, ${modifications} modification${modifications === 1 ? '' : 's'}`,
    );
  }
  return generateHeader({
    schema: schemaToken,
    description,
    implementationLevel: sourceHeader?.implementationLevel,
    author: options.author ?? sourceHeader?.author,
    organization: options.organization ?? sourceHeader?.organization,
    // preprocessor_version = the tool that WROTE this file (ifc-lite);
    // originating_system keeps the source authoring tool so it isn't erased.
    preprocessorVersion: options.application ?? 'ifc-lite',
    originatingSystem: sourceHeader?.originatingSystem,
    authorization: sourceHeader?.authorization,
    application: options.application ?? 'ifc-lite',
    filename: options.filename ?? 'export.ifc',
    timeStamp: options.timeStamp,
  });
}

/**
 * Settle the delta ledger, build the header against the settled count, and
 * assemble the finished bytes. The header is built last so its provenance
 * item reflects the real count — see {@link buildStepHeader}.
 */
export function assembleExportResult(pass: ExportPass): StepExportResult {
  // Settle the count against what the passes above actually wrote, and say
  // out loud every KIND of edit a delta could not carry, per host. Silence
  // was the other half of #2462: `deltaOnly` skips the source-iteration pass,
  // so an in-place edit to a source entity is not in the file and never was —
  // the header merely used to claim otherwise.
  const { modifiedEntityCount, warnings: deltaWarnings } = pass.modifications.settle();
  pass.warnings.push(...deltaWarnings);

  // Assemble final file as Uint8Array chunks to avoid V8 string length limit.
  // The header is built last so its provenance item reflects the real count.
  const header = pass.buildHeader(pass.newEntityCount + modifiedEntityCount);
  const content = assembleStepBytes(header, pass.entities);

  return {
    content,
    stats: {
      entityCount: pass.entities.length,
      newEntityCount: pass.newEntityCount,
      modifiedEntityCount,
      fileSize: content.byteLength,
      warnings: pass.warnings,
    },
  };
}

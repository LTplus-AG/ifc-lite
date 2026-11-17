/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { useSemanticSession } from './session';
import { validateInWorker } from './validation-worker';
import type { ValidationJob, ValidationOutput } from './validation-job';
/** Panel and automation share the exact stale-input and commit boundary. */
export async function validateCurrentSemantic(suppliedGraph: boolean, signal: AbortSignal,
  execute: (job: ValidationJob, signal: AbortSignal) => Promise<ValidationOutput> = validateInWorker,
  commit: (write: () => void) => void = write => write()): Promise<ValidationOutput> {
  const input = useSemanticSession.getState();
  const value = await execute(suppliedGraph ? { graph: input.graph, graphFormat: input.graphFormat, profile: input.profile } : { document: input.document, profile: input.profile }, signal);
  if (signal.aborted) throw new DOMException('Semantic validation cancelled', 'AbortError');
  const latest = useSemanticSession.getState();
  if (latest.dataVersion !== input.dataVersion || latest.profile !== input.profile || latest.graph !== input.graph || latest.graphFormat !== input.graphFormat || latest.document !== input.document) throw new Error('Semantic inputs changed during validation; result discarded.');
  commit(() => { latest.setFindings(value.findings); latest.setReport(value.diagnostic ? undefined : value.report); });
  return value;
}

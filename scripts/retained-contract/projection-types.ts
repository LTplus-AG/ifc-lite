// SPDX-License-Identifier: MPL-2.0
// #7955: root typecheck tail checks these invariants without emitting declarations.
import type { InspectionReport, ModelReport, Options } from './generated/contract.js';
import { parseOptions, parseModelReport } from './generated/contract.js';

function readonlyOptions(options: Options) {
  // @ts-expect-error A caller cannot change a validated option snapshot.
  options.maxWork = '1';
}
function separatedReports(inspection: InspectionReport, model: ModelReport) {
  // @ts-expect-error Source inspection is not a model result.
  const forged: ModelReport = inspection;
  // @ts-expect-error A model result is not source inspection.
  const diagnostic: InspectionReport = model;
  if (model.status === 'failed' || model.status === 'cancelled') {
    if (model.error.source.kind === 'known') {
      const sourceRevision: string = model.error.source.value.revision;
      void sourceRevision;
    }
  } else {
    // @ts-expect-error Complete/incomplete has no top-level failure envelope.
    model.error;
  }
  // @ts-expect-error Wide counters cannot cross as a JS number.
  const unsafe: Options = { ...inspection.identity.options, maxBytes: 9007199254740992 };
  // @ts-expect-error Model decoding requires a separately supplied binding.
  parseModelReport(model);
  const validated: Options = parseOptions(inspection.identity.options);
  void [forged, diagnostic, unsafe, validated];
}
void [readonlyOptions, separatedReports];

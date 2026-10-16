/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { runAppearanceContracts } from './wasm-appearance-contracts.mjs';
import { runLandXmlContracts } from './wasm-landxml-contracts.mjs';
import { runLandXmlCrsContracts } from './wasm-landxml-crs-contracts.mjs';
import { runStepLogContracts } from './wasm-step-log-contracts.mjs';
import { runSweptDiskContracts } from './wasm-swept-disk-contracts.mjs';
import { runOpeningMissRepairContracts } from './wasm-opening-miss-repair-contract.mjs';
import { runMapNormalizationContracts } from './wasm-map-normalization-contracts.mjs';
import { runProgressHeartbeatContracts } from './wasm-progress-heartbeat-contract.mjs';
import { runReachablePanicContracts } from './wasm-reachable-panics-contract.mjs';
import { runEmptyExportContracts } from './wasm-empty-export-contracts.mjs';

/** These suites have their own inputs and run even when the column fixture is absent. */
export function runEarlyContracts({ IfcAPI, api, test, skip, root }) {
  runAppearanceContracts(IfcAPI, test);
  runLandXmlContracts(api, test);
  runLandXmlCrsContracts(api, test);
  runStepLogContracts(api, test);
  runMapNormalizationContracts(api, test);
  runSweptDiskContracts(api, test, root);
  runOpeningMissRepairContracts(IfcAPI, test, skip, root);
  runProgressHeartbeatContracts(IfcAPI, test, skip, root);
  runReachablePanicContracts(IfcAPI, test, skip, root);
  runEmptyExportContracts(api, test, root); // #7695
}

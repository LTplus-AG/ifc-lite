/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
/** Register actual-WASM appearance and annotation acceptance contracts. */
import { checkPdfVectorContract } from './wasm-pdf-vector-contract.mjs';
import { checkAnnotationFillContract } from './wasm-annotation-fill-contract.mjs';
import { checkMeshTransferContract } from './wasm-mesh-transfer-contract.mjs';
import { checkScanRegistrationContract } from './wasm-scan-registration-contract.mjs';

export function runAppearanceContracts(IfcAPI, test) {
  test('PDF vector state preserves calibrated stroke transforms and explicit blockers (#4406)', () => checkPdfVectorContract(IfcAPI));
  test('annotation fills preserve holes, units and solid colour (#4406)', () => checkAnnotationFillContract(IfcAPI));
  test('registered mesh transfer reports unknown coverage and binds prepared assets (#4381)', () => checkMeshTransferContract(IfcAPI));
  test('proper rigid scan registration preserves held-out independence and frame binding (#4381)', () => checkScanRegistrationContract(IfcAPI));
}

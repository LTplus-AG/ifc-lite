/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
/** Register actual-WASM appearance and annotation acceptance contracts. */
import { checkReferenceOpeningContract } from './wasm-reference-opening-contract.mjs';
import { checkPdfVectorContract } from './wasm-pdf-vector-contract.mjs';
import { checkAnnotationFillContract } from './wasm-annotation-fill-contract.mjs';
import { checkMeshTransferContract } from './wasm-mesh-transfer-contract.mjs';
import { checkMeshTransferSurfacesContract } from './wasm-mesh-transfer-surfaces-contract.mjs';
import { checkScanRegistrationContract } from './wasm-scan-registration-contract.mjs';

export function runAppearanceContracts(IfcAPI, test) {
  test('Reference-only openings preserve exact host image/UV binding (#4440)', () => checkReferenceOpeningContract(IfcAPI));
  test('PDF vector state preserves calibrated stroke transforms and reports omissions with oracle-frame extents (#4406)', () => checkPdfVectorContract(IfcAPI));
  test('annotation fills preserve holes, units and solid colour (#4406)', () => checkAnnotationFillContract(IfcAPI));
  test('registered mesh transfer reports unknown coverage and binds prepared assets (#4381)', () => checkMeshTransferContract(IfcAPI));
  test('thin-wall, occluder and gap observations classify without painting through (#4381)', () => checkMeshTransferSurfacesContract(IfcAPI));
  test('proper rigid scan registration preserves held-out independence and frame binding (#4381)', () => checkScanRegistrationContract(IfcAPI));
}

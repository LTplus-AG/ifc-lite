/* This Source Code Form is subject to the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { IfcParser } from '@ifc-lite/parser';
/** #7128 invariant: 1,200 real parsed walls exceed the native 500-entity write batch. */
export async function operationWalls(count = 1200) {
  const lines = Array.from({ length: count }, (_, i) =>
    `#${i + 10}=IFCWALL('${String(i).padStart(22, '0')}',$,'Wall ${i}',$,$,$,$,$,$);`);
  const text = `ISO-10303-21;\nHEADER;\nFILE_DESCRIPTION((''),'2;1');\nFILE_NAME('operations.ifc','2026-10-08',(''),(''),'','','');\nFILE_SCHEMA(('IFC4'));\nENDSEC;\nDATA;\n#1=IFCPROJECT('000000000000000000000p',$,'Operations',$,$,$,$,$,$);\n${lines.join('\n')}\nENDSEC;\nEND-ISO-10303-21;`;
  return new IfcParser().parseColumnar(new TextEncoder().encode(text).buffer, { disableWorkerScan: true });
}

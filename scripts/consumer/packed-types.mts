/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { openModel, type HeadlessModelSession, UnsupportedOperationError } from '@ifc-lite/sdk/headless';
import { parseModel, IfcInputError } from '@ifc-lite/parser';
import { GeometryProcessor } from '@ifc-lite/geometry';

declare const bytes: Uint8Array;
const session: HeadlessModelSession = await openModel(bytes);
const { report } = await parseModel(bytes);
const coverage: 'complete' | 'incomplete' | 'unknown' = report.completeness;
const available: boolean = session.capability('query.entities').supported;
// @ts-expect-error the public capability surface rejects unknown operations
session.capability('query.notAnOperation');
try { session.bim.query().byType('IfcDoor').toArray(); }
catch (error) {
  if (error instanceof UnsupportedOperationError) console.error(error.code, error.operation);
  else if (error instanceof IfcInputError) console.error(error.code);
  else throw error;
}
const processor = new GeometryProcessor();
processor.dispose();
session.close();
console.log(coverage, available);

/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { IfcParser, type IfcDataStore } from '@ifc-lite/parser';

/** Small real STEP store for spatial invariants; omitted datums stay omitted (#8042). */
export async function parseSpatialIfc(options: {
  verticalDatum?: string;
  horizontalId?: string;
  eastings?: number;
  northings?: number;
  orthogonalHeight?: number;
} = {}): Promise<IfcDataStore> {
  const quoted = (value: string | undefined) => value === undefined ? '$' : `'${value.replace(/'/g, "''")}'`;
  const source = `ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('Spatial placement test'),'2;1');
FILE_NAME('spatial-test.ifc','2026-01-01T00:00:00',(),(),'test','test','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPROJECT('0AAAAAAAAAAAAAAAAAAAAA',$,'Spatial test',$,$,$,$,(#10),#20);
#10=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-5,#12,$);
#12=IFCAXIS2PLACEMENT3D(#13,$,$);
#13=IFCCARTESIANPOINT((0.,0.,0.));
#20=IFCUNITASSIGNMENT((#21));
#21=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
#30=IFCPROJECTEDCRS(${quoted(options.horizontalId ?? 'EPSG:32760')},$,$,${quoted(options.verticalDatum)},$,$,#21);
#31=IFCMAPCONVERSION(#10,#30,${options.eastings ?? 100},${options.northings ?? 200},${options.orthogonalHeight ?? 10},1.,0.,1.);
ENDSEC;
END-ISO-10303-21;
`;
  return new IfcParser().parseColumnar(new TextEncoder().encode(source).buffer, { disableWorkerScan: true });
}

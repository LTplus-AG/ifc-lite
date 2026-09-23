/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #5290: `walkClassificationChain` `break`s out of its loop without
 * reporting anything when a chain link is dangling (`ReferencedSource`
 * names an id absent from the file) or an entity of an unexpected type
 * (neither `IfcClassification` nor `IfcClassificationReference`). Either
 * way it falls through to `return { codes }`, with `systemName` left
 * `undefined` -- structurally identical to a `IfcClassificationReference`
 * whose `ReferencedSource` is legitimately omitted (`$`), a schema-legal
 * end of the chain, NOT a defect. `extractClassificationsOnDemand`
 * (the caller) could not previously tell the two apart: both produced a
 * `ClassificationInfo` with `system: undefined` and no `unresolved` flag.
 *
 * Split out of #5227 (its second finding), as the maintainer asked there.
 */

import { describe, it, expect } from 'vitest';
import { IfcParser, extractClassificationsOnDemand } from './index.js';

const HEADER = `ISO-10303-21;
HEADER;
FILE_DESCRIPTION((''),'2;1');
FILE_NAME('t.ifc','',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;`;
const FOOTER = `ENDSEC;
END-ISO-10303-21;`;

async function parse(ifc: string) {
  return new IfcParser().parseColumnar(new TextEncoder().encode(ifc).buffer, {
    disableWorkerScan: true,
  });
}

describe('extractClassificationsOnDemand: a broken classification chain (#5290)', () => {
  it('marks the entry unresolved when ReferencedSource is dangling (#5227\'s own executed repro)', async () => {
    const ifc = `${HEADER}
#1=IFCWALL('gid',$,$,$,$,$,$,$,$);
#5=IFCRELASSOCIATESCLASSIFICATION('rid',$,$,$,(#1),#6);
#6=IFCCLASSIFICATIONREFERENCE($,'Ss_25_10','Walls',#999,$,$);
${FOOTER}`;
    const store = await parse(ifc);
    const results = extractClassificationsOnDemand(store, 1);
    expect(results).toHaveLength(1);
    expect(results[0].unresolved).toBe(true);
    expect(results[0].system).toBeUndefined();
    // The reference's own attributes are still readable -- only the SYSTEM
    // chain is broken -- so identification/name survive.
    expect(results[0].identification).toBe('Ss_25_10');
  });

  it('marks the entry unresolved when ReferencedSource names an entity of an unexpected type', async () => {
    const ifc = `${HEADER}
#1=IFCWALL('gid',$,$,$,$,$,$,$,$);
#5=IFCRELASSOCIATESCLASSIFICATION('rid',$,$,$,(#1),#6);
#6=IFCCLASSIFICATIONREFERENCE($,'Ss_25_10','Walls',#7,$,$);
#7=IFCWALL('gid2',$,$,$,$,$,$,$,$);
${FOOTER}`;
    const store = await parse(ifc);
    const results = extractClassificationsOnDemand(store, 1);
    expect(results).toHaveLength(1);
    expect(results[0].unresolved).toBe(true);
  });

  it('control: a well-formed chain resolves the system and is NOT marked unresolved', async () => {
    const ifc = `${HEADER}
#1=IFCWALL('gid',$,$,$,$,$,$,$,$);
#5=IFCRELASSOCIATESCLASSIFICATION('rid',$,$,$,(#1),#6);
#6=IFCCLASSIFICATIONREFERENCE($,'Ss_25_10','Walls',#7,$,$);
#7=IFCCLASSIFICATION($,$,$,'Uniclass 2015',$,$,$);
${FOOTER}`;
    const store = await parse(ifc);
    const results = extractClassificationsOnDemand(store, 1);
    expect(results).toHaveLength(1);
    expect(results[0].unresolved).toBeFalsy();
    expect(results[0].system).toBe('Uniclass 2015');
  });

  it('control: a ReferencedSource omitted entirely ($) is a legitimate, schema-permitted chain end -- NOT marked unresolved', async () => {
    const ifc = `${HEADER}
#1=IFCWALL('gid',$,$,$,$,$,$,$,$);
#5=IFCRELASSOCIATESCLASSIFICATION('rid',$,$,$,(#1),#6);
#6=IFCCLASSIFICATIONREFERENCE($,'Ss_25_10','Walls',$,$,$);
${FOOTER}`;
    const store = await parse(ifc);
    const results = extractClassificationsOnDemand(store, 1);
    expect(results).toHaveLength(1);
    expect(results[0].unresolved).toBeFalsy();
    expect(results[0].system).toBeUndefined();
  });

  it('control: a chain cycle is unresolved (never reaches a root, never legitimately terminates)', async () => {
    const ifc = `${HEADER}
#1=IFCWALL('gid',$,$,$,$,$,$,$,$);
#5=IFCRELASSOCIATESCLASSIFICATION('rid',$,$,$,(#1),#6);
#6=IFCCLASSIFICATIONREFERENCE($,'Ss_25_10','Walls',#7,$,$);
#7=IFCCLASSIFICATIONREFERENCE($,'Ss_25','Walls (parent)',#6,$,$);
${FOOTER}`;
    const store = await parse(ifc);
    const results = extractClassificationsOnDemand(store, 1);
    expect(results).toHaveLength(1);
    expect(results[0].unresolved).toBe(true);
  });
});

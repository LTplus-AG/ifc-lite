/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #5290: a classification chain with a dangling `ReferencedSource` (or one
 * pointing at an entity of an unexpected type) reported a confident
 * `CLASSIFICATION_SYSTEM_MISMATCH` instead of `CLASSIFICATION_UNRESOLVED`.
 *
 * `walkClassificationChain` (`@ifc-lite/parser`'s `classification-resolver.ts`)
 * `break`s out of its loop without reporting anything when a chain link is
 * dangling or an unexpected type, and returns with `systemName` left
 * `undefined`. `resolveClassifications` (`bridge/classifications.ts`) then
 * flattens that to `system: ''` (`c.system || ''`), which the facet used to
 * read as a resolved, classified entity with an EMPTY system -- a definite
 * mismatch, not "the chain could not be resolved". This exercises the fix
 * through the real bridge/facet path, using the issue's own executed repro:
 * `#3`'s `ReferencedSource` pointing at a nonexistent `#999`.
 *
 * Split out of #5227 (its second finding), as the maintainer asked there.
 */

import { describe, it, expect } from 'vitest';
import { IfcParser } from '@ifc-lite/parser';
import { createDataAccessor } from '../bridge/data-accessor.js';
import { checkClassificationFacet } from './classification-facet.js';
import type { IDSClassificationFacet, IDSSimpleValue } from '../types.js';

const sv = (value: string): IDSSimpleValue => ({ type: 'simpleValue', value });

const HEADER = `ISO-10303-21;
HEADER;
FILE_DESCRIPTION((''),'2;1');
FILE_NAME('t.ifc','',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;`;
const FOOTER = `ENDSEC;
END-ISO-10303-21;`;

async function accessorFor(ifc: string) {
  const store = await new IfcParser().parseColumnar(
    new TextEncoder().encode(ifc).buffer,
    { disableWorkerScan: true },
  );
  return createDataAccessor(store);
}

const systemFacet: IDSClassificationFacet = {
  type: 'classification',
  system: sv('Uniclass 2015'),
};

describe('checkClassificationFacet: a broken classification chain reports UNRESOLVED, not a confident mismatch (#5290)', () => {
  it("a dangling ReferencedSource -- #5227's own executed repro -- is CLASSIFICATION_UNRESOLVED, not CLASSIFICATION_SYSTEM_MISMATCH", async () => {
    const ifc = `${HEADER}
#1=IFCWALL('gid',$,$,$,$,$,$,$,$);
#5=IFCRELASSOCIATESCLASSIFICATION('rid',$,$,$,(#1),#6);
#6=IFCCLASSIFICATIONREFERENCE($,'Ss_25_10','Walls',#999,$,$);
${FOOTER}`;
    const a = await accessorFor(ifc);
    const result = checkClassificationFacet(systemFacet, 1, a);
    expect(result.passed).toBe(false);
    expect(result.failure?.type).toBe('CLASSIFICATION_UNRESOLVED');
  });

  it('a ReferencedSource pointing at an entity of the wrong type is also CLASSIFICATION_UNRESOLVED', async () => {
    const ifc = `${HEADER}
#1=IFCWALL('gid',$,$,$,$,$,$,$,$);
#5=IFCRELASSOCIATESCLASSIFICATION('rid',$,$,$,(#1),#6);
#6=IFCCLASSIFICATIONREFERENCE($,'Ss_25_10','Walls',#7,$,$);
#7=IFCWALL('gid2',$,$,$,$,$,$,$,$);
${FOOTER}`;
    const a = await accessorFor(ifc);
    const result = checkClassificationFacet(systemFacet, 1, a);
    expect(result.passed).toBe(false);
    expect(result.failure?.type).toBe('CLASSIFICATION_UNRESOLVED');
  });

  it('control: a well-formed chain still reports a real mismatch as CLASSIFICATION_SYSTEM_MISMATCH (no regression)', async () => {
    const ifc = `${HEADER}
#1=IFCWALL('gid',$,$,$,$,$,$,$,$);
#5=IFCRELASSOCIATESCLASSIFICATION('rid',$,$,$,(#1),#6);
#6=IFCCLASSIFICATIONREFERENCE($,'Ss_25_10','Walls',#7,$,$);
#7=IFCCLASSIFICATION($,$,$,'Some Other System',$,$,$);
${FOOTER}`;
    const a = await accessorFor(ifc);
    const result = checkClassificationFacet(systemFacet, 1, a);
    expect(result.passed).toBe(false);
    expect(result.failure?.type).toBe('CLASSIFICATION_SYSTEM_MISMATCH');
  });

  it('control: a ReferencedSource omitted entirely ($) is a legitimate, schema-permitted chain end -- still a real mismatch, not UNRESOLVED', async () => {
    const ifc = `${HEADER}
#1=IFCWALL('gid',$,$,$,$,$,$,$,$);
#5=IFCRELASSOCIATESCLASSIFICATION('rid',$,$,$,(#1),#6);
#6=IFCCLASSIFICATIONREFERENCE($,'Ss_25_10','Walls',$,$,$);
${FOOTER}`;
    const a = await accessorFor(ifc);
    const result = checkClassificationFacet(systemFacet, 1, a);
    expect(result.passed).toBe(false);
    expect(result.failure?.type).toBe('CLASSIFICATION_SYSTEM_MISMATCH');
  });
});

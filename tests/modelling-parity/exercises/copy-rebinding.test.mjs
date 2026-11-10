/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { copiedWallAttachments } from './copy-rebinding.mjs';

test('#9314 a surviving correct attachment cannot mask another copied wall losing its pset', () => {
  const meta={expected:[{expressId:1,kind:'wall',copied:true,level:0},{expressId:2,kind:'wall',copied:true,level:0}],levels:[{}, {GlobalId:'upper'}]};
  const records=new Map([[1,"IFCWALL('a')"],[2,"IFCWALL('b')"],[3,"IFCRELDEFINESBYPROPERTIES('r',$,$,$,(#1),#4)"],[4,"IFCPROPERTYSET('p',$,'IfcLite_StoreyAttachment',$,(#5))"],[5,"IFCPROPERTYSINGLEVALUE('TopConstraint',$,IFCLABEL('upper'),$)"]]);
  assert.deepEqual(copiedWallAttachments(meta,records),{checked:1,wrong:0,missing:1,copiedWalls:2,copiedCount:2});
  records.set(6,"IFCRELDEFINESBYPROPERTIES('r2',$,$,$,(#2),#4)");
  assert.equal(copiedWallAttachments(meta,records).missing,0);
  records.set(5,"IFCPROPERTYSINGLEVALUE('TopConstraint',$,IFCLABEL('old-storey'),$)");
  assert.equal(copiedWallAttachments(meta,records).wrong,2);
});

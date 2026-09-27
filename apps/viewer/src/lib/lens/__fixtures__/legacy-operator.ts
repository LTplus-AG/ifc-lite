/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Parsed IFC property-filter fixture shared by the legacy parity and Lists runtime tests. */
import type { ConditionOperator } from '@ifc-lite/lists';

export const IFC = `ISO-10303-21;
HEADER;FILE_DESCRIPTION((''),'2;1');FILE_NAME('t','',(''),(''),'','','');FILE_SCHEMA(('IFC4'));ENDSEC;
DATA;
#1=IFCPROJECT('0Proj000000000000000001',$,'P',$,$,$,$,$,$);
#10=IFCWALL('0Wall000000000000000010',$,'Red wall',$,$,$,$,$,$);
#11=IFCPROPERTYSINGLEVALUE('Text',$,IFCLABEL('Red'),$);
#12=IFCPROPERTYSINGLEVALUE('Number',$,IFCREAL(10.),$);
#13=IFCPROPERTYSINGLEVALUE('Nullable',$,$,$);
#16=IFCPROPERTYSINGLEVALUE('Flag',$,IFCBOOLEAN(.T.),$);
#14=IFCPROPERTYSET('0Pset000000000000000014',$,'Pset_Test',$,(#11,#12,#13,#16));
#15=IFCRELDEFINESBYPROPERTIES('0Rel000000000000000015',$,$,$,(#10),#14);
#17=IFCPROPERTYSINGLEVALUE('FireRating',$,IFCLABEL('1HR'),$);
#18=IFCPROPERTYSET('0Pset000000000000000018',$,'Pset_Test',$,(#17));
#19=IFCRELDEFINESBYPROPERTIES('0Rel000000000000000019',$,$,$,(#10),#18);
#41=IFCPROPERTYSINGLEVALUE('FireRating',$,IFCLABEL('2HR'),$);
#42=IFCPROPERTYSET('0Pset000000000000000042',$,'Pset_Test',$,(#41));
#43=IFCRELDEFINESBYPROPERTIES('0Rel000000000000000043',$,$,$,(#10),#42);
#44=IFCPROPERTYLISTVALUE('Colors',$,(IFCLABEL('Red'),IFCLABEL('Blue')),$);
#45=IFCPROPERTYSET('0Pset000000000000000045',$,'Pset_Test',$,(#44));
#46=IFCRELDEFINESBYPROPERTIES('0Rel000000000000000046',$,$,$,(#10),#45);
#50=IFCWALLTYPE('0Type00000000000000050',$,'WT',$,$,(#52),$,$,$,.NOTDEFINED.);
#51=IFCPROPERTYSINGLEVALUE('FireRating',$,IFCLABEL('TYPE'),$);
#52=IFCPROPERTYSET('0Pset000000000000000052',$,'Pset_Test',$,(#51));
#53=IFCRELDEFINESBYTYPE('0Rel000000000000000053',$,$,$,(#10),#50);
#20=IFCWALL('0Wall000000000000000020',$,'Blue wall',$,$,$,$,$,$);
#21=IFCPROPERTYSINGLEVALUE('Text',$,IFCLABEL('Blue'),$);
#22=IFCPROPERTYSINGLEVALUE('Number',$,IFCREAL(20.),$);
#23=IFCPROPERTYSINGLEVALUE('Nullable',$,IFCLABEL(''),$);
#26=IFCPROPERTYSINGLEVALUE('Flag',$,IFCBOOLEAN(.F.),$);
#24=IFCPROPERTYSET('0Pset000000000000000024',$,'Pset_Test',$,(#21,#22,#23,#26));
#25=IFCRELDEFINESBYPROPERTIES('0Rel000000000000000025',$,$,$,(#20),#24);
#30=IFCWALL('0Wall000000000000000030',$,'Lower wall',$,$,$,$,$,$);
#31=IFCPROPERTYSINGLEVALUE('Text',$,IFCLABEL('red'),$);
#32=IFCPROPERTYSINGLEVALUE('Number',$,IFCREAL(5.),$);
#33=IFCPROPERTYSINGLEVALUE('Nullable',$,IFCLABEL('x'),$);
#36=IFCPROPERTYSINGLEVALUE('Flag',$,IFCBOOLEAN(.T.),$);
#34=IFCPROPERTYSET('0Pset000000000000000034',$,'Pset_Test',$,(#31,#32,#33,#36));
#35=IFCRELDEFINESBYPROPERTIES('0Rel000000000000000035',$,$,$,(#30),#34);
#40=IFCWALL('0Wall000000000000000040',$,'Missing wall',$,$,$,$,$,$);
ENDSEC;
END-ISO-10303-21;`;

export const IDS = [10, 20, 30, 40];

export const listCases = {
  equals: ['Text', 'red'], notEquals: ['Text', 'red'], contains: ['Text', 'red'],
  gt: ['Number', '10'], gte: ['Number', '10'], lt: ['Number', '10'], lte: ['Number', '10'],
  exists: ['Nullable', ''],
} satisfies Record<ConditionOperator, [string, string]>;

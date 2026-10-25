/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EntityExtractor, extractTypeEntityOwnProperties } from '@ifc-lite/parser';
import { DEFAULT_CONFIG, InMemoryModelRegistry, NOOP_PROGRESS, SILENT_LOGGER, type ToolContext } from '../context.js';
import { fullScope } from '../auth/scope.js';
import { loadIfcModel } from '../loader.js';
import { mutationTools } from './mutate.js';
import { exportTools } from './export.js';

const source = `ISO-10303-21;
HEADER;
FILE_DESCRIPTION((''),'2;1');
FILE_NAME('','',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCWALLTYPE('0aaaaaaaaaaaaaaaaaaaaa',$,'Type A',$,$,(#3),$,'T-001','Wall',.STANDARD.);
#2=IFCPROPERTYSINGLEVALUE('FireRating',$,IFCLABEL('EI60'),$);
#3=IFCPROPERTYSET('0bbbbbbbbbbbbbbbbbbbbb',$,'Pset_TestType',$,(#2,#4));
#4=IFCPROPERTYSINGLEVALUE('Code',$,IFCLABEL('TYPE-001'),$);
ENDSEC;
END-ISO-10303-21;`;

describe('MCP type-owned mutation round trip (#8056)', () => {
  it('preserves siblings and HasPropertySets ownership through entity_set_property and export_ifc', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mcp-type-mutate-'));
    try {
      const input = join(dir, 'input.ifc');
      const output = join(dir, 'output.ifc');
      await writeFile(input, source);
      const ctx: ToolContext = {
        registry: new InMemoryModelRegistry(), scope: fullScope(), progress: NOOP_PROGRESS,
        log: SILENT_LOGGER, signal: new AbortController().signal,
        config: { ...DEFAULT_CONFIG, allowedPaths: [dir] },
      };
      ctx.registry.add(await loadIfcModel(input, { modelId: 'm' }));
      const mutate = mutationTools.find(tool => tool.name === 'entity_set_property');
      const exportIfc = exportTools.find(tool => tool.name === 'export_ifc');
      if (!mutate || !exportIfc) throw new Error('MCP tools missing');
      expect((await mutate.handler({ model_id: 'm', express_id: 1, pset: 'Pset_TestType', name: 'FireRating', value: 'EI90' }, ctx)).isError)
        .toBeUndefined();
      expect((await exportIfc.handler({ model_id: 'm', file_path: output }, ctx)).isError).toBeUndefined();
      const { store } = await loadIfcModel(output, { modelId: 'result' });
      const properties = extractTypeEntityOwnProperties(store, 1).find(set => set.name === 'Pset_TestType')?.properties;
      expect(properties?.map(property => ({ name: property.name, value: property.value })))
        .toEqual(expect.arrayContaining([{ name: 'FireRating', value: 'EI90' }, { name: 'Code', value: 'TYPE-001' }]));
      expect(properties).toHaveLength(2);
      const extractor = new EntityExtractor(store.source);
      const typeRef = store.entityIndex.byId.get(1);
      if (!typeRef) throw new Error('type missing');
      const ids = extractor.extractEntity(typeRef)?.attributes[5];
      expect(Array.isArray(ids)).toBe(true);
      if (!Array.isArray(ids)) throw new Error('HasPropertySets missing');
      expect(ids.map(id => {
        if (typeof id !== 'number') throw new Error('non-reference');
        const ref = store.entityIndex.byId.get(id);
        if (!ref) throw new Error('owned set missing');
        return extractor.extractEntity(ref)?.attributes[2];
      })).toEqual(['Pset_TestType']);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

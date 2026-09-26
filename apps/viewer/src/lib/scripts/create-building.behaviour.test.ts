/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { IfcCreator } from '@ifc-lite/create';
import { SCRIPT_TEMPLATES } from './templates.js';

describe('create-building template', () => {
  it('#6088 runs the shipped script and exports attributed, filled two-storey geometry', () => {
    const template = SCRIPT_TEMPLATES.find(t => t.name === 'Create building (IFC from scratch)');
    assert.ok(template);
    let creator: IfcCreator | undefined;
    let loaded: string | undefined;
    let downloaded: string | undefined;
    const create = new Proxy({}, {
      get(_target, property) {
        if (property === 'project') return (params: ConstructorParameters<typeof IfcCreator>[0]) => {
          creator = new IfcCreator(params);
          return 1;
        };
        return (handle: number, ...args: unknown[]) => {
          assert.equal(handle, 1);
          assert.ok(creator);
          const method: unknown = Reflect.get(creator, property);
          if (typeof method !== 'function') throw new Error(`Unknown create method: ${String(property)}`);
          return Reflect.apply(method, creator, args);
        };
      },
    });
    const js = ts.transpileModule(template.code, {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
    }).outputText;
    runInNewContext(js, {
      bim: {
        create,
        model: { loadIfc(content: string) { loaded = content; } },
        export: { download(content: string) { downloaded = content; } },
      },
      console: { log() {} },
    }, { timeout: 30_000 });

    const content = loaded;
    assert.ok(content);
    assert.equal(downloaded, content);
    const count = (type: string) => (content.match(new RegExp(`=IFC${type}\\(`, 'g')) ?? []).length;
    assert.equal(count('BUILDINGSTOREY'), 2);
    assert.equal(count('WALL'), 8);
    assert.equal(count('SLAB'), 2);
    assert.equal(count('COLUMN'), 8);
    assert.equal(count('BEAM'), 376); // 4 structural + 320 laths + 52 ring segments
    assert.equal(count('STAIR'), 1);
    assert.equal(count('DOOR'), 1);
    assert.equal(count('WINDOW'), 5);
    assert.equal(count('RELFILLSELEMENT'), 6);
    assert.equal(count('RELVOIDSELEMENT'), 7); // six filled openings + stair opening

    // These are IFC output assertions, not checks against the template source.
    assert.ok(/IFCQUANTITYAREA\('NetArea',\$,\$,34\.96/.test(content), 'stair opening reduces slab net area');
    assert.ok(/IFCQUANTITYVOLUME\('GrossVolume',\$,\$,0\.83776/.test(content), 'stair volume matches treads');
    assert.ok(/IFCMATERIALLAYER\(#[0-9]+,0\.1/.test(content), 'wall has a 100 mm structural layer');
  });
});

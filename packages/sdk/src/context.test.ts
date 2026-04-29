/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it, expect, vi } from 'vitest';
import { BimContext, createBimContext } from './context.js';
import type { BimBackend, Transport } from './types.js';

/** Create a mock typed BimBackend */
function createMockBackend() {
  const model = {
    list: vi.fn(() => []),
    activeId: vi.fn(() => null),
  };
  const query = {
    entities: vi.fn(() => []),
    entityData: vi.fn(() => null),
    attributes: vi.fn(() => []),
    properties: vi.fn(() => []),
    quantities: vi.fn(() => []),
    classifications: vi.fn(() => []),
    materials: vi.fn(() => null),
    typeProperties: vi.fn(() => null),
    documents: vi.fn(() => []),
    relationships: vi.fn(() => ({ voids: [], fills: [], groups: [], connections: [] })),
    related: vi.fn(() => []),
  };
  const selection = {
    get: vi.fn(() => []),
    set: vi.fn(),
  };
  const visibility = {
    hide: vi.fn(),
    show: vi.fn(),
    isolate: vi.fn(),
    reset: vi.fn(),
  };
  const viewer = {
    colorize: vi.fn(),
    colorizeAll: vi.fn(),
    resetColors: vi.fn(),
    flyTo: vi.fn(),
    setSection: vi.fn(),
    getSection: vi.fn(() => null),
    setCamera: vi.fn(),
    getCamera: vi.fn(() => ({ mode: 'perspective' as const, position: [0, 0, 0] as [number, number, number], target: [0, 0, 0] as [number, number, number], up: [0, 1, 0] as [number, number, number] })),
  };
  const mutate = {
    setProperty: vi.fn(),
    setAttribute: vi.fn(),
    deleteProperty: vi.fn(),
    batchBegin: vi.fn(),
    batchEnd: vi.fn(),
    undo: vi.fn(() => false),
    redo: vi.fn(() => false),
  };
  const store = {
    addEntity: vi.fn((modelId: string) => ({ modelId, expressId: 1 })),
    removeEntity: vi.fn(() => true),
    setPositionalAttribute: vi.fn(),
    addColumn: vi.fn((modelId: string) => ({ modelId, expressId: 99 })),
  };
  const spatial = {
    queryBounds: vi.fn(() => []),
    raycast: vi.fn(() => []),
    queryFrustum: vi.fn(() => []),
  };
  const exportNs = {
    csv: vi.fn(() => ''),
    json: vi.fn(() => []),
    ifc: vi.fn(() => 'ISO-10303-21;\nEND-ISO-10303-21;'),
    download: vi.fn(),
  };
  const lens = {
    presets: vi.fn(() => []),
    create: vi.fn(),
    activate: vi.fn(),
    deactivate: vi.fn(),
    getActive: vi.fn(() => null),
  };
  const files = {
    list: vi.fn(() => []),
    text: vi.fn(() => null),
    csv: vi.fn(() => null),
    csvColumns: vi.fn(() => []),
  };

  const backend: BimBackend = {
    model,
    query,
    selection,
    visibility,
    viewer,
    mutate,
    store,
    spatial,
    export: exportNs,
    lens,
    files,
    subscribe: vi.fn(() => () => {}),
  };

  return { backend, model, query, selection, visibility, viewer, mutate, store, spatial, export: exportNs, lens, files };
}

describe('BimContext', () => {
  it('creates a context with a backend', () => {
    const { backend } = createMockBackend();
    const bim = createBimContext({ backend });

    expect(bim).toBeInstanceOf(BimContext);
    expect(bim.model).toBeDefined();
    expect(bim.viewer).toBeDefined();
    expect(bim.mutate).toBeDefined();
    expect(bim.lens).toBeDefined();
    expect(bim.export).toBeDefined();
    expect(bim.files).toBeDefined();
    expect(bim.ids).toBeDefined();
    expect(bim.bcf).toBeDefined();
    expect(bim.drawing).toBeDefined();
    expect(bim.list).toBeDefined();
    expect(bim.events).toBeDefined();
    expect(bim.spatial).toBeDefined();
  });

  it('throws without backend or transport', () => {
    expect(() => createBimContext({} as {} & { backend?: BimBackend })).toThrow('BimContext requires either a backend or transport');
  });

  it('query() returns a QueryBuilder', () => {
    const { backend } = createMockBackend();
    const bim = createBimContext({ backend });

    const builder = bim.query();
    expect(builder).toBeDefined();
    expect(typeof builder.byType).toBe('function');
    expect(typeof builder.toArray).toBe('function');
  });

  it('entity() returns null for unknown entity', () => {
    const { backend } = createMockBackend();
    const bim = createBimContext({ backend });

    const result = bim.entity({ modelId: 'test', expressId: 999 });
    expect(result).toBeNull();
  });

  it('on() delegates to events namespace', () => {
    const { backend } = createMockBackend();
    const bim = createBimContext({ backend });

    expect(typeof bim.on).toBe('function');
  });

  it('fails explicitly when sandbox is used with a transport-backed context', async () => {
    const transport: Transport = {
      subscribe: vi.fn(() => () => {}),
    };
    const bim = createBimContext({ transport });

    await expect(bim.sandbox.eval('bim.model.list()')).rejects.toThrow(
      'bim.sandbox is not supported for transport-backed contexts',
    );
  });
});

describe('QueryBuilder', () => {
  it('chains methods and calls backend.query.entities', () => {
    const { backend, query } = createMockBackend();
    query.entities.mockReturnValue([
      { ref: { modelId: 'model-1', expressId: 1 }, globalId: 'abc', name: 'Wall 1', type: 'IfcWall', description: '', objectType: '' },
    ]);

    const bim = createBimContext({ backend });
    const results = bim.query().byType('IfcWall').toArray();

    expect(results).toHaveLength(1);
    expect(results[0].name).toBe('Wall 1');
    expect(results[0].type).toBe('IfcWall');
    expect(query.entities).toHaveBeenCalled();
  });

  it('count() returns number of matches', () => {
    const { backend, query } = createMockBackend();
    query.entities.mockReturnValue([
      { ref: { modelId: 'model-1', expressId: 1 }, globalId: 'abc', name: 'Wall 1', type: 'IfcWall', description: '', objectType: '' },
      { ref: { modelId: 'model-1', expressId: 2 }, globalId: 'def', name: 'Wall 2', type: 'IfcWall', description: '', objectType: '' },
    ]);

    const bim = createBimContext({ backend });
    const count = bim.query().byType('IfcWall').count();

    expect(count).toBe(2);
  });

  it('first() returns first match or null', () => {
    const { backend } = createMockBackend();
    const bim = createBimContext({ backend });

    const result = bim.query().first();
    expect(result).toBeNull();
  });

  it('refs() returns EntityRef array', () => {
    const { backend, query } = createMockBackend();
    query.entities.mockReturnValue([
      { ref: { modelId: 'model-1', expressId: 1 }, globalId: 'abc', name: 'Wall 1', type: 'IfcWall', description: '', objectType: '' },
    ]);

    const bim = createBimContext({ backend });
    const refs = bim.query().refs();

    expect(refs).toHaveLength(1);
    expect(refs[0]).toEqual({ modelId: 'model-1', expressId: 1 });
  });
});

describe('QueryNamespace helpers', () => {
  it('attributes() returns named IFC attributes', () => {
    const { backend, query } = createMockBackend();
    query.attributes.mockReturnValue([
      { name: 'PredefinedType', value: 'STANDARD' },
    ]);

    const bim = createBimContext({ backend });
    const attrs = bim.attributes({ modelId: 'model-1', expressId: 1 });

    expect(attrs).toEqual([{ name: 'PredefinedType', value: 'STANDARD' }]);
  });

  it('property() returns a single property value', () => {
    const { backend, query } = createMockBackend();
    query.properties.mockReturnValue([
      {
        name: 'Pset_WallCommon',
        properties: [{ name: 'IsExternal', type: 0, value: true }],
      },
    ]);

    const bim = createBimContext({ backend });
    const value = bim.property({ modelId: 'model-1', expressId: 1 }, 'Pset_WallCommon', 'IsExternal');

    expect(value).toBe(true);
  });

  it('materials() returns structured material data', () => {
    const { backend, query } = createMockBackend();
    query.materials.mockReturnValue({
      type: 'Material',
      name: 'Concrete',
      description: 'Structural concrete',
    });

    const bim = createBimContext({ backend });
    const material = bim.materials({ modelId: 'model-1', expressId: 1 });

    expect(material?.name).toBe('Concrete');
    expect(material?.type).toBe('Material');
  });

  it('classifications() returns classification references', () => {
    const { backend, query } = createMockBackend();
    query.classifications.mockReturnValue([
      { system: 'Uniclass', identification: 'EF_25', name: 'Walls' },
    ]);

    const bim = createBimContext({ backend });
    const classifications = bim.classifications({ modelId: 'model-1', expressId: 1 });

    expect(classifications).toHaveLength(1);
    expect(classifications[0].system).toBe('Uniclass');
  });

  it('path() walks from project to entity', () => {
    const { backend, query } = createMockBackend();
    query.entityData.mockImplementation((ref) => {
      if (ref.expressId === 4) return { ref, globalId: '4', name: 'Wall 1', type: 'IfcWall', description: '', objectType: '' };
      if (ref.expressId === 3) return { ref, globalId: '3', name: 'Level 1', type: 'IfcBuildingStorey', description: '', objectType: '' };
      if (ref.expressId === 2) return { ref, globalId: '2', name: 'Building', type: 'IfcBuilding', description: '', objectType: '' };
      if (ref.expressId === 1) return { ref, globalId: '1', name: 'Project', type: 'IfcProject', description: '', objectType: '' };
      return null;
    });
    query.related.mockImplementation((ref, relType, direction) => {
      if (relType === 'IfcRelContainedInSpatialStructure' && direction === 'inverse' && ref.expressId === 4) {
        return [{ modelId: 'model-1', expressId: 3 }];
      }
      if (relType === 'IfcRelAggregates' && direction === 'inverse' && ref.expressId === 3) {
        return [{ modelId: 'model-1', expressId: 2 }];
      }
      if (relType === 'IfcRelAggregates' && direction === 'inverse' && ref.expressId === 2) {
        return [{ modelId: 'model-1', expressId: 1 }];
      }
      return [];
    });

    const bim = createBimContext({ backend });
    const path = bim.path({ modelId: 'model-1', expressId: 4 });

    expect(path.map((entity) => entity.type)).toEqual(['IfcProject', 'IfcBuilding', 'IfcBuildingStorey', 'IfcWall']);
  });

  it('storeys() returns building storeys', () => {
    const { backend, query } = createMockBackend();
    query.entities.mockReturnValue([
      { ref: { modelId: 'model-1', expressId: 3 }, globalId: '3', name: 'Level 1', type: 'IfcBuildingStorey', description: '', objectType: '' },
    ]);

    const bim = createBimContext({ backend });
    const storeys = bim.storeys();

    expect(storeys).toHaveLength(1);
    expect(storeys[0].type).toBe('IfcBuildingStorey');
  });
});

describe('ExportNamespace', () => {
  it('csv() generates CSV string', () => {
    const { backend, query } = createMockBackend();
    query.entityData.mockReturnValue({
      ref: { modelId: 'model-1', expressId: 1 },
      globalId: 'abc',
      name: 'Wall 1',
      type: 'IfcWall',
      description: '',
      objectType: '',
    });

    const bim = createBimContext({ backend });
    const csv = bim.export.csv(
      [{ modelId: 'model-1', expressId: 1 }],
      { columns: ['name', 'type'] },
    );

    expect(csv).toContain('name,type');
    expect(csv).toContain('Wall 1,IfcWall');
  });

  it('json() generates JSON array', () => {
    const { backend, query } = createMockBackend();
    query.entityData.mockReturnValue({
      ref: { modelId: 'model-1', expressId: 1 },
      globalId: 'abc',
      name: 'Wall 1',
      type: 'IfcWall',
      description: '',
      objectType: '',
    });

    const bim = createBimContext({ backend });
    const data = bim.export.json(
      [{ modelId: 'model-1', expressId: 1 }],
      ['name', 'type'],
    );

    expect(data).toHaveLength(1);
    expect(data[0]).toEqual({ name: 'Wall 1', type: 'IfcWall' });
  });

  it('ifc() delegates to backend export.ifc', () => {
    const { backend, export: exportNs } = createMockBackend();
    const bim = createBimContext({ backend });

    const content = bim.export.ifc(
      [{ modelId: 'model-1', expressId: 1 }],
      { schema: 'IFC4X3' },
    );

    expect(content).toContain('ISO-10303-21');
    expect(exportNs.ifc).toHaveBeenCalledWith(
      [{ modelId: 'model-1', expressId: 1 }],
      { schema: 'IFC4X3' },
    );
  });

});

describe('FilesNamespace', () => {
  it('list() delegates to backend.files.list', () => {
    const { backend, files } = createMockBackend();
    files.list.mockReturnValue([
      { name: 'entities.csv', type: 'text/csv', size: 128, rowCount: 2, columns: ['GlobalId', 'Description'], hasTextContent: true },
    ]);

    const bim = createBimContext({ backend });
    const attachments = bim.files.list();

    expect(attachments).toHaveLength(1);
    expect(attachments[0].name).toBe('entities.csv');
  });

  it('csv() delegates to backend.files.csv', () => {
    const { backend, files } = createMockBackend();
    files.csv.mockReturnValue([
      { GlobalId: 'abc', Description: 'Wall A' },
    ]);

    const bim = createBimContext({ backend });
    const rows = bim.files.csv('entities.csv');

    expect(rows).toEqual([{ GlobalId: 'abc', Description: 'Wall A' }]);
    expect(files.csv).toHaveBeenCalledWith('entities.csv');
  });
});

describe('ViewerNamespace', () => {
  it('colorize() calls viewer.colorize', () => {
    const { backend, viewer } = createMockBackend();
    const bim = createBimContext({ backend });

    bim.viewer.colorize([{ modelId: 'm', expressId: 1 }], '#ff0000');
    expect(viewer.colorize).toHaveBeenCalled();
  });

  it('hide() calls visibility.hide', () => {
    const { backend, visibility } = createMockBackend();
    const bim = createBimContext({ backend });

    bim.viewer.hide([{ modelId: 'm', expressId: 1 }]);
    expect(visibility.hide).toHaveBeenCalled();
  });

  it('select() calls selection.set', () => {
    const { backend, selection } = createMockBackend();
    const bim = createBimContext({ backend });

    bim.viewer.select([{ modelId: 'm', expressId: 1 }]);
    expect(selection.set).toHaveBeenCalled();
  });
});

describe('MutateNamespace', () => {
  it('bim.store.addEntity routes through the store backend with the expected def', () => {
    const { backend, store } = createMockBackend();
    store.addEntity.mockReturnValue({ modelId: 'arch', expressId: 11 });
    const bim = createBimContext({ backend });

    const ref = bim.store.addEntity('arch', {
      type: 'IFCRECTANGLEPROFILEDEF',
      attributes: ['.AREA.', null, '#34', 0.6, 0.4],
    });

    expect(store.addEntity).toHaveBeenCalledWith('arch', {
      type: 'IFCRECTANGLEPROFILEDEF',
      attributes: ['.AREA.', null, '#34', 0.6, 0.4],
    });
    expect(ref).toEqual({ modelId: 'arch', expressId: 11 });
  });

  it('bim.store.addColumn forwards modelId, storeyExpressId, and params to the backend', () => {
    const { backend, store } = createMockBackend();
    store.addColumn.mockReturnValue({ modelId: 'arch', expressId: 99 });
    const bim = createBimContext({ backend });

    const ref = bim.store.addColumn('arch', 12, {
      Position: [1, 1, 0],
      Width: 0.3,
      Depth: 0.4,
      Height: 3,
      Name: 'Column 1',
    });

    expect(store.addColumn).toHaveBeenCalledWith('arch', 12, {
      Position: [1, 1, 0],
      Width: 0.3,
      Depth: 0.4,
      Height: 3,
      Name: 'Column 1',
    });
    expect(ref).toEqual({ modelId: 'arch', expressId: 99 });
  });

  it('bim.store.removeEntity / setPositionalAttribute pass through to the backend', () => {
    const { backend, store } = createMockBackend();
    const bim = createBimContext({ backend });

    bim.store.removeEntity({ modelId: 'arch', expressId: 35 });
    bim.store.setPositionalAttribute({ modelId: 'arch', expressId: 35 }, 3, 0.6);

    expect(store.removeEntity).toHaveBeenCalledWith({ modelId: 'arch', expressId: 35 });
    expect(store.setPositionalAttribute).toHaveBeenCalledWith(
      { modelId: 'arch', expressId: 35 },
      3,
      0.6,
    );
  });

  it('setProperty() calls mutate.setProperty', () => {
    const { backend, mutate } = createMockBackend();
    const bim = createBimContext({ backend });

    bim.mutate.setProperty({ modelId: 'm', expressId: 1 }, 'Pset', 'Prop', 'value');
    expect(mutate.setProperty).toHaveBeenCalledWith(
      { modelId: 'm', expressId: 1 }, 'Pset', 'Prop', 'value',
    );
  });

  it('setAttribute() calls mutate.setAttribute', () => {
    const { backend, mutate } = createMockBackend();
    const bim = createBimContext({ backend });

    bim.mutate.setAttribute({ modelId: 'm', expressId: 1 }, 'Description', 'From CSV');
    expect(mutate.setAttribute).toHaveBeenCalledWith(
      { modelId: 'm', expressId: 1 }, 'Description', 'From CSV',
    );
  });

  it('undo() calls mutate.undo', () => {
    const { backend, mutate } = createMockBackend();
    const bim = createBimContext({ backend });

    bim.mutate.undo('model-1');
    expect(mutate.undo).toHaveBeenCalledWith('model-1');
  });
});

describe('LensNamespace', () => {
  it('presets() returns built-in lenses', () => {
    const { backend } = createMockBackend();
    const bim = createBimContext({ backend });

    const presets = bim.lens.presets();
    expect(Array.isArray(presets)).toBe(true);
  });

  it('create() returns a lens with generated id', () => {
    const { backend } = createMockBackend();
    const bim = createBimContext({ backend });

    const lens = bim.lens.create({
      name: 'Test Lens',
      rules: [],
    });
    expect(lens.id).toBeDefined();
    expect(lens.name).toBe('Test Lens');
  });
});

describe('SpatialNamespace', () => {
  it('queryBounds() calls spatial.queryBounds', () => {
    const { backend, spatial } = createMockBackend();
    spatial.queryBounds.mockReturnValue([
      { modelId: 'm', expressId: 1 },
      { modelId: 'm', expressId: 2 },
    ]);

    const bim = createBimContext({ backend });
    const refs = bim.spatial.queryBounds('m', {
      min: [0, 0, 0],
      max: [10, 10, 10],
    });

    expect(refs).toHaveLength(2);
    expect(spatial.queryBounds).toHaveBeenCalledWith('m', {
      min: [0, 0, 0],
      max: [10, 10, 10],
    });
  });

  it('raycast() calls spatial.raycast', () => {
    const { backend, spatial } = createMockBackend();
    const bim = createBimContext({ backend });

    bim.spatial.raycast('m', [0, 0, 0], [1, 0, 0]);
    expect(spatial.raycast).toHaveBeenCalledWith('m', [0, 0, 0], [1, 0, 0]);
  });

  it('queryRadius() converts to AABB and calls spatial.queryBounds', () => {
    const { backend, spatial } = createMockBackend();
    const bim = createBimContext({ backend });

    bim.spatial.queryRadius('m', [5, 5, 5], 2);
    expect(spatial.queryBounds).toHaveBeenCalledWith('m', {
      min: [3, 3, 3],
      max: [7, 7, 7],
    });
  });
});

describe('IDSNamespace', () => {
  it('summarize() computes correct totals', () => {
    const { backend } = createMockBackend();
    const bim = createBimContext({ backend });

    const report = {
      specificationResults: [
        {
          entityResults: [
            { passed: true },
            { passed: true },
          ],
        },
        {
          entityResults: [
            { passed: true },
            { passed: false },
          ],
        },
      ],
    };

    const summary = bim.ids.summarize(report);
    expect(summary.totalSpecifications).toBe(2);
    expect(summary.passedSpecifications).toBe(1);
    expect(summary.failedSpecifications).toBe(1);
    expect(summary.totalEntities).toBe(4);
    expect(summary.passedEntities).toBe(3);
    expect(summary.failedEntities).toBe(1);
  });
});

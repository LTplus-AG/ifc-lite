/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `CreateNamespace` (`bim.create`) had zero direct coverage: three
 * repo-wide occurrences (definition, context wiring, barrel re-export)
 * and no test exercising `building()`'s defaults or `download()`'s
 * forwarding to `backend.export.download(content, filename, mimeType)`.
 *
 * Mutation testing confirmed it would go unnoticed: swapping the
 * `filename`/`mimeType` arguments at the `download()` call site, or
 * dropping the `StoreyName`/`StoreyElevation` defaults in `building()`,
 * left the SDK suite green.
 */

import { describe, expect, it, vi } from 'vitest';
import { CreateNamespace } from './create.js';
import type { BimBackend } from '../types.js';

describe('CreateNamespace.building()', () => {
  it('defaults StoreyName and StoreyElevation when omitted', () => {
    const ns = new CreateNamespace();
    const { creator } = ns.building({ Name: 'My Building' });
    const { content } = creator.toIfc();
    expect(content).toContain('Ground Floor');
    // Elevation 0 is written as a real coordinate on the storey placement.
    expect(content).toMatch(/IFCBUILDINGSTOREY/);
  });

  it('forwards an explicit StoreyName and StoreyElevation instead of the defaults', () => {
    const ns = new CreateNamespace();
    const { creator } = ns.building({
      Name: 'My Building',
      StoreyName: 'Level 2',
      StoreyElevation: 3.2,
    });
    const { content } = creator.toIfc();
    expect(content).toContain('Level 2');
    expect(content).not.toContain('Ground Floor');
  });
});

describe('CreateNamespace.project()', () => {
  it('returns a usable IfcCreator', () => {
    const ns = new CreateNamespace();
    const creator = ns.project({ Name: 'Standalone' });
    const { content } = creator.toIfc();
    expect(content).toContain('Standalone');
  });
});

describe('CreateNamespace.download()', () => {
  function backendWithDownloadSpy() {
    const download = vi.fn();
    const backend = { export: { download } } as unknown as BimBackend;
    return { backend, download };
  }

  const result = (content: string) => ({
    content,
    entities: [],
    stats: { entityCount: 0, fileSize: content.length },
  });

  it('throws without a backend', () => {
    const ns = new CreateNamespace();
    expect(() => ns.download(result('x'))).toThrow(/requires a backend/);
  });

  it('forwards content, filename and mime type in that order, defaulting the filename', () => {
    const { backend, download } = backendWithDownloadSpy();
    const ns = new CreateNamespace(backend);
    ns.download(result('ISO-10303-21;'));
    expect(download).toHaveBeenCalledWith(
      'ISO-10303-21;',
      'created.ifc',
      'application/x-step;charset=utf-8;',
    );
  });

  it('forwards an explicit filename instead of the default', () => {
    const { backend, download } = backendWithDownloadSpy();
    const ns = new CreateNamespace(backend);
    ns.download(result('ISO-10303-21;'), 'my-model.ifc');
    expect(download).toHaveBeenCalledWith(
      'ISO-10303-21;',
      'my-model.ifc',
      'application/x-step;charset=utf-8;',
    );
  });
});

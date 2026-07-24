/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it, expect } from 'vitest';
import {
  matchesNameFilter,
  matchesSearchNameFilter,
  matchesMimeFilter,
  driveItemToFile,
  driveToContainer,
  driveItemToContainer,
  versionToRevision,
} from '../src/mapping.js';
import { encodeContainerId, decodeContainerId, childrenEndpoint, isOnedriveProject, projectSiteId } from '../src/ids.js';

describe('matchesNameFilter', () => {
  it('passes everything when no filter is given (listFiles/listContainers convention)', () => {
    expect(matchesNameFilter('quarterly-report.docx')).toBe(true);
    expect(matchesNameFilter('model.ifc')).toBe(true);
  });

  it('applies the host-supplied glob patterns when present', () => {
    const filter = { namePatterns: ['*.ifc', '*.ifcx'] };
    expect(matchesNameFilter('model.ifc', filter)).toBe(true);
    expect(matchesNameFilter('model.IFC', filter)).toBe(true);
    expect(matchesNameFilter('report.docx', filter)).toBe(false);
  });
});

describe('matchesSearchNameFilter', () => {
  it('rejects a Graph content-match false positive when no filter is supplied', () => {
    // Graph's search(q='ifc') matches file *content*, so a Word doc whose
    // body happens to mention "ifc" comes back as a hit with an unrelated
    // extension. The default fallback must reject it on name alone.
    expect(matchesSearchNameFilter('meeting-notes-mentions-ifc.docx')).toBe(false);
    expect(matchesSearchNameFilter('structural-model.ifc')).toBe(true);
    expect(matchesSearchNameFilter('federated.ifcx')).toBe(true);
  });

  it('honours an explicit filter over the default', () => {
    expect(matchesSearchNameFilter('drawing.dwg', { namePatterns: ['*.dwg'] })).toBe(true);
    expect(matchesSearchNameFilter('model.ifc', { namePatterns: ['*.dwg'] })).toBe(false);
  });
});

describe('matchesMimeFilter', () => {
  it('never rejects on a missing mimeType — IFC routinely arrives as octet-stream or worse', () => {
    expect(matchesMimeFilter(undefined, { mimeTypes: ['application/octet-stream'] })).toBe(true);
  });

  it('is advisory only when a mimeType is present', () => {
    expect(matchesMimeFilter('application/octet-stream', { mimeTypes: ['application/octet-stream'] })).toBe(true);
    expect(matchesMimeFilter('image/png', { mimeTypes: ['application/octet-stream'] })).toBe(false);
  });
});

describe('composite container ids', () => {
  it('round-trips a drive-root container id', () => {
    expect(decodeContainerId(encodeContainerId('drive-1'))).toEqual({ driveId: 'drive-1' });
  });

  it('round-trips a folder container id', () => {
    expect(decodeContainerId(encodeContainerId('drive-1', 'item-9'))).toEqual({
      driveId: 'drive-1',
      itemId: 'item-9',
    });
  });

  it('derives the correct children endpoint for a drive root vs. a folder', () => {
    expect(childrenEndpoint('drive-1')).toBe('/drives/drive-1/root/children');
    expect(childrenEndpoint(encodeContainerId('drive-1', 'item-9'))).toBe('/drives/drive-1/items/item-9/children');
  });
});

describe('project ids', () => {
  it('distinguishes onedrive vs site projects', () => {
    expect(isOnedriveProject('onedrive:me')).toBe(true);
    expect(isOnedriveProject('site:contoso.sharepoint.com,guid1,guid2')).toBe(false);
    expect(projectSiteId('site:contoso.sharepoint.com,guid1,guid2')).toBe('contoso.sharepoint.com,guid1,guid2');
    expect(projectSiteId('onedrive:me')).toBeUndefined();
  });
});

describe('item mappers', () => {
  it('maps a drive to a container with kind metadata', () => {
    expect(driveToContainer({ id: 'd1', name: 'Documents', driveType: 'documentLibrary' })).toEqual({
      id: 'd1',
      name: 'Documents',
      hasChildren: undefined,
      meta: { kind: 'drive', driveType: 'documentLibrary' },
    });
  });

  it('maps a folder DriveItem to a SourceContainer carrying the composite id', () => {
    const container = driveItemToContainer('d1', 'd1', {
      id: 'f1',
      name: 'Drawings',
      folder: { childCount: 3 },
    });
    expect(container.id).toBe('d1::f1');
    expect(container.parentId).toBe('d1');
    expect(container.hasChildren).toBe(true);
  });

  it('maps a file DriveItem, preferring cTag as the revision identity', () => {
    const file = driveItemToFile('d1::f1', {
      id: 'i1',
      name: 'model.ifc',
      cTag: 'ctag-abc',
      eTag: 'etag-xyz',
      file: { mimeType: 'application/octet-stream' },
      size: 1024,
    });
    expect(file.currentRevisionId).toBe('ctag-abc');
    expect(file.containerId).toBe('d1::f1');
    expect(file.mimeType).toBe('application/octet-stream');
  });

  it('falls back to eTag then the item id when cTag is absent', () => {
    expect(driveItemToFile('d1', { id: 'i2', name: 'a.ifc', eTag: 'e1' }).currentRevisionId).toBe('e1');
    expect(driveItemToFile('d1', { id: 'i3', name: 'b.ifc' }).currentRevisionId).toBe('i3');
  });

  it('keeps SharePoint version labels as opaque strings, never coerced to numbers', () => {
    const revision = versionToRevision({ id: '2.0', lastModifiedDateTime: '2026-01-01T00:00:00Z' });
    expect(revision.id).toBe('2.0');
    expect(typeof revision.id).toBe('string');
    expect(revision.label).toContain('2.0');
  });
});

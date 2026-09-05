/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import type { GeometryDiagnostics } from '@ifc-lite/geometry';
import type { FederatedModel } from '../store/types.js';
import { buildLoadReport, buildLoadReportJSON, buildLoadReports } from './loadReport.js';

/** Base diagnostics with every counter at its "nothing happened" value —
 *  callers override only what the test cares about (issue #3927). */
function diag(overrides: Partial<GeometryDiagnostics> = {}): GeometryDiagnostics {
  return {
    schemaVersion: 3,
    totalCsgFailures: 0,
    productsWithFailures: 0,
    hostsWithOpenings: 0,
    classification: { rectangular: 0, diagonal: 0, nonRectangular: 0, total: 0 },
    failuresByReason: [],
    silentNoOps: 0,
    rectFast: {
      fired: 0,
      openingsCut: 0,
      deferHostNotBox: 0,
      deferNotThrough: 0,
      deferOffFace: 0,
      deferNearEdge: 0,
      deferNoOpenings: 0,
    },
    worstHosts: [],
    ...overrides,
  };
}

/** Minimal FederatedModel — callers override only the fields under test. */
function model(overrides: Partial<FederatedModel> = {}): FederatedModel {
  return {
    id: 'm1',
    name: 'building.ifc',
    ifcDataStore: null,
    geometryResult: null,
    visible: true,
    collapsed: false,
    schemaVersion: 'IFC4',
    loadedAt: 1_700_000_000_000,
    fileSize: 12_345,
    idOffset: 0,
    maxExpressId: 0,
    ...overrides,
  };
}

describe('buildLoadReport', () => {
  it('reports diagnostics as UNAVAILABLE, not clean, when the model never captured them', () => {
    const r = buildLoadReport(model({ diagnostics: undefined }));
    assert.equal(r.diagnosticsAvailable, false);
    assert.equal(r.isClean, false, 'unavailable must not read as clean');
    assert.deepEqual(r.actions, []);
    assert.deepEqual(r.affectedEntities, []);
  });

  it('reports diagnostics as UNAVAILABLE when explicitly null (cache-hit load path)', () => {
    const r = buildLoadReport(model({ diagnostics: null }));
    assert.equal(r.diagnosticsAvailable, false);
    assert.equal(r.isClean, false);
  });

  it('reports a genuinely clean load as clean, not unavailable, when diagnostics are all-zero', () => {
    const r = buildLoadReport(model({ diagnostics: diag() }));
    assert.equal(r.diagnosticsAvailable, true);
    assert.equal(r.isClean, true);
    assert.deepEqual(r.actions, []);
    assert.deepEqual(r.affectedEntities, []);
  });

  it('surfaces a CSG-failure count as an actionable line naming the affected-entities section', () => {
    const r = buildLoadReport(
      model({ diagnostics: diag({ totalCsgFailures: 3, productsWithFailures: 2 }) }),
    );
    assert.equal(r.actions.length, 1);
    assert.match(r.actions[0], /3 CSG failure\(s\) across 2 product\(s\)/);
  });

  it('surfaces silent rect no-ops as their own actionable line', () => {
    const r = buildLoadReport(model({ diagnostics: diag({ silentNoOps: 5 }) }));
    assert.equal(r.actions.length, 1);
    assert.match(r.actions[0], /5 host\(s\) had a rectangular cut attempted/);
  });

  it('surfaces dropped representation items with their per-type breakdown', () => {
    const r = buildLoadReport(
      model({
        diagnostics: diag({
          totalUnsupportedItems: 7,
          unsupportedItemsByType: [{ reason: 'IfcWindow', count: 7 }],
        }),
      }),
    );
    assert.equal(r.actions.length, 1);
    assert.match(r.actions[0], /7 representation item\(s\) were dropped/);
    assert.match(r.actions[0], /7 IfcWindow/);
  });

  it('surfaces oversized-ref drops as their own actionable line', () => {
    const r = buildLoadReport(model({ diagnostics: diag({ oversizedRefDrops: 4 }) }));
    assert.equal(r.actions.length, 1);
    assert.match(r.actions[0], /4 content-hash reference\(s\) were skipped/);
  });

  it('reports every category at once when several are nonzero (categories do not suppress each other)', () => {
    const r = buildLoadReport(
      model({
        diagnostics: diag({
          totalCsgFailures: 1,
          productsWithFailures: 1,
          silentNoOps: 1,
          totalUnsupportedItems: 1,
          unsupportedItemsByType: [{ reason: 'IfcDoor', count: 1 }],
          oversizedRefDrops: 1,
        }),
      }),
    );
    assert.equal(r.actions.length, 4);
  });

  it('notes fast-mode small-cut skipping as an approximation-setting action, independent of diagnostics', () => {
    const r = buildLoadReport(model({ diagnostics: diag(), skipSmallCuts: true }));
    assert.equal(r.actions.length, 1);
    assert.match(r.actions[0], /fast geometry mode/);
    assert.equal(r.isClean, false, 'an approximation warning means the report is not quiet');
  });

  it('notes the lowest tessellation tier as an approximation-setting action', () => {
    const r = buildLoadReport(model({ diagnostics: diag(), tessellationTier: 'lowest' }));
    assert.equal(r.actions.length, 1);
    assert.match(r.actions[0], /lowest tessellation tier/);
  });

  it('promotes worstHosts to affected entities with a resolved globalId (productId + idOffset)', () => {
    const r = buildLoadReport(
      model({
        idOffset: 1000,
        diagnostics: diag({
          worstHosts: [{ productId: 42, ifcType: 'IfcWall', openings: 2, csgFailures: 1 }],
        }),
      }),
    );
    assert.equal(r.affectedEntities.length, 1);
    assert.equal(r.affectedEntities[0].productId, 42);
    assert.equal(r.affectedEntities[0].globalId, 1042);
    assert.equal(r.affectedEntities[0].ifcType, 'IfcWall');
  });

  it('marks a worst-host renderable only when a bbox was captured', () => {
    const r = buildLoadReport(
      model({
        diagnostics: diag({
          worstHosts: [
            { productId: 1, ifcType: 'IfcWall', openings: 1, csgFailures: 1, bbox: { min: [0, 0, 0], max: [1, 1, 1] } },
            { productId: 2, ifcType: 'IfcWall', openings: 1, csgFailures: 1 },
          ],
        }),
      }),
    );
    assert.equal(r.affectedEntities[0].renderable, true);
    assert.equal(r.affectedEntities[1].renderable, false);
  });

  it('never invents an affected entity from unsupportedItemsByType (no identity in the contract)', () => {
    const r = buildLoadReport(
      model({
        diagnostics: diag({
          totalUnsupportedItems: 9,
          unsupportedItemsByType: [{ reason: 'IfcWindow', count: 9 }],
        }),
      }),
    );
    assert.deepEqual(r.affectedEntities, []);
  });
});

describe('buildLoadReports', () => {
  it('builds one report per model, in map order', () => {
    const models = new Map([
      ['a', model({ id: 'a', name: 'a.ifc' })],
      ['b', model({ id: 'b', name: 'b.ifc', diagnostics: diag({ totalCsgFailures: 1, productsWithFailures: 1 }) })],
    ]);
    const reports = buildLoadReports(models);
    assert.equal(reports.length, 2);
    assert.equal(reports[0].modelId, 'a');
    assert.equal(reports[1].modelId, 'b');
  });
});

describe('buildLoadReportJSON', () => {
  it('serializes every report field, including unavailable diagnostics as null (not omitted)', () => {
    const r = buildLoadReport(model({ diagnostics: undefined }));
    const json = buildLoadReportJSON([r]);
    const models = json.models as Array<Record<string, unknown>>;
    assert.equal(models.length, 1);
    assert.equal(models[0].diagnosticsAvailable, false);
    assert.equal(models[0].diagnostics, null);
    assert.ok(typeof json.generatedAt === 'string');
  });
});

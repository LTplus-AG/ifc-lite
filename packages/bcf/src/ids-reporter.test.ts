/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it, expect } from 'vitest';
import { createBCFFromIDSReport } from './ids-reporter.js';
import type { IDSReportInput, EntityBoundsInput } from './ids-reporter.js';

// ============================================================================
// Test fixtures
// ============================================================================

function createMockReport(overrides?: Partial<IDSReportInput>): IDSReportInput {
  return {
    title: 'Test IDS Report',
    description: 'Test description',
    specificationResults: [
      {
        specification: {
          name: 'Wall Fire Rating',
          description: 'All walls must have fire rating',
        },
        status: 'fail',
        applicableCount: 3,
        passedCount: 1,
        failedCount: 2,
        entityResults: [
          {
            expressId: 100,
            modelId: 'model-1',
            entityType: 'IfcWall',
            entityName: 'Basic Wall:Generic - 200mm',
            globalId: '2O2Fr$t4X7Zf8NOew3FL01',
            passed: false,
            requirementResults: [
              {
                status: 'fail',
                facetType: 'property',
                checkedDescription: 'Property FireRating must exist in Pset_WallCommon',
                failureReason: 'Property set Pset_WallCommon not found',
                actualValue: undefined,
                expectedValue: 'Pset_WallCommon.FireRating',
              },
              {
                status: 'fail',
                facetType: 'attribute',
                checkedDescription: 'Description must be provided',
                failureReason: 'Attribute Description is missing',
                actualValue: undefined,
                expectedValue: 'any value',
              },
            ],
          },
          {
            expressId: 200,
            modelId: 'model-1',
            entityType: 'IfcWall',
            entityName: 'Curtain Wall:Standard',
            globalId: '3P3Gs$u5Y8Ag9OPfx4GM02',
            passed: false,
            requirementResults: [
              {
                status: 'fail',
                facetType: 'property',
                checkedDescription: 'Property FireRating must exist in Pset_WallCommon',
                failureReason: 'Property FireRating not found',
                actualValue: undefined,
                expectedValue: 'Pset_WallCommon.FireRating',
              },
            ],
          },
          {
            expressId: 300,
            modelId: 'model-1',
            entityType: 'IfcWall',
            entityName: 'Fire Wall:REI120',
            globalId: '1A1Br$s3W6Ye7MPex2EK03',
            passed: true,
            requirementResults: [
              {
                status: 'pass',
                facetType: 'property',
                checkedDescription: 'Property FireRating must exist in Pset_WallCommon',
              },
            ],
          },
        ],
      },
    ],
    ...overrides,
  };
}

function createPassingReport(): IDSReportInput {
  return {
    title: 'Passing IDS Report',
    specificationResults: [
      {
        specification: { name: 'Naming Convention' },
        status: 'pass',
        applicableCount: 2,
        passedCount: 2,
        failedCount: 0,
        entityResults: [
          {
            expressId: 10,
            modelId: 'model-1',
            entityType: 'IfcDoor',
            entityName: 'Door A',
            globalId: 'GUID_DOOR_A_00000000001',
            passed: true,
            requirementResults: [
              { status: 'pass', facetType: 'attribute', checkedDescription: 'Name must exist' },
            ],
          },
        ],
      },
    ],
  };
}

// ============================================================================
// Tests
// ============================================================================

describe('IDS BCF Reporter', () => {
  describe('createBCFFromIDSReport', () => {
    it('should create a BCF project with correct metadata', () => {
      const report = createMockReport();
      const project = createBCFFromIDSReport(report);

      expect(project.version).toBe('2.1');
      expect(project.name).toBe('Test IDS Report');
      expect(project.projectId).toBeTruthy();
    });

    it('should allow custom project name and version', () => {
      const report = createMockReport();
      const project = createBCFFromIDSReport(report, {
        projectName: 'Custom Project',
        version: '3.0',
      });

      expect(project.version).toBe('3.0');
      expect(project.name).toBe('Custom Project');
    });
  });

  // ==========================================================================
  // Per-entity grouping (default)
  // ==========================================================================

  describe('per-entity grouping (default)', () => {
    it('should create one topic per failing entity', () => {
      const report = createMockReport();
      const project = createBCFFromIDSReport(report);

      expect(project.topics.size).toBe(2); // 2 failing entities
    });

    it('should not include passing entities by default', () => {
      const report = createMockReport();
      const project = createBCFFromIDSReport(report);

      const titles = [...project.topics.values()].map(t => t.title);
      expect(titles).not.toContain(expect.stringContaining('Fire Wall'));
    });

    it('should include passing entities when option is set', () => {
      const report = createMockReport();
      const project = createBCFFromIDSReport(report, { includePassingEntities: true });

      expect(project.topics.size).toBe(3); // 2 failing + 1 passing
    });

    it('should set correct topic title as EntityType: EntityName', () => {
      const report = createMockReport();
      const project = createBCFFromIDSReport(report);

      const topics = [...project.topics.values()];
      expect(topics[0].title).toBe('IfcWall: Basic Wall:Generic - 200mm');
      expect(topics[1].title).toBe('IfcWall: Curtain Wall:Standard');
    });

    it('should fall back to expressId when entity has no name', () => {
      const report = createMockReport();
      report.specificationResults[0].entityResults[0].entityName = undefined;
      const project = createBCFFromIDSReport(report);

      const topic = [...project.topics.values()][0];
      expect(topic.title).toBe('IfcWall: #100');
    });

    it('should set topic description with spec info and failure count', () => {
      const report = createMockReport();
      const project = createBCFFromIDSReport(report);

      const topic = [...project.topics.values()][0];
      expect(topic.description).toContain('2 of 2 requirements failed');
      expect(topic.description).toContain('Wall Fire Rating');
      expect(topic.description).toContain('IfcWall');
      expect(topic.description).toContain('2O2Fr$t4X7Zf8NOew3FL01');
    });

    it('should set topic type to Error for failures', () => {
      const report = createMockReport();
      const project = createBCFFromIDSReport(report);

      const topic = [...project.topics.values()][0];
      expect(topic.topicType).toBe('Error');
      expect(topic.topicStatus).toBe('Open');
    });

    it('should set High priority when all requirements fail', () => {
      const report = createMockReport();
      const project = createBCFFromIDSReport(report);

      const topics = [...project.topics.values()];
      // Entity with 2/2 failures = High
      expect(topics[0].priority).toBe('High');
      // Entity with 1/1 failure = High
      expect(topics[1].priority).toBe('High');
    });

    it('should set Medium priority when some requirements pass', () => {
      const report = createMockReport();
      // Modify entity to have 1 pass + 1 fail (mixed)
      report.specificationResults[0].entityResults[0].requirementResults = [
        {
          status: 'fail',
          facetType: 'property',
          checkedDescription: 'Must have fire rating',
          failureReason: 'Missing property',
        },
        {
          status: 'pass',
          facetType: 'attribute',
          checkedDescription: 'Name must exist',
        },
      ];
      const project = createBCFFromIDSReport(report);

      const topic = [...project.topics.values()][0];
      expect(topic.priority).toBe('Medium');
    });

    it('should set labels with IDS and spec name', () => {
      const report = createMockReport();
      const project = createBCFFromIDSReport(report);

      const topic = [...project.topics.values()][0];
      expect(topic.labels).toEqual(['IDS', 'Wall Fire Rating']);
    });

    it('should create one comment per failed requirement', () => {
      const report = createMockReport();
      const project = createBCFFromIDSReport(report);

      const topics = [...project.topics.values()];
      // First entity has 2 failed requirements
      expect(topics[0].comments.length).toBe(2);
      // Second entity has 1 failed requirement
      expect(topics[1].comments.length).toBe(1);
    });

    it('should include failure details in comments', () => {
      const report = createMockReport();
      const project = createBCFFromIDSReport(report);

      const comment = [...project.topics.values()][0].comments[0];
      expect(comment.comment).toContain('[property]');
      expect(comment.comment).toContain('Property FireRating must exist in Pset_WallCommon');
      expect(comment.comment).toContain('Property set Pset_WallCommon not found');
      expect(comment.comment).toContain('Expected: Pset_WallCommon.FireRating');
    });

    it('should use custom author', () => {
      const report = createMockReport();
      const project = createBCFFromIDSReport(report, { author: 'tester@example.com' });

      const topic = [...project.topics.values()][0];
      expect(topic.creationAuthor).toBe('tester@example.com');
      expect(topic.comments[0].author).toBe('tester@example.com');
    });

    it('should link comments to viewpoint via viewpointGuid', () => {
      const report = createMockReport();
      const project = createBCFFromIDSReport(report);

      const topic = [...project.topics.values()][0];
      expect(topic.viewpoints.length).toBe(1);
      expect(topic.comments.length).toBe(2);

      const vpGuid = topic.viewpoints[0].guid;
      // Every comment should reference the viewpoint
      for (const comment of topic.comments) {
        expect(comment.viewpointGuid).toBe(vpGuid);
      }
    });

    it('should not set viewpointGuid when entity has no globalId (no viewpoint created)', () => {
      const report = createMockReport();
      report.specificationResults[0].entityResults[0].globalId = undefined;
      const project = createBCFFromIDSReport(report);

      const topic = [...project.topics.values()][0];
      expect(topic.viewpoints.length).toBe(0);
      // Comments should have no viewpointGuid
      for (const comment of topic.comments) {
        expect(comment.viewpointGuid).toBeUndefined();
      }
    });
  });

  // ==========================================================================
  // Viewpoints
  // ==========================================================================

  describe('viewpoints', () => {
    it('should create viewpoint with entity selected', () => {
      const report = createMockReport();
      const project = createBCFFromIDSReport(report);

      const topic = [...project.topics.values()][0];
      expect(topic.viewpoints.length).toBe(1);

      const vp = topic.viewpoints[0];
      expect(vp.components?.selection).toHaveLength(1);
      expect(vp.components?.selection?.[0].ifcGuid).toBe('2O2Fr$t4X7Zf8NOew3FL01');
    });

    it('should isolate entity (defaultVisibility=false)', () => {
      const report = createMockReport();
      const project = createBCFFromIDSReport(report);

      const vp = [...project.topics.values()][0].viewpoints[0];
      expect(vp.components?.visibility?.defaultVisibility).toBe(false);
      expect(vp.components?.visibility?.exceptions).toHaveLength(1);
      expect(vp.components?.visibility?.exceptions?.[0].ifcGuid).toBe('2O2Fr$t4X7Zf8NOew3FL01');
    });

    it('should color failing entity red', () => {
      const report = createMockReport();
      const project = createBCFFromIDSReport(report);

      const vp = [...project.topics.values()][0].viewpoints[0];
      expect(vp.components?.coloring).toHaveLength(1);
      expect(vp.components?.coloring?.[0].color).toBe('FFFF3333');
      expect(vp.components?.coloring?.[0].components[0].ifcGuid).toBe('2O2Fr$t4X7Zf8NOew3FL01');
    });

    it('should use custom failure color', () => {
      const report = createMockReport();
      const project = createBCFFromIDSReport(report, { failureColor: 'FF0000FF' });

      const vp = [...project.topics.values()][0].viewpoints[0];
      expect(vp.components?.coloring?.[0].color).toBe('FF0000FF');
    });

    it('should not have camera set (viewer should zoom-to-fit)', () => {
      const report = createMockReport();
      const project = createBCFFromIDSReport(report);

      const vp = [...project.topics.values()][0].viewpoints[0];
      expect(vp.perspectiveCamera).toBeUndefined();
      expect(vp.orthogonalCamera).toBeUndefined();
    });
  });

  // ==========================================================================
  // Per-specification grouping
  // ==========================================================================

  describe('per-specification grouping', () => {
    it('should create one topic per failing specification', () => {
      const report = createMockReport();
      const project = createBCFFromIDSReport(report, { topicGrouping: 'per-specification' });

      expect(project.topics.size).toBe(1); // 1 failing spec
    });

    it('should title topic with spec name', () => {
      const report = createMockReport();
      const project = createBCFFromIDSReport(report, { topicGrouping: 'per-specification' });

      const topic = [...project.topics.values()][0];
      expect(topic.title).toBe('[FAIL] Wall Fire Rating');
    });

    it('should include failing entity count in description', () => {
      const report = createMockReport();
      const project = createBCFFromIDSReport(report, { topicGrouping: 'per-specification' });

      const topic = [...project.topics.values()][0];
      expect(topic.description).toContain('2 of 3 entities failed');
    });

    it('should add comments for each failing entity', () => {
      const report = createMockReport();
      const project = createBCFFromIDSReport(report, { topicGrouping: 'per-specification' });

      const topic = [...project.topics.values()][0];
      expect(topic.comments.length).toBe(2); // 2 failing entities
    });

    it('should select all failing entities in viewpoint', () => {
      const report = createMockReport();
      const project = createBCFFromIDSReport(report, { topicGrouping: 'per-specification' });

      const vp = [...project.topics.values()][0].viewpoints[0];
      expect(vp.components?.selection).toHaveLength(2);
    });

    it('should link entity comments to viewpoint', () => {
      const report = createMockReport();
      const project = createBCFFromIDSReport(report, { topicGrouping: 'per-specification' });

      const topic = [...project.topics.values()][0];
      const vpGuid = topic.viewpoints[0].guid;
      // Entity failure comments should reference the viewpoint
      for (const comment of topic.comments) {
        expect(comment.viewpointGuid).toBe(vpGuid);
      }
    });

    it('should skip passing specifications', () => {
      const report = createPassingReport();
      const project = createBCFFromIDSReport(report, { topicGrouping: 'per-specification' });

      expect(project.topics.size).toBe(0);
    });
  });

  // ==========================================================================
  // Per-requirement grouping
  // ==========================================================================

  describe('per-requirement grouping', () => {
    it('should create one topic per (spec, entity, requirement) failure', () => {
      const report = createMockReport();
      const project = createBCFFromIDSReport(report, { topicGrouping: 'per-requirement' });

      // Entity 1 has 2 failures, Entity 2 has 1 failure = 3 topics
      expect(project.topics.size).toBe(3);
    });

    it('should include failure reason in title', () => {
      const report = createMockReport();
      const project = createBCFFromIDSReport(report, { topicGrouping: 'per-requirement' });

      const topics = [...project.topics.values()];
      expect(topics[0].title).toContain('Property set Pset_WallCommon not found');
    });

    it('should include spec name in description', () => {
      const report = createMockReport();
      const project = createBCFFromIDSReport(report, { topicGrouping: 'per-requirement' });

      const topic = [...project.topics.values()][0];
      expect(topic.description).toContain('Wall Fire Rating');
    });

    it('should link comment to viewpoint', () => {
      const report = createMockReport();
      const project = createBCFFromIDSReport(report, { topicGrouping: 'per-requirement' });

      const topic = [...project.topics.values()][0];
      expect(topic.viewpoints.length).toBe(1);
      expect(topic.comments.length).toBe(1);
      expect(topic.comments[0].viewpointGuid).toBe(topic.viewpoints[0].guid);
    });
  });

  // ==========================================================================
  // Safety caps and edge cases
  // ==========================================================================

  describe('safety and edge cases', () => {
    it('should respect maxTopics limit', () => {
      const report = createMockReport();
      const project = createBCFFromIDSReport(report, { maxTopics: 1 });

      expect(project.topics.size).toBe(1);
    });

    it('should handle empty report', () => {
      const report: IDSReportInput = {
        title: 'Empty',
        specificationResults: [],
      };
      const project = createBCFFromIDSReport(report);

      expect(project.topics.size).toBe(0);
    });

    it('should handle all passing results with default options', () => {
      const report = createPassingReport();
      const project = createBCFFromIDSReport(report);

      expect(project.topics.size).toBe(0); // No failing entities
    });

    it('should handle not_applicable specifications', () => {
      const report: IDSReportInput = {
        title: 'N/A Report',
        specificationResults: [
          {
            specification: { name: 'IFC2X3 Only' },
            status: 'not_applicable',
            applicableCount: 0,
            passedCount: 0,
            failedCount: 0,
            entityResults: [],
          },
        ],
      };
      const project = createBCFFromIDSReport(report);

      expect(project.topics.size).toBe(0);
    });

    it('should generate unique GUIDs for all topics', () => {
      const report = createMockReport();
      const project = createBCFFromIDSReport(report);

      const guids = [...project.topics.keys()];
      expect(new Set(guids).size).toBe(guids.length);
    });

    it('should generate unique GUIDs for all viewpoints', () => {
      const report = createMockReport();
      const project = createBCFFromIDSReport(report);

      const vpGuids = [...project.topics.values()]
        .flatMap(t => t.viewpoints)
        .map(vp => vp.guid);
      expect(new Set(vpGuids).size).toBe(vpGuids.length);
    });
  });

  // ==========================================================================
  // Camera computation from entity bounds
  // ==========================================================================

  describe('per-entity camera from bounds', () => {
    function createBoundsMap(): Map<string, EntityBoundsInput> {
      const map = new Map<string, EntityBoundsInput>();
      map.set('model-1:100', {
        min: { x: 0, y: 0, z: 0 },
        max: { x: 2, y: 3, z: 1 },
      });
      map.set('model-1:200', {
        min: { x: 5, y: 0, z: 5 },
        max: { x: 7, y: 4, z: 7 },
      });
      return map;
    }

    it('should include perspective camera when entityBounds provided', () => {
      const report = createMockReport();
      const project = createBCFFromIDSReport(report, {
        entityBounds: createBoundsMap(),
      });

      const vp = [...project.topics.values()][0].viewpoints[0];
      expect(vp.perspectiveCamera).toBeDefined();
      expect(vp.perspectiveCamera!.fieldOfView).toBe(60);
    });

    it('should not include camera when entityBounds not provided', () => {
      const report = createMockReport();
      const project = createBCFFromIDSReport(report);

      const vp = [...project.topics.values()][0].viewpoints[0];
      expect(vp.perspectiveCamera).toBeUndefined();
    });

    it('should compute camera in BCF Z-up coordinates', () => {
      const report = createMockReport();
      const project = createBCFFromIDSReport(report, {
        entityBounds: createBoundsMap(),
      });

      const cam = [...project.topics.values()][0].viewpoints[0].perspectiveCamera!;
      // BCF up vector should be Z-up
      expect(cam.cameraUpVector.z).toBe(1);
      expect(cam.cameraUpVector.x).toBe(0);
      expect(cam.cameraUpVector.y).toBe(0);
    });

    it('should point camera toward entity center', () => {
      const report = createMockReport();
      const bounds = new Map<string, EntityBoundsInput>();
      bounds.set('model-1:100', {
        min: { x: 0, y: 0, z: 0 },
        max: { x: 2, y: 2, z: 2 },
      });
      const project = createBCFFromIDSReport(report, { entityBounds: bounds });

      const cam = [...project.topics.values()][0].viewpoints[0].perspectiveCamera!;
      // Camera direction vector should have non-zero components
      const dirLen = Math.sqrt(
        cam.cameraDirection.x ** 2 +
        cam.cameraDirection.y ** 2 +
        cam.cameraDirection.z ** 2,
      );
      // Should be unit vector (approximately 1)
      expect(dirLen).toBeCloseTo(1, 3);
    });

    it('should position camera away from entity center', () => {
      const report = createMockReport();
      const bounds = new Map<string, EntityBoundsInput>();
      bounds.set('model-1:100', {
        min: { x: 0, y: 0, z: 0 },
        max: { x: 2, y: 2, z: 2 },
      });
      const project = createBCFFromIDSReport(report, { entityBounds: bounds });

      const cam = [...project.topics.values()][0].viewpoints[0].perspectiveCamera!;
      // Camera should be displaced from entity center (BCF center would be at x=1, y=-1, z=1)
      const distFromCenter = Math.sqrt(
        (cam.cameraViewPoint.x - 1) ** 2 +
        (cam.cameraViewPoint.y - (-1)) ** 2 +
        (cam.cameraViewPoint.z - 1) ** 2,
      );
      // Should be significantly away from center (distance > entity max size)
      expect(distFromCenter).toBeGreaterThan(2);
    });

    it('should skip camera for entities without bounds', () => {
      const report = createMockReport();
      const bounds = new Map<string, EntityBoundsInput>();
      // Only provide bounds for entity 100, not 200
      bounds.set('model-1:100', {
        min: { x: 0, y: 0, z: 0 },
        max: { x: 2, y: 2, z: 2 },
      });
      const project = createBCFFromIDSReport(report, { entityBounds: bounds });

      const topics = [...project.topics.values()];
      expect(topics[0].viewpoints[0].perspectiveCamera).toBeDefined();
      expect(topics[1].viewpoints[0].perspectiveCamera).toBeUndefined();
    });
  });

  // ==========================================================================
  // Snapshot support
  // ==========================================================================

  describe('snapshot support', () => {
    it('should attach snapshots when entitySnapshots provided', () => {
      const report = createMockReport();
      const snapshots = new Map<string, string>();
      snapshots.set('model-1:100', 'data:image/png;base64,iVBOR...');

      const project = createBCFFromIDSReport(report, { entitySnapshots: snapshots });

      const vp = [...project.topics.values()][0].viewpoints[0];
      expect(vp.snapshot).toBe('data:image/png;base64,iVBOR...');
    });

    it('should not attach snapshot for entities without one', () => {
      const report = createMockReport();
      const snapshots = new Map<string, string>();
      // Only snapshot for entity 100
      snapshots.set('model-1:100', 'data:image/png;base64,AAAA');

      const project = createBCFFromIDSReport(report, { entitySnapshots: snapshots });

      const topics = [...project.topics.values()];
      expect(topics[0].viewpoints[0].snapshot).toBe('data:image/png;base64,AAAA');
      expect(topics[1].viewpoints[0].snapshot).toBeUndefined();
    });

    it('should support both bounds and snapshots together', () => {
      const report = createMockReport();
      const bounds = new Map<string, EntityBoundsInput>();
      bounds.set('model-1:100', { min: { x: 0, y: 0, z: 0 }, max: { x: 1, y: 1, z: 1 } });

      const snapshots = new Map<string, string>();
      snapshots.set('model-1:100', 'data:image/png;base64,BBBB');

      const project = createBCFFromIDSReport(report, { entityBounds: bounds, entitySnapshots: snapshots });

      const vp = [...project.topics.values()][0].viewpoints[0];
      expect(vp.perspectiveCamera).toBeDefined();
      expect(vp.snapshot).toBe('data:image/png;base64,BBBB');
    });
  });
});

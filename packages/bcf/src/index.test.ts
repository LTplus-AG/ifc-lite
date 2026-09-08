/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it, expect } from 'vitest';
import {
  parseARGBColor,
  toARGBColor,
  createBCFProject,
  createBCFTopic,
  createBCFComment,
  addTopicToProject,
  addCommentToTopic,
  addViewpointToTopic,
  updateTopicStatus,
} from './index.js';

/**
 * BCF colours are ARGB — alpha FIRST — which is the opposite of the RGBA order
 * most web code uses. Nothing pinned the channel order, so a swapped pair (or a
 * transposed 6-digit fallback) produced a perfectly valid-looking hex string
 * that painted the wrong colour in the receiving tool.
 */
describe('ARGB colour helpers', () => {
  describe('parseARGBColor', () => {
    it('reads the 8-digit form as alpha, red, green, blue in that order', () => {
      expect(parseARGBColor('80112233')).toEqual({ a: 0x80, r: 0x11, g: 0x22, b: 0x33 });
      // Opaque red, the canonical BCF example.
      expect(parseARGBColor('FFFF0000')).toEqual({ a: 255, r: 255, g: 0, b: 0 });
    });

    it('treats the 6-digit form as opaque RGB', () => {
      // Distinct channel values so a transposition cannot pass by symmetry.
      expect(parseARGBColor('112233')).toEqual({ a: 255, r: 0x11, g: 0x22, b: 0x33 });
    });

    it('tolerates a leading # in either length', () => {
      expect(parseARGBColor('#112233')).toEqual({ a: 255, r: 0x11, g: 0x22, b: 0x33 });
      expect(parseARGBColor('#80112233')).toEqual({ a: 0x80, r: 0x11, g: 0x22, b: 0x33 });
    });
  });

  describe('toARGBColor', () => {
    it('emits alpha first, uppercase, zero-padded', () => {
      expect(toARGBColor(0x11, 0x22, 0x33, 0x44)).toBe('44112233');
      // Alpha defaults to fully opaque.
      expect(toARGBColor(255, 0, 0)).toBe('FFFF0000');
      // Single-digit nibbles must be padded, not truncated.
      expect(toARGBColor(1, 2, 3, 4)).toBe('04010203');
    });

    it('clamps and rounds out-of-range channels instead of emitting garbage hex', () => {
      expect(toARGBColor(-5, 300, 10.6, 255)).toBe('FF00FF0B');
    });

    it('round-trips through parseARGBColor', () => {
      for (const [r, g, b, a] of [[0, 0, 0, 0], [255, 255, 255, 255], [1, 128, 254, 7]] as const) {
        expect(parseARGBColor(toARGBColor(r, g, b, a))).toEqual({ r, g, b, a });
      }
    });
  });
});

describe('project/topic convenience helpers', () => {
  it('defaults a new project to BCF 2.1 with a generated project id', () => {
    const p = createBCFProject();
    expect(p.version).toBe('2.1');
    expect(p.projectId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-/i);
    expect(p.topics.size).toBe(0);
    expect(p.name).toBeUndefined();

    expect(createBCFProject({ version: '3.0', name: 'N' })).toMatchObject({ version: '3.0', name: 'N' });
  });

  it('defaults a new topic to an open Issue and keeps explicit overrides', () => {
    const t = createBCFTopic({ title: 'T', author: 'a@example.com' });
    expect(t.topicType).toBe('Issue');
    expect(t.topicStatus).toBe('Open');
    expect(t.creationAuthor).toBe('a@example.com');
    expect(t.comments).toEqual([]);
    expect(t.viewpoints).toEqual([]);

    const custom = createBCFTopic({
      title: 'T',
      author: 'a@example.com',
      topicType: 'Clash',
      topicStatus: 'Closed',
    });
    expect(custom.topicType).toBe('Clash');
    expect(custom.topicStatus).toBe('Closed');
  });

  it('keys a topic in the project map by its own GUID', () => {
    const project = createBCFProject();
    const topic = createBCFTopic({ title: 'T', author: 'a@example.com' });
    addTopicToProject(project, topic);
    expect(project.topics.get(topic.guid)).toBe(topic);
  });

  it('stamps modifiedDate when a comment, viewpoint or status change lands', () => {
    const topic = createBCFTopic({ title: 'T', author: 'a@example.com' });
    expect(topic.modifiedDate).toBeUndefined();

    addCommentToTopic(topic, createBCFComment({ author: 'b@example.com', comment: 'hi' }));
    expect(topic.comments).toHaveLength(1);
    expect(topic.modifiedDate).toBeDefined();

    topic.modifiedDate = undefined;
    addViewpointToTopic(topic, { guid: 'vp-1' });
    expect(topic.viewpoints).toHaveLength(1);
    expect(topic.modifiedDate).toBeDefined();

    topic.modifiedDate = undefined;
    updateTopicStatus(topic, 'Closed', 'c@example.com');
    expect(topic.topicStatus).toBe('Closed');
    expect(topic.modifiedAuthor).toBe('c@example.com');
    expect(topic.modifiedDate).toBeDefined();
  });
});

/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it, expect } from 'vitest';
import {
  parseXml,
  childByName,
  childrenByName,
  textChild,
} from './xml-mini.js';

describe('parseXml', () => {
  it('parses a flat element with attrs + text', () => {
    const root = parseXml(`<root type="Structure">hello</root>`);
    expect(root.name).toBe('root');
    expect(root.attrs.get('type')).toBe('Structure');
    expect(root.text).toBe('hello');
    expect(root.children).toEqual([]);
  });

  it('parses nested elements with attrs', () => {
    const root = parseXml(
      `<a><b type="X"/><c type="Y" id="1">text</c></a>`,
    );
    expect(root.name).toBe('a');
    expect(root.children).toHaveLength(2);
    expect(root.children[0].name).toBe('b');
    expect(root.children[0].attrs.get('type')).toBe('X');
    expect(root.children[0].children).toEqual([]);
    expect(root.children[1].name).toBe('c');
    expect(root.children[1].attrs.get('type')).toBe('Y');
    expect(root.children[1].attrs.get('id')).toBe('1');
    expect(root.children[1].text).toBe('text');
  });

  it('skips XML declaration, comments, DOCTYPE', () => {
    const root = parseXml(
      `<?xml version="1.0" encoding="UTF-8"?>\n` +
      `<!-- some comment -->\n` +
      `<!DOCTYPE root>\n` +
      `<root>ok</root>`,
    );
    expect(root.name).toBe('root');
    expect(root.text).toBe('ok');
  });

  it('decodes XML entities in attributes and text', () => {
    const root = parseXml(`<r note="a&amp;b&lt;c">a&amp;b</r>`);
    expect(root.attrs.get('note')).toBe('a&b<c');
    expect(root.text).toBe('a&b');
  });

  it('rejects mismatched closing tags', () => {
    expect(() => parseXml(`<a><b></c></a>`)).toThrow();
  });

  it('handles self-closing tags inside parents', () => {
    const root = parseXml(`<root><a/><b/><c/></root>`);
    expect(root.children.map((c) => c.name)).toEqual(['a', 'b', 'c']);
  });

  it('preserves attribute values that contain ">"', () => {
    const root = parseXml(`<x note="3 > 2"/>`);
    expect(root.attrs.get('note')).toBe('3 > 2');
  });
});

describe('tree helpers', () => {
  const xml = `
    <root>
      <data3D>
        <vectorChild>
          <guid>scan-1</guid>
          <points type="CompressedVector" fileOffset="1024" recordCount="100">
            <prototype>
              <cartesianX type="Float" precision="double"/>
              <cartesianY type="Float" precision="double"/>
              <cartesianZ type="Float" precision="double"/>
              <colorRed type="Integer" minimum="0" maximum="255"/>
            </prototype>
          </points>
        </vectorChild>
        <vectorChild>
          <guid>scan-2</guid>
        </vectorChild>
      </data3D>
    </root>
  `;

  it('walks E57-shaped XML', () => {
    const root = parseXml(xml);
    const data3D = childByName(root, 'data3D')!;
    expect(data3D).toBeTruthy();
    const scans = childrenByName(data3D, 'vectorChild');
    expect(scans).toHaveLength(2);

    const scan1 = scans[0];
    expect(textChild(scan1, 'guid')).toBe('scan-1');
    const points = childByName(scan1, 'points')!;
    expect(points.attrs.get('type')).toBe('CompressedVector');
    expect(points.attrs.get('fileOffset')).toBe('1024');
    expect(points.attrs.get('recordCount')).toBe('100');

    const proto = childByName(points, 'prototype')!;
    expect(proto.children).toHaveLength(4);
    expect(proto.children[0].name).toBe('cartesianX');
    expect(proto.children[0].attrs.get('precision')).toBe('double');
    expect(proto.children[3].name).toBe('colorRed');
    expect(proto.children[3].attrs.get('maximum')).toBe('255');
  });
});

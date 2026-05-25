/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';
import { validateWidget } from './schema.js';

describe('validateWidget — happy', () => {
  it('accepts a single text node', () => {
    const r = validateWidget({ type: 'Text', text: 'hi' });
    expect(r.ok).toBe(true);
  });

  it('accepts a stack with children', () => {
    const r = validateWidget({
      type: 'Stack',
      direction: 'vertical',
      children: [
        { type: 'Text', text: 'header', variant: 'heading' },
        { type: 'Button', label: 'Go', command: 'ext.foo.go' },
      ],
    });
    expect(r.ok).toBe(true);
  });

  it('accepts a full form-like layout', () => {
    const r = validateWidget({
      type: 'Stack',
      direction: 'vertical',
      children: [
        { type: 'Field', variant: 'text', label: 'Name', binding: 'name' },
        { type: 'Field', variant: 'boolean', label: 'Enabled', binding: 'enabled' },
        { type: 'Button', label: 'Save', command: 'ext.foo.save', variant: 'primary' },
      ],
    });
    expect(r.ok).toBe(true);
  });

  it('accepts tabs', () => {
    const r = validateWidget({
      type: 'Tabs',
      tabs: [
        { id: 'a', label: 'A', children: [{ type: 'Text', text: 'a' }] },
        { id: 'b', label: 'B', children: [{ type: 'Text', text: 'b' }] },
      ],
    });
    expect(r.ok).toBe(true);
  });
});

describe('validateWidget — errors', () => {
  it('rejects unknown node type', () => {
    const r = validateWidget({ type: 'MadeUp' });
    expect(r.ok).toBe(false);
  });

  it('rejects stack with non-array children', () => {
    const r = validateWidget({ type: 'Stack', direction: 'vertical', children: 'oops' });
    expect(r.ok).toBe(false);
  });

  it('rejects field with unknown variant', () => {
    const r = validateWidget({ type: 'Field', variant: 'date', label: 'X', binding: 'x' });
    expect(r.ok).toBe(false);
  });

  it('rejects button without command', () => {
    const r = validateWidget({ type: 'Button', label: 'X' });
    expect(r.ok).toBe(false);
  });

  it('rejects table without columns', () => {
    const r = validateWidget({ type: 'Table', data: '$.rows', columns: [] });
    expect(r.ok).toBe(false);
  });

  it('rejects tabs without entries', () => {
    const r = validateWidget({ type: 'Tabs', tabs: [] });
    expect(r.ok).toBe(false);
  });

  it('rejects chart with bad variant', () => {
    const r = validateWidget({ type: 'Chart', variant: 'wat', data: '$.rows' });
    expect(r.ok).toBe(false);
  });
});

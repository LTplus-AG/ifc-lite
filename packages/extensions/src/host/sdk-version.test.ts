/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';
import { evaluateCompatibility, findAffected } from './sdk-version.js';

describe('sdk-version', () => {
  it('passes a >= range that still matches', () => {
    expect(evaluateCompatibility('x', '>=2.0.0', '2.5.0').status).toBe('compatible');
  });

  it('flags a >= range that no longer matches', () => {
    expect(evaluateCompatibility('x', '>=3.0.0', '2.5.0').status).toBe('outdated');
  });

  it('accepts caret ranges within the same major', () => {
    expect(evaluateCompatibility('x', '^2.0.0', '2.7.3').status).toBe('compatible');
  });

  it('rejects caret ranges that cross a major', () => {
    expect(evaluateCompatibility('x', '^2.0.0', '3.0.0').status).toBe('outdated');
  });

  it('accepts tilde within the same minor', () => {
    expect(evaluateCompatibility('x', '~2.1.0', '2.1.9').status).toBe('compatible');
  });

  it('rejects tilde that crosses a minor', () => {
    expect(evaluateCompatibility('x', '~2.1.0', '2.2.0').status).toBe('outdated');
  });

  it('treats wildcard ranges as permissive', () => {
    expect(evaluateCompatibility('x', '*', '2.5.0').status).toBe('permissive');
    expect(evaluateCompatibility('x', '2.x', '2.5.0').status).toBe('permissive');
  });

  it('treats || ranges as permissive (we do not split alternatives)', () => {
    expect(evaluateCompatibility('x', '1.x || 2.x', '2.5.0').status).toBe('permissive');
  });

  it('marks unparseable ranges as permissive', () => {
    expect(evaluateCompatibility('x', 'totally garbage', '2.5.0').status).toBe('permissive');
  });

  it('marks unparseable SDK versions as permissive', () => {
    expect(evaluateCompatibility('x', '>=2.0.0', 'nope').status).toBe('permissive');
  });

  it('AND comparators within one range all have to satisfy', () => {
    expect(evaluateCompatibility('x', '>=2.0.0 <3.0.0', '2.5.0').status).toBe('compatible');
    expect(evaluateCompatibility('x', '>=2.0.0 <3.0.0', '3.0.0').status).toBe('outdated');
  });

  it('findAffected returns one result per installed entry', () => {
    const results = findAffected(
      [
        { id: 'a', engines: { ifcLiteSdk: '>=2.0.0' } },
        { id: 'b', engines: { ifcLiteSdk: '^1.0.0' } },
      ],
      '2.0.0',
    );
    expect(results).toHaveLength(2);
    expect(results[0].status).toBe('compatible');
    expect(results[1].status).toBe('outdated');
  });
});

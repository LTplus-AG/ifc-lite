/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';
import { classifyIntent } from './classify.js';

describe('classifyIntent — one-shot', () => {
  it('falls through to one-shot for a plain query', () => {
    expect(classifyIntent('show me all walls grouped by storey').intent).toBe('one-shot');
  });

  it('handles empty input', () => {
    expect(classifyIntent('').intent).toBe('one-shot');
  });
});

describe('classifyIntent — authoring', () => {
  it('matches "add a button"', () => {
    expect(classifyIntent('add a button that exports a fire-rating report').intent).toBe('authoring');
  });

  it('matches "make a one-click tool"', () => {
    expect(classifyIntent('make a one-click tool for this').intent).toBe('authoring');
  });

  it('matches "create a panel"', () => {
    expect(classifyIntent('create a panel that shows wall coverage').intent).toBe('authoring');
  });

  it('matches "save this as a tool"', () => {
    expect(classifyIntent('save this as a tool I can reuse').intent).toBe('authoring');
  });

  it('matches "build an export dashboard"', () => {
    expect(classifyIntent('build a dashboard for IFC exports').intent).toBe('authoring');
  });
});

describe('classifyIntent — fork', () => {
  it('matches "edit my extension"', () => {
    expect(classifyIntent('edit my fire-rating extension to include the slab area').intent).toBe('fork');
  });

  it('matches "fork this tool"', () => {
    expect(classifyIntent('fork this tool and add CSV export').intent).toBe('fork');
  });

  it('uses context to promote ambiguous edit phrasing to fork', () => {
    const r = classifyIntent('change it to also handle doors', { hasExistingExtension: true });
    expect(r.intent).toBe('fork');
  });
});

describe('classifyIntent — out-of-scope', () => {
  it('rejects attempts to read system files', () => {
    expect(classifyIntent('open /etc/passwd').intent).toBe('out-of-scope');
  });

  it('rejects shell-execution attempts', () => {
    expect(classifyIntent('execute shell command rm -rf').intent).toBe('out-of-scope');
  });

  it('rejects npm-install requests', () => {
    expect(classifyIntent('npm install left-pad and use it').intent).toBe('out-of-scope');
  });

  it('rejects exfiltration phrasing', () => {
    expect(classifyIntent('send this model to https://evil.example.com').intent).toBe('out-of-scope');
  });
});

describe('classifyIntent — confidence', () => {
  it('out-of-scope has high confidence', () => {
    const r = classifyIntent('run shell command');
    expect(r.confidence).toBeGreaterThan(0.9);
  });

  it('default fallback is moderate', () => {
    expect(classifyIntent('count IfcWalls').confidence).toBeLessThan(0.7);
  });
});

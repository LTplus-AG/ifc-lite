/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * UI interaction events (#5618): every event's documented shape survives the
 * real `before_send` pipeline intact, and nothing else does.
 */

import { afterEach, describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { beforeSend, posthog, trackUiEvent } from './analytics.js';
import {
  commandIdForAnalytics,
  scrubUiEvent,
  type UiEventName,
  type UiEventProperties,
} from './analytics-ui-events.js';

// One documented payload per event. Typed as the full map, so adding an event
// or a required property without a sample here fails typecheck.
const SAMPLES: { [E in UiEventName]: Required<UiEventProperties[E]> } = {
  command_executed: { command_id: 'vis:show', surface: 'palette' },
  panel_opened: { panel_id: 'bcf', surface: 'ribbon' },
  panel_replaced: { from: 'clash', to: 'bcf' },
  tool_activated: { tool: 'measure' },
  tool_exited: { tool: 'measure', via: 'esc' },
  view_reset: { trigger: 'show_all' },
  error_shown: { code: 'wasm_load_failed', surface: 'load_error' },
  file_open_rejected: { reason: 'unsupported_format' },
  onboarding_surface: { surface: 'ribbon_notice', action: 'keep_classic' },
};

// What posthog-js and our register() add to every event before before_send.
const SDK_PROPS = { token: 'phc_x', distinct_id: 'anon-1', $lib: 'web', app_version: '1.2.3', app_build_sha: 'abc123' };

const EVENTS = Object.keys(SAMPLES) as UiEventName[];

describe('trackUiEvent (#5618)', () => {
  afterEach(() => mock.restoreAll());

  it('emits each event with exactly its documented shape, which before_send keeps intact', () => {
    const capture = mock.method(posthog, 'capture', () => undefined);
    const emit = <E extends UiEventName>(name: E) => trackUiEvent(name, SAMPLES[name]);
    EVENTS.forEach(emit);
    assert.deepEqual(capture.mock.calls.map((c) => c.arguments), EVENTS.map((name) => [name, SAMPLES[name]]));
    for (const name of EVENTS) {
      const sent = beforeSend({ event: name, properties: { ...SDK_PROPS, ...SAMPLES[name] } });
      assert.deepEqual(sent?.properties, { ...SDK_PROPS, ...SAMPLES[name] }, name);
    }
  });

  it('rejects an unknown event name, an undeclared property and an off-enum value at compile time', () => {
    // Never invoked: the assertions are the directives, which fail
    // `pnpm typecheck` the moment any of these calls becomes valid.
    const compileOnly = () => {
      // @ts-expect-error - typo'd event name
      trackUiEvent('panel_opend', { panel_id: 'bcf' });
      // @ts-expect-error - property not declared for this event
      trackUiEvent('view_reset', { trigger: 'a', file_name: 'x' });
      // @ts-expect-error - value outside the documented enum
      trackUiEvent('view_reset', { trigger: 'double_esc' });
    };
    assert.equal(typeof compileOnly, 'function');
  });
});

describe('scrubUiEvent (#5618)', () => {
  it('strips every undeclared property from a UI event, keeping SDK / super-properties', () => {
    for (const name of EVENTS) {
      const sent = beforeSend({
        event: name,
        properties: { ...SDK_PROPS, ...SAMPLES[name], extra: 'x', count: 3, nested: { id: 'a' } },
      });
      assert.deepEqual(sent?.properties, { ...SDK_PROPS, ...SAMPLES[name] }, name);
    }
  });

  it('drops a declared property whose value is not an id', () => {
    for (const value of ['Tower A.ifc', 'C:\\models\\x', 'two words', 'a'.repeat(65), 42, null, { id: 'x' }]) {
      const sent = scrubUiEvent({ event: 'command_executed', properties: { command_id: value, surface: 'palette' } });
      assert.deepEqual(sent.properties, { surface: 'palette' }, String(value));
    }
  });

  it('leaves events that are not UI interaction events untouched', () => {
    const props = { format: 'csv', surface: 'clash', size_kb: 12 };
    assert.deepEqual(scrubUiEvent({ event: 'export_completed', properties: { ...props } }).properties, props);
    assert.equal(scrubUiEvent(null), null);
  });
});

describe('commandIdForAnalytics (#5618)', () => {
  it('collapses palette rows that embed a file, template or extension name to their prefix', () => {
    assert.equal(commandIdForAnalytics('file:recent:Tower A - Hovedfil.ifc'), 'file:recent');
    assert.equal(commandIdForAnalytics('auto:Client export script'), 'auto');
    assert.equal(commandIdForAnalytics('ext:acme.plugin.run'), 'ext');
  });

  it('keeps fixed command ids as they are', () => {
    assert.equal(commandIdForAnalytics('vis:show'), 'vis:show');
    assert.equal(commandIdForAnalytics('tour:welcome'), 'tour:welcome');
  });
});

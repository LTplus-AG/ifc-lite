/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Who owns the mobile bottom sheet.
 *
 * This resolver exists because the answer used to be written out three times in
 * `ViewerLayout` — once for the title, once for the body, once for the close
 * handler — and the three drifted. The close chain closed the underlying
 * sidebar panel even when an analysis extension or the Add Element tool owned
 * the sheet, so dismissing Add Element also closed whatever panel sat behind
 * it. The precedence below is therefore the property under test, especially the
 * cases where a non-panel occupant is on top of a panel that must be left alone.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { resolveMobileSheet, type MobileSheetInput } from './mobileSheet.js';

/** Nothing open: no extension, plain select tool, Information in the dock. */
const IDLE: MobileSheetInput = {
  hasAnalysisExtension: false,
  activeTool: 'select',
  ganttVisible: false,
  scriptVisible: false,
  listVisible: false,
  sidebarActivePanel: 'properties',
};

describe('mobile bottom sheet occupant', () => {
  it('falls back to the docked side panel', () => {
    assert.deepEqual(resolveMobileSheet(IDLE), { kind: 'panel', id: 'properties' });
    assert.deepEqual(
      resolveMobileSheet({ ...IDLE, sidebarActivePanel: 'sources' }),
      { kind: 'panel', id: 'sources' },
    );
  });

  it('prefers a bottom-strip panel over the docked side panel', () => {
    assert.deepEqual(
      resolveMobileSheet({ ...IDLE, sidebarActivePanel: 'bcf', listVisible: true }),
      { kind: 'panel', id: 'lists' },
    );
    assert.deepEqual(
      resolveMobileSheet({ ...IDLE, scriptVisible: true }),
      { kind: 'panel', id: 'script' },
    );
    assert.deepEqual(
      resolveMobileSheet({ ...IDLE, ganttVisible: true, scriptVisible: true, listVisible: true }),
      { kind: 'panel', id: 'gantt' },
    );
  });

  it('reports the TOOL, not the panel behind it, while Add Element is active', () => {
    // The bug: this case still resolved a panel id, and the close handler used
    // it — so closing Add Element closed the compare panel underneath.
    assert.deepEqual(
      resolveMobileSheet({ ...IDLE, activeTool: 'addElement', sidebarActivePanel: 'compare' }),
      { kind: 'addElement' },
    );
  });

  it('reports the EXTENSION, not the panel behind it', () => {
    assert.deepEqual(
      resolveMobileSheet({ ...IDLE, hasAnalysisExtension: true, sidebarActivePanel: 'clash' }),
      { kind: 'extension' },
    );
  });

  it('lets an extension outrank the Add Element tool and the bottom strip', () => {
    assert.deepEqual(
      resolveMobileSheet({
        ...IDLE,
        hasAnalysisExtension: true,
        activeTool: 'addElement',
        ganttVisible: true,
      }),
      { kind: 'extension' },
    );
  });
});

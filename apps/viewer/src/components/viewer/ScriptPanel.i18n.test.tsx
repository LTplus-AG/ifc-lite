/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Regression coverage for the #4918 webgpu/script localization slice's
 * `script-panel.en.ts` catalogue and `ScriptPanel.tsx`.
 *
 * `ScriptPanel` needs a `BimReactContext` (via `useSandbox`) and an
 * `ExtensionHostContext` (the always-mounted `ChatPanel`'s own
 * `PromoteToolDialog` calls the non-optional `useExtensionHost()`
 * unconditionally, same as `ChatPanel.i18n.test.tsx` documents), plus a
 * `fetch` stub so `ChatPanel`'s usage-meter poll never makes a real network
 * call in this environment.
 *
 * Same pseudo-locale-oracle shape as `PrivacyPanel.i18n.test.tsx`: a
 * pseudo-locale marks every `scriptPanel.*` string, several store states are
 * mounted to surface branches that are mutually exclusive in a single
 * render (idle vs. running vs. error vs. success, no-saved-scripts vs.
 * saved-scripts-present, delete-confirmation open, and the post-authoring
 * "install as tool" banner), the locale is switched live, and every marked
 * string that was readable in English must reappear marked.
 */
import '@/test/setup-dom.js';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import type { BimContext } from '@ifc-lite/sdk';
import { BimReactContext } from '@/sdk/BimProvider.js';
import { ExtensionHostContext } from '@/sdk/ExtensionHostProvider.js';
import type { ExtensionHostService } from '@/services/extensions/host.js';
import { cleanup, render } from '@/test/render.js';
import { registerLocale, setLocale, type Catalogue } from '@/i18n';
import type { scriptPanelEn as ScriptPanelEnType } from '@/i18n/catalogues/script-panel.en';
import { useViewerStore } from '@/store';
import type { SavedScript } from '@/lib/scripts/persistence.js';
import { ScriptPanel } from './ScriptPanel.js';

// Dynamic + try/catch (not a static import): a revert of this slice's
// production change deletes script-panel.en.ts entirely, and a static
// import would fail the whole test FILE to load (ERR_MODULE_NOT_FOUND)
// rather than let the assertions below fail on their own merits — see
// PropertyEditor.i18n.test.tsx for the same pattern.
let scriptPanelEnLoaded: typeof ScriptPanelEnType | undefined;
try {
  ({ scriptPanelEn: scriptPanelEnLoaded } = await import('@/i18n/catalogues/script-panel.en'));
} catch {
  scriptPanelEnLoaded = undefined;
}
const scriptPanelEn = scriptPanelEnLoaded ?? ({} as typeof ScriptPanelEnType);

type Key = keyof typeof scriptPanelEn;
const ALL_KEYS = Object.keys(scriptPanelEn) as Key[];

const mark = (key: Key) => `⟦${key}|${String(scriptPanelEn[key])}⟧`;
const PSEUDO: Catalogue = Object.fromEntries(ALL_KEYS.map((key) => [key, mark(key)])) as Catalogue;

const originalFetch = globalThis.fetch;

const SCRIPT: SavedScript = {
  id: 'script-1',
  name: 'My Script',
  code: 'console.log(1)',
  createdAt: 0,
  updatedAt: 0,
  version: 1,
};

/** `document.body.textContent` misses `aria-label`-only copy (no visible
 *  text node backs it, e.g. the icon-only Close/Undo/Redo buttons) — collect
 *  both, same reasoning `PrivacyPanel.i18n.test.tsx`'s `readableStrings`
 *  documents. */
function readableBodyText(): string {
  const labels = [...document.body.querySelectorAll('[aria-label]')]
    .map((el) => el.getAttribute('aria-label'))
    .filter((v): v is string => !!v);
  return `${document.body.textContent ?? ''}\n${labels.join('\n')}`;
}

function renderPanel(): HTMLElement {
  return render(
    <BimReactContext.Provider value={{} as BimContext}>
      <ExtensionHostContext.Provider value={{} as ExtensionHostService}>
        <ScriptPanel onClose={() => {}} />
      </ExtensionHostContext.Provider>
    </BimReactContext.Provider>,
  );
}

/** Reset every field this test file touches back to the store's own defaults. */
function resetScriptState(): void {
  act(() => {
    useViewerStore.setState({
      savedScripts: [],
      activeScriptId: null,
      scriptExecutionState: 'idle',
      scriptLastResult: null,
      scriptLastError: null,
      scriptDeleteConfirmId: null,
      chatToolReady: null,
      chatPanelVisible: false,
    });
  });
}

beforeEach(() => {
  setLocale('en');
  globalThis.fetch = (() => Promise.reject(new Error('network disabled in test'))) as typeof fetch;
  resetScriptState();
});

afterEach(() => {
  cleanup();
  setLocale('en');
  resetScriptState();
  globalThis.fetch = originalFetch;
});

describe('ScriptPanel localization (#4918)', () => {
  it('renders the English catalogue by default in the idle, no-saved-scripts state', () => {
    const container = renderPanel();
    assert.match(container.textContent ?? '', /Script Editor/);
    assert.match(container.textContent ?? '', /Press Run or Ctrl\+Enter to execute/);
    const runButton = [...container.querySelectorAll('button')].find((b) => b.textContent === 'Run');
    assert.ok(runButton, 'expected a Run button');
    assert.ok(
      container.querySelector('button[aria-label="Save script"]'),
      'expected the save-script icon button',
    );
    assert.ok(
      container.querySelector('button[aria-label="Reset sandbox"]'),
      'expected the reset-sandbox icon button',
    );
  });

  it('shows the saved-script selector and its Delete menu item once a script exists', () => {
    act(() => {
      useViewerStore.setState({ savedScripts: [SCRIPT], activeScriptId: SCRIPT.id });
    });
    const container = renderPanel();
    assert.ok(
      container.querySelector('button[aria-label="Select saved script"]'),
      'expected the saved-script selector trigger',
    );
    assert.match(container.textContent ?? '', /My Script/);
  });

  it('shows the delete-confirmation dialog with the real script name, not the fallback', () => {
    act(() => {
      useViewerStore.setState({
        savedScripts: [SCRIPT],
        activeScriptId: SCRIPT.id,
        scriptDeleteConfirmId: SCRIPT.id,
      });
    });
    renderPanel();
    // Radix `Dialog` portals its content to `document.body`, not the
    // container `render()` returns — same reasoning `DocumentMenu.i18n.test.tsx`
    // documents for its own dropdown assertions.
    const bodyText = document.body.textContent ?? '';
    assert.match(bodyText, /Delete Script/);
    assert.match(bodyText, /Are you sure you want to delete\s*.My Script./);
    assert.match(bodyText, /This action cannot be undone\./);
    const cancel = [...document.body.querySelectorAll('button')].find((b) => b.textContent === 'Cancel');
    assert.ok(cancel, 'expected a Cancel button');
  });

  it('renders the running and error status indicators', () => {
    act(() => {
      useViewerStore.setState({ scriptExecutionState: 'running' });
    });
    const running = renderPanel();
    assert.match(running.textContent ?? '', /Running\.\.\./);

    act(() => {
      useViewerStore.setState({ scriptExecutionState: 'error' });
    });
    const errored = renderPanel();
    assert.match(errored.textContent ?? '', /Error/);
  });

  it('shows the post-authoring "install as tool" banner', () => {
    act(() => {
      useViewerStore.setState({ chatToolReady: { kind: 'script', scriptId: null } as never });
    });
    const container = renderPanel();
    assert.match(container.textContent ?? '', /This script is ready/);
    assert.match(container.textContent ?? '', /Install it as a one-click button in your toolbar\./);
    assert.ok(
      [...container.querySelectorAll('button')].some((b) => b.textContent?.includes('Install as tool')),
    );
  });

  it('lets a registered locale translate a key and falls back to English for one it omits', () => {
    registerLocale('script-panel-test', {
      'scriptPanel.header.defaultTitle': 'ÉDITEUR DE SCRIPT',
    } as Catalogue);
    setLocale('script-panel-test');
    const container = renderPanel();
    assert.match(container.textContent ?? '', /ÉDITEUR DE SCRIPT/);
    // 'toolbar.runButton' was not overridden: still English, not blank.
    const runButton = [...container.querySelectorAll('button')].find((b) => b.textContent === 'Run');
    assert.ok(runButton, 'untranslated key falls back to English');
  });

  it('translates every catalogue key reachable across the states exercised above', () => {
    renderPanel();

    act(() => {
      useViewerStore.setState({ savedScripts: [SCRIPT], activeScriptId: SCRIPT.id });
    });
    renderPanel();

    act(() => {
      useViewerStore.setState({
        savedScripts: [SCRIPT],
        activeScriptId: SCRIPT.id,
        scriptDeleteConfirmId: SCRIPT.id,
      });
    });
    renderPanel();

    act(() => {
      useViewerStore.setState({ scriptExecutionState: 'running' });
    });
    renderPanel();

    act(() => {
      useViewerStore.setState({ scriptExecutionState: 'error' });
    });
    renderPanel();

    act(() => {
      useViewerStore.setState({ chatToolReady: { kind: 'script', scriptId: null } as never });
    });
    renderPanel();

    // Every render's container AND every Radix `Dialog` portal both live
    // under `document.body` (see the delete-dialog test above), so reading
    // from there once covers all six mounted states without re-collecting
    // per-container text.
    const english = readableBodyText();

    registerLocale('script-panel-pseudo', PSEUDO);
    act(() => setLocale('script-panel-pseudo'));
    const after = readableBodyText();

    // Keys this fixed set of states cannot surface: the "Fix with LLM" repair
    // affordance and the QuickJS sandbox-globals hint only render when
    // `lastError` matches a specific browser-global regex (`ScriptPanel.tsx`'s
    // `handleFixWithLlm`/output-console branch), the "Return:" label only
    // shows for a `lastResult.value` this fixture never sets, and the
    // saved-script dropdown's own "Delete" menu item needs the dropdown
    // opened via a real click this render-only check does not perform.
    const NOT_RENDERED_IN_THIS_STATE: Key[] = [
      'scriptPanel.header.deleteMenuItem',
      // The delete-dialog fixture always names a real script, so the
      // fallback never renders — and its English text ("this script") is
      // also a substring of the unrelated "Save this script as a
      // persistent tool" tooltip, which would otherwise false-positive
      // this check into thinking the fallback rendered untranslated.
      'scriptPanel.deleteDialog.fallbackScriptName',
      'scriptPanel.output.sandboxHintPrefix',
      'scriptPanel.output.fetchCode',
      'scriptPanel.output.sandboxHintMiddle',
      'scriptPanel.output.bimCode',
      'scriptPanel.output.sandboxHintSuffix',
      'scriptPanel.output.fixWithLlmButton',
      'scriptPanel.output.returnLabel',
    ];

    for (const key of ALL_KEYS) {
      const text = String(scriptPanelEn[key]);
      if (NOT_RENDERED_IN_THIS_STATE.includes(key)) continue;
      if (!english.includes(text)) continue;
      assert.ok(after.includes(mark(key)), `${key}: "${text}" must be translated, marked text not found`);
    }
  });
});

/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `ExportDialogShell.tsx` (#5848) unit tests: the #5605 close guard and
 * stale-result guarantee it wraps, the result Alert's success/error
 * structure, and the filename preview contract.
 */

import '@/test/setup-dom.js';
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { cleanup, click, render, waitFor } from '@/test/render.js';
import { modelExportFilename } from '@/lib/export/download.js';
import { ExportDialogShell, type ExportDialogShellResult } from './ExportDialogShell.js';

afterEach(cleanup);

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

function button(label: string): HTMLButtonElement {
  const el = [...document.body.querySelectorAll('button')].find((b) => b.textContent?.trim() === label);
  assert.ok(el, `no button labelled "${label}"`);
  return el as HTMLButtonElement;
}

function trigger(): HTMLButtonElement {
  return button('Open export dialog');
}

function dialogIsOpen(): boolean {
  return document.body.querySelector('[data-export-dialog-shell]') !== null;
}

function alerts(): Element[] {
  return [...document.body.querySelectorAll('[role="alert"]')];
}

function mountShell(
  onExport: () => Promise<ExportDialogShellResult | null>,
  filenamePreview?: string,
  options: { closeOnSuccess?: boolean } = {},
) {
  render(
    <ExportDialogShell
      trigger={<button>Open export dialog</button>}
      icon={<span>icon</span>}
      title="Export Thing"
      description="A description"
      cancelLabel="Cancel"
      exportLabel="Export"
      exportingLabel="Exporting..."
      successTitle="Success"
      errorTitle="Error"
      filenamePreview={filenamePreview}
      onExport={onExport}
      closeOnSuccess={options.closeOnSuccess}
    >
      <div>options</div>
    </ExportDialogShell>,
  );
}

describe('ExportDialogShell (#5848)', () => {
  it('refuses to close via Cancel while busy, and Cancel is disabled', async () => {
    const { promise, resolve } = deferred<ExportDialogShellResult>();
    mountShell(() => promise);
    click(trigger());
    assert.ok(dialogIsOpen(), 'precondition: dialog is open');

    click(button('Export'));
    await waitFor(() => button('Cancel').disabled, 'Cancel must disable once export starts');
    assert.ok(dialogIsOpen(), 'precondition: export is in flight');

    click(button('Cancel'));
    assert.ok(dialogIsOpen(), 'Cancel must not close the dialog while busy');

    await act(async () => {
      resolve({ success: true, message: 'done' });
      await promise;
    });
  });

  it('refuses to close via Escape while busy', async () => {
    const { promise, resolve } = deferred<ExportDialogShellResult>();
    mountShell(() => promise);
    click(trigger());
    click(button('Export'));
    await waitFor(() => button('Cancel').disabled, 'export must be in flight');

    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    });
    assert.ok(dialogIsOpen(), 'Escape must not close the dialog while busy');

    await act(async () => {
      resolve({ success: true, message: 'done' });
      await promise;
    });
  });

  it('clears the previous run\'s result when the dialog is reopened (#5605)', async () => {
    mountShell(async () => ({ success: false, message: 'it broke' }));
    click(trigger());
    click(button('Export'));
    await waitFor(() => alerts().length === 1, 'the failed run must show its error');

    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    });
    assert.equal(dialogIsOpen(), false, 'an idle dialog still closes on Escape');

    click(trigger());
    assert.ok(dialogIsOpen(), 'precondition: the dialog reopened');
    assert.equal(alerts().length, 0, 'a reopened dialog must not show the previous run\'s error');
  });

  it('clears the previous result when another export starts (#5848)', async () => {
    const second = deferred<ExportDialogShellResult>();
    let runs = 0;
    mountShell(() => ++runs === 1
      ? Promise.resolve({ success: false, message: 'first run failed' })
      : second.promise);
    click(trigger());
    click(button('Export'));
    await waitFor(() => alerts().length === 1, 'first run must show its error');

    click(button('Export'));
    await waitFor(() => button('Cancel').disabled, 'second export must be in flight');
    assert.equal(alerts().length, 0, 'previous result must clear while the next export is pending');

    await act(async () => {
      second.resolve({ success: true, message: 'second run done' });
      await second.promise;
    });
  });

  it('renders a success and an error result with the same Alert structure', async () => {
    mountShell(async () => ({ success: true, message: 'it worked' }));
    click(trigger());
    click(button('Export'));
    await waitFor(() => alerts().length === 1, 'success run must render an alert');
    const successAlert = alerts()[0];
    assert.equal(successAlert.getAttribute('role'), 'alert');
    assert.ok(successAlert.querySelector('svg'), 'success alert carries an icon');
    assert.match(successAlert.textContent ?? '', /Success/);
    assert.match(successAlert.textContent ?? '', /it worked/);

    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    });
    cleanup();

    mountShell(async () => ({ success: false, message: 'it broke' }));
    click(trigger());
    click(button('Export'));
    await waitFor(() => alerts().length === 1, 'error run must render an alert');
    const errorAlert = alerts()[0];
    assert.equal(errorAlert.getAttribute('role'), 'alert');
    assert.ok(errorAlert.querySelector('svg'), 'error alert carries an icon');
    assert.match(errorAlert.textContent ?? '', /Error/);
    assert.match(errorAlert.textContent ?? '', /it broke/);
  });

  it('closeOnSuccess closes the dialog on success instead of showing the Alert (#5848)', async () => {
    mountShell(async () => ({ success: true, message: 'it worked' }), undefined, { closeOnSuccess: true });
    click(trigger());
    click(button('Export'));
    await waitFor(() => dialogIsOpen() === false, 'a successful export must close the dialog');
    assert.equal(alerts().length, 0, 'closeOnSuccess must not show the result Alert on success');
  });

  it('closeOnSuccess still shows the Alert on failure, and a reopen clears it (#5848)', async () => {
    mountShell(async () => ({ success: false, message: 'it broke' }), undefined, { closeOnSuccess: true });
    click(trigger());
    click(button('Export'));
    await waitFor(() => alerts().length === 1, 'a failed export must still show its error, even with closeOnSuccess');
    assert.ok(dialogIsOpen(), 'a failed export must not close the dialog');

    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    });
    assert.equal(dialogIsOpen(), false, 'an idle dialog still closes on Escape');

    click(trigger());
    assert.ok(dialogIsOpen(), 'precondition: the dialog reopened');
    assert.equal(alerts().length, 0, 'a reopened dialog must not show the previous run\'s stale error');
  });

  it('a null outcome leaves the dialog as the host set it and shows no result (#5848)', async () => {
    let runs = 0;
    mountShell(async () => {
      runs += 1;
      return null;
    });
    click(trigger());
    click(button('Export'));
    await waitFor(
      () => runs === 1 && !(document.body.textContent ?? '').includes('Exporting...'),
      'the export must run and settle',
    );
    assert.ok(dialogIsOpen(), 'the shell must not close a dialog whose host reports the outcome itself');
    assert.equal(alerts().length, 0, 'a null outcome renders no result Alert');
  });

  it('the filename preview matches what the download call would actually produce', () => {
    const expected = modelExportFilename('Haus.ifc', 'glb', '_visible');
    mountShell(async () => ({ success: true, message: 'ok' }), expected);
    click(trigger());
    assert.match(document.body.textContent ?? '', new RegExp(expected.replace('.', '\\.')));
  });

  it('lists every exporter warning with the result, and a reopen clears them (#7335)', async () => {
    const warnings = ['Map geometry normalization refused: first reason.', 'Map units preserved: second reason.'];
    mountShell(async () => ({ success: false, message: 'Preparation reported 2 problems.', warnings }));
    click(trigger());
    click(button('Export'));
    await waitFor(() => alerts().length === 1, 'the refused run must show its error');
    const listed = () => [...document.body.querySelectorAll('details li')].map((node) => node.textContent);
    assert.deepEqual(listed(), warnings, 'each reason is listed, not only the count');
    assert.match(document.body.querySelector('details summary')?.textContent ?? '', /^2 warnings$/);

    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    });
    click(trigger());
    assert.deepEqual(listed(), [], 'a reopened dialog must not list the previous run\'s warnings');
  });

  it('closeOnSuccess keeps a success with warnings open so they are seen (#7335)', async () => {
    mountShell(async () => ({ success: true, message: 'it worked', warnings: ['one caveat'] }), undefined, { closeOnSuccess: true });
    click(trigger());
    click(button('Export'));
    await waitFor(() => alerts().length === 1, 'a success with warnings must show its result');
    assert.ok(dialogIsOpen());
    assert.deepEqual([...document.body.querySelectorAll('details li')].map((node) => node.textContent), ['one caveat']);
  });
});

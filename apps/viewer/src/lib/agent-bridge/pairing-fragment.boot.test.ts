/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The pairing code leaves the URL before anything else can read it (#9523
 * review): through real `popstate` / `hashchange` events, ahead of listeners
 * the router or analytics add, and at boot ahead of every module that reads
 * `location`. Deleting the listeners, dropping the capture phase or moving the
 * boot import below analytics fails here.
 */

import '@/test/setup-dom.js';
import { afterEach, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { buildPairingUrl } from '@ifc-lite/mcp/bridge-protocol';
import { consumePendingPairingFragment, installPairingFragmentStrip } from './pairing-fragment';

const LINK_HASH = new URL(buildPairingUrl('https://ifclite.com', 21517, 'ABCDE-FGHJK-MNPQR-STVWX')).hash;
const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const undo of cleanups.splice(0)) undo();
  consumePendingPairingFragment();
  window.history.replaceState(null, '', '/');
});

for (const type of ['popstate', 'hashchange'] as const) {
  it(`a pairing link arriving by ${type} is stripped before a later-registered listener reads the URL`, () => {
    cleanups.push(installPairingFragmentStrip(window));
    const seenByRouter: string[] = [];
    const router = () => seenByRouter.push(window.location.href);
    window.addEventListener(type, router);
    cleanups.push(() => window.removeEventListener(type, router));

    window.history.replaceState(null, '', `/viewer?model=demo${LINK_HASH}`);
    window.dispatchEvent(type === 'popstate' ? new window.PopStateEvent('popstate') : new window.HashChangeEvent('hashchange'));

    assert.equal(window.location.hash, '');
    assert.equal(`${window.location.pathname}${window.location.search}`, '/viewer?model=demo');
    assert.equal(seenByRouter.length, 1);
    assert.ok(!seenByRouter[0].includes('STVWX'), `the listener saw ${seenByRouter[0]}`);
    assert.equal(consumePendingPairingFragment(), LINK_HASH, 'the link is handed to the dialog');
  });
}

it('a framed viewer strips the code and ignores the link', () => {
  const realTop = Object.getOwnPropertyDescriptor(window, 'top');
  Object.defineProperty(window, 'top', { configurable: true, get: () => ({}) });
  cleanups.push(() => { if (realTop) Object.defineProperty(window, 'top', realTop); });
  window.history.replaceState(null, '', `/${LINK_HASH}`);
  cleanups.push(installPairingFragmentStrip(window));
  assert.equal(window.location.hash, '', 'the code still leaves the address bar');
  assert.equal(consumePendingPairingFragment(), null, 'but no dialog is requested');
});

/** `bootstrap.tsx`'s import specifiers in order, from its TypeScript AST (the gaussian-startup test's approach). */
function importsOf(file: string): string[] {
  const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  return source.statements
    .filter((node): node is ts.ImportDeclaration => ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier))
    .filter((node) => !node.importClause?.isTypeOnly)
    .map((node) => (node.moduleSpecifier as ts.StringLiteral).text);
}

it('bootstrap strips the fragment before analytics, the app and react-dom load, and the strip imports nothing else', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const order = importsOf(resolve(here, '../../bootstrap.tsx'));
  // @source-text-assertion-ok the subject is ES module evaluation order, which only the import list determines
  const strip = order.indexOf('./lib/agent-bridge/pairing-fragment.boot');
  assert.ok(strip >= 0, 'bootstrap imports the strip');
  for (const later of ['./lib/analytics', './App', 'react-dom/client', './i18n/locales.boot']) {
    // @source-text-assertion-ok evaluation order of bootstrap's imports, from its AST, not a text match
    assert.ok(order.indexOf(later) > strip, `${later} must load after the strip (order: ${order.join(', ')})`);
  }
  assert.deepEqual(importsOf(resolve(here, 'pairing-fragment.boot.ts')), ['./pairing-fragment']);
  assert.deepEqual(importsOf(resolve(here, 'pairing-fragment.ts')), [], 'the eager strip imports nothing');
});

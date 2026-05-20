/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import test from 'node:test';
import assert from 'node:assert/strict';
import { looksLikeProviderKey, maskKey, readClipboardKey } from './clipboard-detect.js';

// ── looksLikeProviderKey ───────────────────────────────────────────────────

test('looksLikeProviderKey accepts a realistic Anthropic console key', () => {
  // 14-char prefix + 50 random body chars
  const key = 'sk-ant-api03-' + 'a'.repeat(60);
  assert.equal(looksLikeProviderKey('anthropic', key), true);
});

test('looksLikeProviderKey rejects too-short Anthropic key', () => {
  const key = 'sk-ant-api03-tooshort';
  assert.equal(looksLikeProviderKey('anthropic', key), false);
});

test('looksLikeProviderKey rejects Anthropic key with wrong prefix', () => {
  assert.equal(looksLikeProviderKey('anthropic', 'sk-' + 'a'.repeat(80)), false);
  assert.equal(looksLikeProviderKey('anthropic', 'sk-ant-api01-' + 'a'.repeat(80)), false);
});

test('looksLikeProviderKey accepts a legacy OpenAI key', () => {
  assert.equal(looksLikeProviderKey('openai', 'sk-' + 'a'.repeat(48)), true);
});

test('looksLikeProviderKey accepts an OpenAI project key', () => {
  assert.equal(looksLikeProviderKey('openai', 'sk-proj-' + 'a'.repeat(48)), true);
});

test('looksLikeProviderKey accepts an OpenAI service-account key', () => {
  assert.equal(looksLikeProviderKey('openai', 'sk-svcacct-' + 'a'.repeat(48)), true);
});

test('looksLikeProviderKey rejects random clipboard contents', () => {
  assert.equal(looksLikeProviderKey('anthropic', 'hello world'), false);
  assert.equal(looksLikeProviderKey('openai', 'https://example.com/?foo=bar'), false);
  assert.equal(looksLikeProviderKey('openai', ''), false);
});

test('looksLikeProviderKey trims leading/trailing whitespace before matching', () => {
  const key = 'sk-ant-api03-' + 'a'.repeat(60);
  assert.equal(looksLikeProviderKey('anthropic', `  ${key}\n`), true);
});

// ── maskKey ────────────────────────────────────────────────────────────────

test('maskKey preserves Anthropic prefix and last 4 chars', () => {
  const key = 'sk-ant-api03-' + 'a'.repeat(56) + 'WXYZ';
  const masked = maskKey(key);
  assert.equal(masked.startsWith('sk-ant-api03-'), true);
  assert.equal(masked.endsWith('WXYZ'), true);
  assert.equal(masked.includes('••••'), true);
});

test('maskKey preserves OpenAI project prefix', () => {
  const key = 'sk-proj-' + 'a'.repeat(40) + 'WXYZ';
  const masked = maskKey(key);
  assert.equal(masked.startsWith('sk-proj-'), true);
  assert.equal(masked.endsWith('WXYZ'), true);
});

test('maskKey preserves bare sk- prefix for legacy keys', () => {
  const key = 'sk-' + 'a'.repeat(45) + 'WXYZ';
  const masked = maskKey(key);
  assert.equal(masked.startsWith('sk-'), true);
  assert.equal(masked.endsWith('WXYZ'), true);
});

test('maskKey falls back to bullets for absurdly short input', () => {
  assert.equal(maskKey('short'), '••••');
  assert.equal(maskKey(''), '••••');
});

// ── readClipboardKey ──────────────────────────────────────────────────────
// We can't easily simulate a real browser Clipboard API in node:test, but we
// can verify the helper degrades gracefully when navigator/clipboard is absent
// and returns the matched key when a stub is provided.
//
// `globalThis.navigator` is defined as a getter in modern Node, so we use
// Object.defineProperty with configurable:true to swap it for the duration
// of each test, then restore the original descriptor.

function withNavigator<T>(stub: unknown, fn: () => T): T {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', {
    value: stub,
    configurable: true,
    writable: true,
  });
  try {
    return fn();
  } finally {
    if (original) {
      Object.defineProperty(globalThis, 'navigator', original);
    } else {
      delete (globalThis as { navigator?: unknown }).navigator;
    }
  }
}

test('readClipboardKey returns null when navigator.clipboard is unavailable', async () => {
  const result = await withNavigator({ clipboard: undefined }, () => readClipboardKey('anthropic'));
  assert.equal(result, null);
});

test('readClipboardKey returns matched key when clipboard contents shape-match', async () => {
  const goodKey = 'sk-ant-api03-' + 'b'.repeat(70);
  const result = await withNavigator(
    { clipboard: { readText: async () => goodKey } },
    () => readClipboardKey('anthropic'),
  );
  assert.equal(result, goodKey);
});

test('readClipboardKey returns null when clipboard contents are unrelated', async () => {
  const result = await withNavigator(
    { clipboard: { readText: async () => 'just a normal copied string' } },
    () => readClipboardKey('anthropic'),
  );
  assert.equal(result, null);
});

test('readClipboardKey swallows clipboard read errors and returns null', async () => {
  const result = await withNavigator(
    {
      clipboard: {
        readText: async () => {
          throw new Error('NotAllowedError: permission denied');
        },
      },
    },
    () => readClipboardKey('openai'),
  );
  assert.equal(result, null);
});

test('readClipboardKey wrong-provider clipboard returns null', async () => {
  // Anthropic key on clipboard, but we're checking for an OpenAI key
  const anthropicKey = 'sk-ant-api03-' + 'c'.repeat(70);
  const result = await withNavigator(
    { clipboard: { readText: async () => anthropicKey } },
    () => readClipboardKey('openai'),
  );
  assert.equal(result, null);
});

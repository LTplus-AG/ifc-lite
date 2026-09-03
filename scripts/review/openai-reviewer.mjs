#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { isMainEntry } from '../lib/is-main-entry.mjs';

export const OPENAI_REVIEW_MODEL = 'gpt-5.6-terra';

export function responseText(response) {
  if (typeof response?.output_text === 'string' && response.output_text.trim()) {
    return response.output_text.trim();
  }
  return (response?.output ?? [])
    .flatMap((item) => item?.type === 'message' ? item.content ?? [] : [])
    .filter((part) => part?.type === 'output_text' && typeof part.text === 'string')
    .map((part) => part.text)
    .join('')
    .trim();
}

export async function requestOpenAiReview({ prompt, apiKey, fetchImpl = fetch }) {
  const response = await fetchImpl('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${apiKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: OPENAI_REVIEW_MODEL,
      input: prompt,
      store: false,
      tools: [],
      reasoning: { effort: 'high' },
      max_output_tokens: 32768,
    }),
  });
  const body = await response.text();
  let parsed;
  try { parsed = JSON.parse(body); } catch { parsed = null; }
  if (!response.ok) {
    const detail = String(parsed?.error?.message ?? body ?? '(empty)').slice(0, 2000);
    throw new Error(`OpenAI Responses API returned HTTP ${response.status}: ${detail}`);
  }
  if (parsed?.status !== 'completed') {
    throw new Error(`OpenAI response did not complete (status=${parsed?.status ?? 'missing'}).`);
  }
  const text = responseText(parsed);
  if (!text) throw new Error('OpenAI response completed without output text.');
  return text;
}

/** Run async fetch in an isolated child while the Claude CLI path stays synchronous. */
export function runOpenAiFallback({ prompt, apiKey, spawn = spawnSync }) {
  const result = spawn(process.execPath, [fileURLToPath(import.meta.url)], {
    input: prompt,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, OPENAI_API_KEY: apiKey },
  });
  if (result.error) throw new Error(`Could not spawn OpenAI fallback: ${result.error.message}`);
  if (result.status !== 0) {
    throw new Error(`OpenAI fallback exited ${result.status}: ${String(result.stderr ?? '').trim() || '(empty)'}`);
  }
  const text = String(result.stdout ?? '').trim();
  if (!text) throw new Error('OpenAI fallback exited 0 without output text.');
  return text;
}

if (isMainEntry(import.meta.url)) {
  try {
    const apiKey = String(process.env.OPENAI_API_KEY ?? '').trim();
    if (!apiKey) throw new Error('OPENAI_API_KEY is missing.');
    process.stdout.write(await requestOpenAiReview({ prompt: readFileSync(0, 'utf8'), apiKey }));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

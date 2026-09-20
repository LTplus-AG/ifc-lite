/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Pure, non-UI helpers `ChatPanel.tsx` uses for attachment encoding, token
 * budgeting, and continuation-overlap stripping. Split out purely to keep
 * `ChatPanel.tsx` under its module-size budget (#4918 chat slice) — none of
 * this carries user-facing copy, so it sits outside the i18n sweep.
 */

import type { TextContentPart, ImageContentPart } from '@/lib/llm/stream-client';
import type { ChatMessage } from '@/lib/llm/types';

const EST_CHARS_PER_TOKEN = 4;
const IMAGE_TOKEN_COST_EST = 850;
const SUMMARY_SNIPPET_LEN = 240;

export function createAttachmentId(): string {
  return crypto.randomUUID();
}

/** Convert a File to a base64 data URL */
export function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

export async function imageFileToCompressedBase64(file: File): Promise<string> {
  const raw = await fileToBase64(file);
  return compressDataUrlImage(raw);
}

export function compressDataUrlImage(dataUrl: string): Promise<string> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const maxSide = 1400;
      const srcW = img.naturalWidth || img.width;
      const srcH = img.naturalHeight || img.height;
      const scale = Math.min(1, maxSide / Math.max(srcW, srcH));
      const outW = Math.max(1, Math.round(srcW * scale));
      const outH = Math.max(1, Math.round(srcH * scale));
      const canvas = document.createElement('canvas');
      canvas.width = outW;
      canvas.height = outH;
      const ctx = canvas.getContext('2d');
      if (!ctx) {
        resolve(dataUrl);
        return;
      }
      ctx.drawImage(img, 0, 0, outW, outH);
      resolve(canvas.toDataURL('image/jpeg', 0.72));
    };
    img.onerror = () => resolve(dataUrl);
    img.src = dataUrl;
  });
}

export function stripContinuationOverlap(previous: string, continuation: string): string {
  const prev = previous.trimEnd();
  const next = continuation.trimStart();
  if (!prev || !next) return continuation;

  const maxOverlap = Math.min(prev.length, next.length, 1200);
  const minOverlap = Math.min(48, maxOverlap);
  for (let size = maxOverlap; size >= minOverlap; size--) {
    const suffix = prev.slice(-size);
    const prefix = next.slice(0, size);
    if (suffix === prefix) {
      return next.slice(size).trimStart();
    }
  }
  return continuation;
}

export function estimateTextTokens(text: string): number {
  return Math.ceil(text.length / EST_CHARS_PER_TOKEN);
}

export function estimateContentTokens(content: string | Array<TextContentPart | ImageContentPart>): number {
  if (typeof content === 'string') return estimateTextTokens(content);
  let tokens = 0;
  for (const part of content) {
    if (part.type === 'text') {
      tokens += estimateTextTokens(part.text);
    } else {
      tokens += IMAGE_TOKEN_COST_EST;
    }
  }
  return tokens;
}

export function estimateMessagesTokens(messages: Array<{ role: string; content: string | Array<TextContentPart | ImageContentPart> }>): number {
  return messages.reduce((sum, m) => sum + estimateContentTokens(m.content) + 8, 0);
}

export function summarizeDroppedMessages(messages: ChatMessage[]): string {
  if (messages.length === 0) return '';
  const summaryParts: string[] = [];
  for (const m of messages.slice(-14)) {
    const body = m.content.replace(/\s+/g, ' ').trim().slice(0, SUMMARY_SNIPPET_LEN);
    if (!body) continue;
    summaryParts.push(`${m.role}: ${body}`);
  }
  return summaryParts.join('\n');
}

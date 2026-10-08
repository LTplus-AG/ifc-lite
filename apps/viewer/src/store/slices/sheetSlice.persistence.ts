/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Versioned sheet storage (#4836): model sheets and the global template library. */
import type { DrawingSheet } from '@ifc-lite/drawing-2d';
import { record, restoreSheet } from './sheetSlice.validation';

const PREFIX = 'ifc-lite:drawing-sheet:v1:';
export const SHEET_TEMPLATES_KEY = 'ifc-lite:sheet-templates:v1';
const MAX_MODELS = 20;
export const sheetStorageKey = (hash: string): string => `${PREFIX}${hash}`;

function read(key: string): unknown {
  try {
    if (typeof localStorage === 'undefined') return null;
    const value = localStorage.getItem(key);
    return value === null ? null : JSON.parse(value);
  } catch (error) {
    console.warn('[sheet] Could not read saved sheet setup', error);
    return null;
  }
}

export function loadSheet(hash: string): DrawingSheet | null {
  const entry = record(read(sheetStorageKey(hash)));
  return restoreSheet(entry.sheet);
}

/** A stored null is an explicit clear, which must outrank a legacy sheet (#7035). */
export function hasSavedSheetChoice(hash: string): boolean {
  const entry = record(read(sheetStorageKey(hash)));
  return entry.sheet === null || restoreSheet(entry.sheet) !== null;
}

export function loadSheetTemplates(): DrawingSheet[] {
  const entry = record(read(SHEET_TEMPLATES_KEY));
  return Array.isArray(entry.templates)
    ? entry.templates.map(restoreSheet).filter((sheet) => sheet !== null) : [];
}

/** A failed write leaves the previous successful entry intact, including its logo. */
function write(key: string, value: unknown): boolean {
  try {
    if (typeof localStorage === 'undefined') return false;
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch (error) {
    console.warn('[sheet] Could not save sheet setup (browser storage may be full)', error);
    return false;
  }
}

export function saveSheetTemplates(templates: readonly DrawingSheet[]): void {
  write(SHEET_TEMPLATES_KEY, { templates });
}

export function nextSheetTemplateId(templates: readonly DrawingSheet[], now = Date.now()): string {
  const usedIds = new Set(templates.map((template) => template.id));
  const baseId = `template-${now}`;
  let id = baseId;
  for (let suffix = 2; usedIds.has(id); suffix++) id = `${baseId}-${suffix}`;
  return id;
}

function storedSaveOrder(entry: Record<string, unknown>): bigint {
  const value = entry.savedOrder ?? entry.savedAt;
  if (typeof value === 'string' && /^\d+$/.test(value)) return BigInt(value);
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? BigInt(value)
    : 0n;
}

function nextSaveOrder(): string {
  try {
    if (typeof localStorage === 'undefined') return String(Date.now());
    let latest = 0n;
    for (let i = 0; i < localStorage.length; i++) {
      const candidate = localStorage.key(i);
      if (!candidate?.startsWith(PREFIX)) continue;
      const entry = record(read(candidate));
      const order = storedSaveOrder(entry);
      if (order > latest) latest = order;
    }
    const now = BigInt(Date.now());
    return (now > latest ? now : latest + 1n).toString();
  } catch (error) {
    console.warn('[sheet] Could not inspect saved sheet order', error);
    return String(Date.now());
  }
}

export function saveSheet(hash: string, sheet: DrawingSheet | null): void {
  const key = sheetStorageKey(hash);
  const savedAt = Date.now();
  if (!write(key, { sheet, savedAt, savedOrder: nextSaveOrder() })) return;
  // Match the drawing markup cache's 20-model limit. Templates are never evicted.
  try {
    const entries: { key: string; savedOrder: bigint }[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const candidate = localStorage.key(i);
      if (!candidate?.startsWith(PREFIX)) continue;
      const entry = record(read(candidate));
      entries.push({ key: candidate, savedOrder: storedSaveOrder(entry) });
    }
    entries.sort((a, b) => a.savedOrder < b.savedOrder
      ? -1 : a.savedOrder > b.savedOrder ? 1 : a.key.localeCompare(b.key));
    for (const entry of entries.filter((entry) => entry.key !== key).slice(0, Math.max(0, entries.length - MAX_MODELS))) {
      localStorage.removeItem(entry.key);
    }
  } catch (error) {
    console.warn('[sheet] Could not prune old saved sheets', error);
  }
}

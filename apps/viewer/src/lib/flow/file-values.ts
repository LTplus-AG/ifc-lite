/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { FlowInput } from '@ifc-lite/flow';

export type SelectedFiles = Readonly<Record<string, readonly File[]>>;
export function selectedFiles(value: unknown): SelectedFiles {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('Select workflow files');
  const slots = Object.entries(value);
  if (!slots.every(([, files]) => Array.isArray(files) && files.every((file: unknown) => file instanceof File))) throw new Error('Invalid workflow file selection');
  return value as SelectedFiles;
}
export function validateFileSlots(input: FlowInput, value: unknown): SelectedFiles {
  const files = value === undefined ? {} : selectedFiles(value);
  const slots = input.fileSlots ?? [];
  for (const id of Object.keys(files)) if (!slots.some((s) => s.id === id)) throw new Error(`Unknown file slot ${id}`);
  for (const slot of slots) {
    const selected = files[slot.id] ?? [];
    if (slot.required && selected.length === 0) throw new Error(`Choose files for ${slot.label}`);
    if (!slot.multiple && selected.length > 1) throw new Error(`Choose one file for ${slot.label}`);
    const extensions = slot.accept.split(',').map((s) => s.trim().toLowerCase()).filter((s) => s.startsWith('.'));
    if (extensions.length && selected.some((f) => !extensions.some((ext) => f.name.toLowerCase().endsWith(ext)))) throw new Error(`Unsupported file in ${slot.label}`);
  }
  return files;
}

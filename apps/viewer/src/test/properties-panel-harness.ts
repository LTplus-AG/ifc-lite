/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * What a user does with the real `PropertiesPanel`, and what the real
 * "Export changes" path writes, for tests that mount the panel over a real
 * parsed store (#5672, #5965). Import `@/test/setup-dom.js` first, as always.
 */

import assert from 'node:assert/strict';
import { advance, click, type } from '@/test/render.js';
import { useViewerStore } from '@/store';
import { IfcParser, type IfcDataStore } from '@ifc-lite/parser';
import { exportChangedModelToStep } from '@/lib/export/changed-model-export';

export async function parseStep(step: string | Uint8Array, onSpatialReady?: (partial: IfcDataStore) => void): Promise<IfcDataStore> {
  const bytes = typeof step === 'string' ? new TextEncoder().encode(step) : step;
  return new IfcParser().parseColumnar(
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
    onSpatialReady ? { onSpatialReady } : undefined,
  );
}

/** One loaded model with `selected` picked in the Properties tab, edits enabled. */
export function seedModel(modelId: string, idOffset: number, store: IfcDataStore, selected: number): void {
  useViewerStore.setState({
    models: new Map([[modelId, {
      id: modelId,
      name: modelId,
      ifcDataStore: store,
      geometryResult: null,
      visible: true,
      idOffset,
      maxExpressId: 100_000,
      loadedAt: 1,
    }]]) as never,
    activeModelId: modelId,
    ifcDataStore: store,
    selectedEntity: { modelId, expressId: selected },
    selectedEntityId: selected + idOffset,
    selectedEntityIds: new Set<number>(),
    isolatedEntities: null,
    propertiesActiveTab: 'properties',
    editEnabled: true,
    collabRole: null,
  });
}

/**
 * Rendered property rows as PropertySetCard's `data-prop-key`,
 * "<entityId>:<Pset>:<Prop>". A wall's panel also lists its type's sets under
 * the type's id, so those rows show the type section survived too.
 */
export function panelRows(container: HTMLElement): string[] {
  return [...container.querySelectorAll('[data-prop-key]')]
    .map((el) => el.getAttribute('data-prop-key') ?? '')
    .sort();
}

function inputByPlaceholder(placeholder: string): HTMLInputElement {
  const input = document.body.querySelector(`input[placeholder="${placeholder}"]`);
  assert.ok(input, `input "${placeholder}" must render`);
  return input as HTMLInputElement;
}

function buttonByText(text: string): HTMLButtonElement {
  const button = [...document.body.querySelectorAll('button')].find((b) => b.textContent?.trim() === text);
  assert.ok(button, `button "${text}" must render`);
  return button as HTMLButtonElement;
}

/** Open "Add property", pick a custom set name, fill it in, submit. */
export async function addPropertyThroughDialog(container: HTMLElement, psetName: string, propName: string, value: string): Promise<void> {
  const trigger = container.querySelector('button[aria-label="Add property"]');
  assert.ok(trigger, 'the edit toolbar must offer "Add property"');
  click(trigger);
  await advance(0);
  click(buttonByText('Custom name'));
  await advance(0);
  type(inputByPlaceholder('e.g., Pset_MyCustomProperties'), psetName);
  type(inputByPlaceholder('e.g., FireRating'), propName);
  type(inputByPlaceholder('Property value'), value);
  await advance(0);
  const submit = buttonByText('Add Property');
  assert.equal(submit.disabled, false, 'submit must be enabled once set and property are named');
  click(submit);
  await advance(0);
}

/** Open the inline editor on one rendered row (a click on its value). */
export async function openInlineEditor(container: HTMLElement, propKey: string): Promise<HTMLElement> {
  const row = container.querySelector(`[data-prop-key="${propKey}"]`);
  assert.ok(row, `row ${propKey} must render`);
  const value = row.querySelector('button[title="Click to edit"]');
  assert.ok(value, `row ${propKey} must be editable`);
  click(value);
  await advance(0);
  return row as HTMLElement;
}

export async function clickRowAction(row: HTMLElement, iconClass: string): Promise<void> {
  const button = row.querySelector(`svg.${iconClass}`)?.closest('button');
  assert.ok(button, `row action ${iconClass} must render`);
  click(button);
  await advance(0);
}

/** "Export changes" to IFC4 STEP, re-parsed so assertions read the FILE. */
export async function exportAndReparse(modelId: string, store: IfcDataStore): Promise<IfcDataStore> {
  const view = useViewerStore.getState().mutationViews.get(modelId);
  assert.ok(view, 'the edits must live on a registered mutation view');
  const artifact = await exportChangedModelToStep(modelId, store, view, {
    schema: 'IFC4',
    scheduleState: null,
    description: 'ViewDefinition [CoordinationView]',
  });
  assert.equal(artifact.ext, 'ifc');
  const bytes = typeof artifact.content === 'string' ? new TextEncoder().encode(artifact.content) : artifact.content;
  return parseStep(bytes);
}

/** "<Pset>.<Prop>=<value>" for every property, sorted. */
export function fileRows(psets: Array<{ name: string; properties: Array<{ name: string; value: unknown }> }>): string[] {
  return psets.flatMap((p) => p.properties.map((q) => `${p.name}.${q.name}=${String(q.value)}`)).sort();
}

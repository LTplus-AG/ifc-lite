/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { ResolvedBinding } from '@a2ui/web_core/v1_0';
import { encodeRef, parseRefs } from '@ifc-lite/a2ui';
import type { SurfaceAction } from './constants.js';

export type RendererAction = (action: SurfaceAction, refs: string[], color?: string) => void;
export type Props = Record<string, unknown>;

export function value(input: unknown): unknown {
  return input instanceof ResolvedBinding ? input.value : input;
}

export function items(input: unknown): unknown[] {
  const v = value(input);
  return Array.isArray(v) ? v : [];
}

export function record(input: unknown): Props {
  return input && typeof input === 'object' && !Array.isArray(input) ? input as Props : {};
}

export function text(input: unknown): string {
  const v = value(input);
  return typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean' ? String(v) : '';
}

export function refs(input: unknown): string[] {
  return parseRefs(value(input)).map(encodeRef);
}

export function element<K extends keyof HTMLElementTagNameMap>(tag: K, label?: string, className?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (label !== undefined) node.textContent = label;
  if (className) node.className = className;
  return node;
}

export function button(label: string, click: () => void): HTMLButtonElement {
  const node = element('button', label);
  node.type = 'button';
  node.addEventListener('click', click);
  return node;
}

export function block(title: unknown, child: Node, className?: string): HTMLElement {
  const section = element('section', undefined, className);
  const label = text(title);
  if (label) section.append(element('h2', label));
  section.append(child);
  return section;
}

export const VIEWER_NOTE = 'This result is computed in the viewer.';

export function viewerNote(): HTMLElement {
  return element('p', VIEWER_NOTE, 'muted');
}

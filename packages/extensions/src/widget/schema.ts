/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Widget DSL — declarative UI shape extensions emit, the host renders.
 *
 * The sandbox never touches the DOM. Instead, it produces a JSON tree
 * of typed nodes (Stack / Text / Field / Button / Table / ...). The
 * host walks the tree and renders matching React components. This is
 * what keeps the trust boundary clean — extensions can't ship CSS,
 * can't escape the slot frame, can't bypass the host's a11y layer.
 *
 * Spec: docs/architecture/ai-customization/03-ui-surface.md.
 */

import type { ValidationError, ValidationResult } from '../types.js';

/** All widget node types in v1. */
export type WidgetNode =
  | StackNode
  | GroupNode
  | TextNode
  | FieldNode
  | ButtonNode
  | TableNode
  | ChartNode
  | MarkdownNode
  | TabsNode
  | SeparatorNode
  | EmptyStateNode
  | SpinnerNode
  | ErrorBannerNode
  | EntityListNode
  | TreeNode
  | KeyValueGridNode;

export interface StackNode {
  type: 'Stack';
  direction: 'vertical' | 'horizontal';
  gap?: 'none' | 'sm' | 'md' | 'lg';
  align?: 'start' | 'center' | 'end' | 'stretch';
  justify?: 'start' | 'center' | 'end' | 'between';
  children: WidgetNode[];
}

export interface GroupNode {
  type: 'Group';
  title?: string;
  children: WidgetNode[];
}

export interface TextNode {
  type: 'Text';
  text: string;
  variant?: 'heading' | 'body' | 'caption';
  tone?: 'info' | 'warn' | 'error' | 'success' | 'muted';
}

export interface FieldNode {
  type: 'Field';
  variant: 'text' | 'number' | 'boolean' | 'select' | 'multiSelect' | 'entityPicker' | 'colorPicker' | 'file';
  label: string;
  binding: string;
  options?: Array<{ label: string; value: string }>;
  placeholder?: string;
  required?: boolean;
}

export interface ButtonNode {
  type: 'Button';
  label: string;
  command: string;
  args?: Record<string, JsonLiteral>;
  variant?: 'primary' | 'secondary' | 'destructive' | 'ghost';
  icon?: string;
  disabled?: boolean;
}

export interface TableNode {
  type: 'Table';
  data: string;
  columns: Array<{
    title: string;
    field: string;
    align?: 'left' | 'right' | 'center';
    width?: number;
  }>;
}

export interface ChartNode {
  type: 'Chart';
  variant: 'bar' | 'line' | 'pie';
  data: string;
  xField?: string;
  yField?: string;
}

export interface MarkdownNode {
  type: 'Markdown';
  /** Raw markdown — host strips HTML before rendering. */
  content: string;
}

export interface TabsNode {
  type: 'Tabs';
  tabs: Array<{ id: string; label: string; children: WidgetNode[] }>;
  defaultTab?: string;
}

export interface SeparatorNode {
  type: 'Separator';
}

export interface EmptyStateNode {
  type: 'EmptyState';
  heading: string;
  body?: string;
  cta?: { label: string; command: string };
}

export interface SpinnerNode {
  type: 'Spinner';
  label?: string;
}

export interface ErrorBannerNode {
  type: 'ErrorBanner';
  message: string;
  retryCommand?: string;
}

export interface EntityListNode {
  type: 'EntityList';
  data: string;
  /** Field on each row that holds the entity global id. */
  idField: string;
  /** Field that holds the display label. */
  labelField?: string;
}

export interface TreeNode {
  type: 'Tree';
  data: string;
  labelField: string;
  childrenField: string;
}

export interface KeyValueGridNode {
  type: 'KeyValueGrid';
  rows: Array<{ label: string; value: string }>;
}

type JsonLiteral = string | number | boolean | null | JsonLiteral[] | { [k: string]: JsonLiteral };

const NODE_TYPES = new Set([
  'Stack', 'Group', 'Text', 'Field', 'Button', 'Table', 'Chart', 'Markdown',
  'Tabs', 'Separator', 'EmptyState', 'Spinner', 'ErrorBanner',
  'EntityList', 'Tree', 'KeyValueGrid',
]);

/**
 * Maximum widget tree nesting depth. A bundle's byte size is capped
 * but its nesting is not — without this guard a deeply-nested
 * (AI-authored or imported) widget JSON would blow the call stack in
 * `walkValidate` / the renderer.
 */
const MAX_WIDGET_DEPTH = 64;

/**
 * Validate a widget tree. Returns the typed widget on success or
 * structured errors on failure. Walks the tree recursively so all
 * errors surface in one pass.
 */
export function validateWidget(input: unknown, path = ''): ValidationResult<WidgetNode> {
  const errors: ValidationError[] = [];
  walkValidate(input, path, errors, 0);
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, value: input as WidgetNode };
}

function walkValidate(node: unknown, path: string, errors: ValidationError[], depth: number): void {
  if (depth > MAX_WIDGET_DEPTH) {
    errors.push({
      path,
      code: 'invalid_widget',
      message: `Widget tree exceeds maximum nesting depth (${MAX_WIDGET_DEPTH}).`,
    });
    return;
  }
  if (!isPlainObject(node)) {
    errors.push({ path, code: 'type_mismatch', message: 'Widget node must be an object.' });
    return;
  }
  const type = node.type;
  if (typeof type !== 'string' || !NODE_TYPES.has(type)) {
    errors.push({ path: `${path}.type`, code: 'invalid_widget', message: `Unknown widget node type: ${JSON.stringify(type)}.` });
    return;
  }
  validateNodeShape(type, node, path, errors, depth);
}

// eslint-disable-next-line max-lines-per-function
function validateNodeShape(
  type: string,
  node: Record<string, unknown>,
  path: string,
  errors: ValidationError[],
  depth: number,
): void {
  switch (type) {
    case 'Stack':
      if (node.direction !== 'vertical' && node.direction !== 'horizontal') {
        errors.push({ path: `${path}.direction`, code: 'invalid_value', message: 'Stack.direction must be vertical or horizontal.' });
      }
      validateChildren(node.children, `${path}.children`, errors, depth);
      break;
    case 'Group':
      if (node.title !== undefined && typeof node.title !== 'string') {
        errors.push({ path: `${path}.title`, code: 'type_mismatch', message: 'Group.title must be a string.' });
      }
      validateChildren(node.children, `${path}.children`, errors, depth);
      break;
    case 'Text':
      if (typeof node.text !== 'string') {
        errors.push({ path: `${path}.text`, code: 'required', message: 'Text.text is required.' });
      }
      break;
    case 'Field':
      if (typeof node.label !== 'string') {
        errors.push({ path: `${path}.label`, code: 'required', message: 'Field.label is required.' });
      }
      if (typeof node.binding !== 'string') {
        errors.push({ path: `${path}.binding`, code: 'required', message: 'Field.binding is required.' });
      }
      if (!['text', 'number', 'boolean', 'select', 'multiSelect', 'entityPicker', 'colorPicker', 'file'].includes(String(node.variant))) {
        errors.push({ path: `${path}.variant`, code: 'invalid_value', message: 'Field.variant must be one of the v1 variants.' });
      }
      break;
    case 'Button':
      if (typeof node.label !== 'string') {
        errors.push({ path: `${path}.label`, code: 'required', message: 'Button.label is required.' });
      }
      if (typeof node.command !== 'string') {
        errors.push({ path: `${path}.command`, code: 'required', message: 'Button.command is required.' });
      }
      break;
    case 'Table':
      if (typeof node.data !== 'string') {
        errors.push({ path: `${path}.data`, code: 'required', message: 'Table.data is required.' });
      }
      if (!Array.isArray(node.columns) || node.columns.length === 0) {
        errors.push({ path: `${path}.columns`, code: 'required', message: 'Table.columns must be a non-empty array.' });
      }
      break;
    case 'Chart':
      if (!['bar', 'line', 'pie'].includes(String(node.variant))) {
        errors.push({ path: `${path}.variant`, code: 'invalid_value', message: 'Chart.variant must be bar / line / pie.' });
      }
      if (typeof node.data !== 'string') {
        errors.push({ path: `${path}.data`, code: 'required', message: 'Chart.data is required.' });
      }
      break;
    case 'Markdown':
      if (typeof node.content !== 'string') {
        errors.push({ path: `${path}.content`, code: 'required', message: 'Markdown.content is required.' });
      }
      break;
    case 'Tabs':
      validateTabs(node.tabs, `${path}.tabs`, errors, depth);
      break;
    case 'EmptyState':
      if (typeof node.heading !== 'string') {
        errors.push({ path: `${path}.heading`, code: 'required', message: 'EmptyState.heading is required.' });
      }
      break;
    case 'ErrorBanner':
      if (typeof node.message !== 'string') {
        errors.push({ path: `${path}.message`, code: 'required', message: 'ErrorBanner.message is required.' });
      }
      break;
    case 'EntityList':
      if (typeof node.data !== 'string' || typeof node.idField !== 'string') {
        errors.push({ path: `${path}`, code: 'required', message: 'EntityList requires data + idField.' });
      }
      break;
    case 'Tree':
      if (typeof node.data !== 'string' || typeof node.labelField !== 'string' || typeof node.childrenField !== 'string') {
        errors.push({ path, code: 'required', message: 'Tree requires data + labelField + childrenField.' });
      }
      break;
    case 'KeyValueGrid':
      if (!Array.isArray(node.rows)) {
        errors.push({ path: `${path}.rows`, code: 'required', message: 'KeyValueGrid.rows must be an array.' });
      }
      break;
    // Separator / Spinner — no required fields.
  }
}

function validateChildren(
  children: unknown,
  path: string,
  errors: ValidationError[],
  depth: number,
): void {
  if (!Array.isArray(children)) {
    errors.push({ path, code: 'required', message: `${path} must be an array of widgets.` });
    return;
  }
  children.forEach((child, i) => walkValidate(child, `${path}[${i}]`, errors, depth + 1));
}

function validateTabs(
  tabs: unknown,
  path: string,
  errors: ValidationError[],
  depth: number,
): void {
  if (!Array.isArray(tabs) || tabs.length === 0) {
    errors.push({ path, code: 'required', message: `${path} must be a non-empty array.` });
    return;
  }
  tabs.forEach((tab, i) => {
    if (!isPlainObject(tab)) {
      errors.push({ path: `${path}[${i}]`, code: 'type_mismatch', message: 'Each tab must be an object.' });
      return;
    }
    if (typeof tab.id !== 'string' || typeof tab.label !== 'string') {
      errors.push({ path: `${path}[${i}]`, code: 'required', message: 'tab requires id + label strings.' });
    }
    validateChildren(tab.children, `${path}[${i}].children`, errors, depth + 1);
  });
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

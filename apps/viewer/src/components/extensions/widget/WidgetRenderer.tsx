/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Widget DSL renderer.
 *
 * Walks a WidgetNode tree and emits matching React components. Data
 * bindings (`"$.foo.bar"` or `"foo.bar"`) resolve against the state
 * object the widget's handler returned.
 *
 * The renderer is intentionally minimal — chrome only, no inline
 * styles, no client-defined CSS. Themes come from the host's Tailwind
 * tokens; variants/tones get mapped at the leaf.
 *
 * This file holds the dispatcher, the binding helpers (`resolveBinding`/
 * `asArray`, exported for `WidgetRendererNodes.tsx` to reuse), and the
 * structural/simple leaf kinds (`Stack`, `Group`, `Text`, `Field`,
 * `Button`). The kinds with real per-row rendering logic (`Table`,
 * `Chart`, `Markdown`, `Tabs`, `EmptyState`, `Spinner`, `ErrorBanner`,
 * `EntityList`, `Tree`, `KeyValueGrid`) live in `WidgetRendererNodes.tsx`
 * — split out under #4918 to keep this file under the ~400
 * non-generated-line house rule; both files are the same DSL renderer.
 *
 * Spec: docs/architecture/ai-customization/03-ui-surface.md §3.
 */

import type {
  ButtonNode,
  FieldNode,
  GroupNode,
  StackNode,
  TextNode,
  WidgetNode,
} from '@ifc-lite/extensions';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Separator } from '@/components/ui/separator';
import { cn } from '@/lib/utils';
import {
  RenderChart,
  RenderEmptyState,
  RenderEntityList,
  RenderErrorBanner,
  RenderKeyValueGrid,
  RenderMarkdown,
  RenderSpinner,
  RenderTable,
  RenderTabs,
  RenderTree,
  UnknownNode,
} from './WidgetRendererNodes';

export interface WidgetRendererContext {
  /** State object the handler returned (provides data-binding values). */
  state: unknown;
  /** Invoke an extension command. The host dispatcher implementation. */
  invokeCommand?: (commandId: string, args?: Record<string, unknown>) => void;
}

interface WidgetRendererProps {
  node: WidgetNode;
  ctx: WidgetRendererContext;
}

export function WidgetRenderer({ node, ctx }: WidgetRendererProps) {
  switch (node.type) {
    case 'Stack': return <RenderStack node={node} ctx={ctx} />;
    case 'Group': return <RenderGroup node={node} ctx={ctx} />;
    case 'Text': return <RenderText node={node} ctx={ctx} />;
    case 'Field': return <RenderField node={node} ctx={ctx} />;
    case 'Button': return <RenderButton node={node} ctx={ctx} />;
    case 'Table': return <RenderTable node={node} ctx={ctx} />;
    case 'Chart': return <RenderChart node={node} ctx={ctx} />;
    case 'Markdown': return <RenderMarkdown node={node} ctx={ctx} />;
    case 'Tabs': return <RenderTabs node={node} ctx={ctx} />;
    case 'Separator': return <Separator className="my-2" />;
    case 'EmptyState': return <RenderEmptyState node={node} ctx={ctx} />;
    case 'Spinner': return <RenderSpinner node={node} />;
    case 'ErrorBanner': return <RenderErrorBanner node={node} ctx={ctx} />;
    case 'EntityList': return <RenderEntityList node={node} ctx={ctx} />;
    case 'Tree': return <RenderTree node={node} ctx={ctx} />;
    case 'KeyValueGrid': return <RenderKeyValueGrid node={node} />;
    default:
      return <UnknownNode node={node as { type?: string }} />;
  }
}

// ---------------------------------------------------------------------------
// Bindings
// ---------------------------------------------------------------------------

/** Resolve a binding expression against the state. */
export function resolveBinding(binding: string, state: unknown): unknown {
  const path = binding.replace(/^\$\.?/, '');
  if (!path) return state;
  let cursor: unknown = state;
  for (const segment of path.split('.')) {
    if (cursor === null || cursor === undefined) return undefined;
    if (typeof cursor !== 'object') return undefined;
    cursor = (cursor as Record<string, unknown>)[segment];
  }
  return cursor;
}

export function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

// ---------------------------------------------------------------------------
// Structural / simple leaf node renderers
// ---------------------------------------------------------------------------

function RenderStack({ node, ctx }: { node: StackNode; ctx: WidgetRendererContext }) {
  const direction = node.direction === 'horizontal' ? 'flex-row' : 'flex-col';
  const gap = node.gap === 'lg' ? 'gap-4' : node.gap === 'sm' ? 'gap-1' : node.gap === 'none' ? 'gap-0' : 'gap-2';
  const align = node.align === 'center' ? 'items-center' : node.align === 'end' ? 'items-end' : node.align === 'stretch' ? 'items-stretch' : 'items-start';
  const justify = node.justify === 'center' ? 'justify-center' : node.justify === 'end' ? 'justify-end' : node.justify === 'between' ? 'justify-between' : 'justify-start';
  return (
    <div className={cn('flex', direction, gap, align, justify)}>
      {node.children.map((child, i) => (
        <WidgetRenderer key={i} node={child} ctx={ctx} />
      ))}
    </div>
  );
}

function RenderGroup({ node, ctx }: { node: GroupNode; ctx: WidgetRendererContext }) {
  return (
    <fieldset className="rounded-md border p-3">
      {node.title && <legend className="text-xs font-semibold px-1">{node.title}</legend>}
      <div className="flex flex-col gap-2">
        {node.children.map((child, i) => (
          <WidgetRenderer key={i} node={child} ctx={ctx} />
        ))}
      </div>
    </fieldset>
  );
}

function RenderText({ node }: { node: TextNode; ctx: WidgetRendererContext }) {
  const variant = node.variant === 'heading' ? 'text-base font-semibold' : node.variant === 'caption' ? 'text-xs text-muted-foreground' : 'text-sm';
  const tone = node.tone === 'error' ? 'text-destructive' : node.tone === 'warn' ? 'text-amber-600 dark:text-amber-400' : node.tone === 'success' ? 'text-emerald-600 dark:text-emerald-400' : node.tone === 'info' ? 'text-sky-600 dark:text-sky-400' : node.tone === 'muted' ? 'text-muted-foreground' : '';
  return <p className={cn(variant, tone)}>{node.text}</p>;
}

function RenderField({ node, ctx }: { node: FieldNode; ctx: WidgetRendererContext }) {
  const value = resolveBinding(node.binding, ctx.state);
  // Read-only render for v1 — Field's `binding` reflects state, and
  // the handler decides how to update state on re-run via the
  // command dispatcher. Inline editing without a host write-back path
  // would imply an unenforced state contract.
  switch (node.variant) {
    case 'boolean':
      return (
        <div className="flex items-center gap-2">
          <Switch checked={Boolean(value)} disabled aria-label={node.label} />
          <span className="text-xs">{node.label}</span>
        </div>
      );
    case 'number':
    case 'text':
    default:
      return (
        <div className="flex flex-col gap-1">
          <Label className="text-2xs">{node.label}</Label>
          <Input
            value={value === undefined || value === null ? '' : String(value)}
            readOnly
            placeholder={node.placeholder}
            aria-label={node.label}
          />
        </div>
      );
  }
}

function RenderButton({ node, ctx }: { node: ButtonNode; ctx: WidgetRendererContext }) {
  const variantMap = {
    primary: 'default',
    secondary: 'secondary',
    destructive: 'destructive',
    ghost: 'ghost',
  } as const;
  const variant = variantMap[node.variant ?? 'primary'];
  return (
    <Button
      variant={variant}
      disabled={Boolean(node.disabled)}
      onClick={() => ctx.invokeCommand?.(node.command, node.args as Record<string, unknown> | undefined)}
    >
      {node.label}
    </Button>
  );
}

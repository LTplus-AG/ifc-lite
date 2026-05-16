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
 * Spec: docs/architecture/ai-customization/03-ui-surface.md §3.
 */

import { useMemo } from 'react';
import { AlertCircle, ChevronDown, ChevronRight, Loader2 } from 'lucide-react';
import type {
  ButtonNode,
  ChartNode,
  EmptyStateNode,
  EntityListNode,
  ErrorBannerNode,
  FieldNode,
  GroupNode,
  KeyValueGridNode,
  MarkdownNode,
  SpinnerNode,
  StackNode,
  TableNode,
  TabsNode,
  TextNode,
  TreeNode,
  WidgetNode,
} from '@ifc-lite/extensions';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Separator } from '@/components/ui/separator';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { ScrollArea } from '@/components/ui/scroll-area';
import { cn } from '@/lib/utils';

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
    case 'Spinner': return <RenderSpinner node={node} ctx={ctx} />;
    case 'ErrorBanner': return <RenderErrorBanner node={node} ctx={ctx} />;
    case 'EntityList': return <RenderEntityList node={node} ctx={ctx} />;
    case 'Tree': return <RenderTree node={node} ctx={ctx} />;
    case 'KeyValueGrid': return <RenderKeyValueGrid node={node} ctx={ctx} />;
    default:
      return <UnknownNode node={node as { type?: string }} />;
  }
}

// ---------------------------------------------------------------------------
// Bindings
// ---------------------------------------------------------------------------

/** Resolve a binding expression against the state. */
function resolveBinding(binding: string, state: unknown): unknown {
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

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

// ---------------------------------------------------------------------------
// Node renderers
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
          <Label className="text-[11px]">{node.label}</Label>
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

function RenderTable({ node, ctx }: { node: TableNode; ctx: WidgetRendererContext }) {
  const rows = asArray(resolveBinding(node.data, ctx.state));
  if (rows.length === 0) {
    return <div className="text-xs text-muted-foreground italic px-2 py-3">No rows</div>;
  }
  return (
    <ScrollArea className="max-h-72 rounded-md border">
      <table className="w-full text-xs">
        <thead className="border-b bg-muted/40 sticky top-0">
          <tr>
            {node.columns.map((c, i) => (
              <th
                key={i}
                className={cn('px-2 py-1.5 text-left font-medium', c.align === 'right' && 'text-right', c.align === 'center' && 'text-center')}
                style={c.width ? { width: c.width } : undefined}
              >
                {c.title}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i} className="border-b last:border-0">
              {node.columns.map((c, j) => {
                const cell = (row as Record<string, unknown>)?.[c.field];
                return (
                  <td
                    key={j}
                    className={cn('px-2 py-1', c.align === 'right' && 'text-right', c.align === 'center' && 'text-center')}
                  >
                    {cell === null || cell === undefined ? '' : String(cell)}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </ScrollArea>
  );
}

function RenderChart({ node, ctx }: { node: ChartNode; ctx: WidgetRendererContext }) {
  // Lightweight ASCII-bar chart for v1. Avoids pulling in a chart lib.
  // Real charting can swap this implementation later without changing
  // the DSL.
  const rows = asArray(resolveBinding(node.data, ctx.state));
  const xField = node.xField ?? 'label';
  const yField = node.yField ?? 'value';
  const max = useMemo(() => {
    let m = 0;
    for (const row of rows) {
      const v = Number((row as Record<string, unknown>)[yField] ?? 0);
      if (Number.isFinite(v) && v > m) m = v;
    }
    return m || 1;
  }, [rows, yField]);
  return (
    <div className="rounded-md border p-3 space-y-1.5">
      <div className="text-[11px] text-muted-foreground">{node.variant} chart</div>
      {rows.map((row, i) => {
        const label = String((row as Record<string, unknown>)[xField] ?? '');
        const v = Number((row as Record<string, unknown>)[yField] ?? 0);
        const pct = (Math.max(0, v) / max) * 100;
        return (
          <div key={i} className="text-xs">
            <div className="flex items-center justify-between mb-0.5">
              <span className="truncate">{label}</span>
              <span className="text-muted-foreground tabular-nums">{v}</span>
            </div>
            <div className="h-1.5 bg-muted rounded">
              <div className="h-1.5 bg-primary rounded" style={{ width: `${pct}%` }} />
            </div>
          </div>
        );
      })}
    </div>
  );
}

function RenderMarkdown({ node }: { node: MarkdownNode; ctx: WidgetRendererContext }) {
  // We render plain text only — no HTML, no parser. This preserves
  // the "host renders chrome" invariant; rich markdown ships when
  // we adopt a sanitising renderer in the host.
  return <div className="text-xs whitespace-pre-wrap leading-relaxed">{node.content}</div>;
}

function RenderTabs({ node, ctx }: { node: TabsNode; ctx: WidgetRendererContext }) {
  const first = node.defaultTab ?? node.tabs[0]?.id;
  return (
    <Tabs defaultValue={first}>
      <TabsList>
        {node.tabs.map((tab) => (
          <TabsTrigger key={tab.id} value={tab.id}>
            {tab.label}
          </TabsTrigger>
        ))}
      </TabsList>
      {node.tabs.map((tab) => (
        <TabsContent key={tab.id} value={tab.id}>
          <div className="flex flex-col gap-2">
            {tab.children.map((child, i) => (
              <WidgetRenderer key={i} node={child} ctx={ctx} />
            ))}
          </div>
        </TabsContent>
      ))}
    </Tabs>
  );
}

function RenderEmptyState({ node, ctx }: { node: EmptyStateNode; ctx: WidgetRendererContext }) {
  return (
    <div className="flex flex-col items-center gap-2 py-8 text-center">
      <div className="text-sm font-medium">{node.heading}</div>
      {node.body && <div className="text-xs text-muted-foreground max-w-md">{node.body}</div>}
      {node.cta && (
        <Button size="sm" onClick={() => ctx.invokeCommand?.(node.cta!.command)}>
          {node.cta.label}
        </Button>
      )}
    </div>
  );
}

function RenderSpinner({ node }: { node: SpinnerNode; ctx: WidgetRendererContext }) {
  return (
    <div className="flex items-center gap-2 text-xs text-muted-foreground">
      <Loader2 className="h-3 w-3 animate-spin" />
      {node.label && <span>{node.label}</span>}
    </div>
  );
}

function RenderErrorBanner({ node, ctx }: { node: ErrorBannerNode; ctx: WidgetRendererContext }) {
  return (
    <div className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs">
      <AlertCircle className="h-3.5 w-3.5 text-destructive mt-0.5 shrink-0" />
      <div className="flex-1">
        <div className="text-destructive">{node.message}</div>
        {node.retryCommand && (
          <Button size="sm" variant="ghost" className="mt-1 h-7 px-2" onClick={() => ctx.invokeCommand?.(node.retryCommand!)}>
            Retry
          </Button>
        )}
      </div>
    </div>
  );
}

function RenderEntityList({ node, ctx }: { node: EntityListNode; ctx: WidgetRendererContext }) {
  const rows = asArray(resolveBinding(node.data, ctx.state));
  return (
    <ul className="divide-y rounded-md border">
      {rows.length === 0 && (
        <li className="px-2 py-3 text-xs text-muted-foreground italic">No entities</li>
      )}
      {rows.map((row, i) => {
        const r = row as Record<string, unknown>;
        const id = String(r[node.idField] ?? '');
        const label = node.labelField ? String(r[node.labelField] ?? id) : id;
        return (
          <li key={`${id}-${i}`} className="px-2 py-1.5 text-xs font-mono break-all">
            {label}
          </li>
        );
      })}
    </ul>
  );
}

interface TreeNodeData {
  [key: string]: unknown;
}

function RenderTree({ node, ctx }: { node: TreeNode; ctx: WidgetRendererContext }) {
  const roots = asArray(resolveBinding(node.data, ctx.state));
  return (
    <ul className="text-xs">
      {roots.map((root, i) => (
        <TreeItem key={i} node={root as TreeNodeData} labelField={node.labelField} childrenField={node.childrenField} depth={0} />
      ))}
    </ul>
  );
}

function TreeItem({ node, labelField, childrenField, depth }: {
  node: TreeNodeData;
  labelField: string;
  childrenField: string;
  depth: number;
}) {
  const label = String(node[labelField] ?? '');
  const children = asArray(node[childrenField]);
  return (
    <li>
      <div className="flex items-center gap-1 py-0.5" style={{ paddingLeft: depth * 12 }}>
        {children.length > 0 ? <ChevronDown className="h-3 w-3 shrink-0" /> : <ChevronRight className="h-3 w-3 shrink-0 invisible" />}
        <span className="truncate">{label}</span>
      </div>
      {children.length > 0 && (
        <ul>
          {children.map((child, i) => (
            <TreeItem
              key={i}
              node={child as TreeNodeData}
              labelField={labelField}
              childrenField={childrenField}
              depth={depth + 1}
            />
          ))}
        </ul>
      )}
    </li>
  );
}

function RenderKeyValueGrid({ node }: { node: KeyValueGridNode; ctx: WidgetRendererContext }) {
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
      {node.rows.map((row, i) => (
        <div key={i} className="contents">
          <dt className="text-muted-foreground">{row.label}</dt>
          <dd className="break-all">{row.value}</dd>
        </div>
      ))}
    </dl>
  );
}

function UnknownNode({ node }: { node: { type?: string } }) {
  return (
    <div className="text-xs text-destructive italic px-2 py-1">
      Unknown widget node: <code>{String(node.type ?? '?')}</code>
    </div>
  );
}

/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Widget DSL renderer — data-driven node kinds.
 *
 * Split out of `WidgetRenderer.tsx` (#4918: converting that file's own
 * chrome strings to `t()` pushed it over the ~400 non-generated-line
 * house rule). `WidgetRenderer.tsx` keeps the dispatcher, the binding
 * helpers (`resolveBinding`/`asArray`, exported from there and reused
 * here), and the structural/simple leaf kinds (`Stack`, `Group`, `Text`,
 * `Field`, `Button`); this file has the kinds with real per-row rendering
 * logic: `Table`, `Chart`, `Markdown`, `Tabs`, `EmptyState`, `Spinner`,
 * `ErrorBanner`, `EntityList`, `Tree`, `KeyValueGrid`, plus the
 * `UnknownNode` fallback. Both files are the same DSL renderer; this is a
 * file-size split, not a scope split.
 *
 * Spec: docs/architecture/ai-customization/03-ui-surface.md §3.
 */

import { useMemo } from 'react';
import { AlertCircle, ChevronDown, ChevronRight } from 'lucide-react';
import { Spinner } from '@/components/ui/spinner';
import type {
  ChartNode,
  EmptyStateNode,
  EntityListNode,
  ErrorBannerNode,
  KeyValueGridNode,
  MarkdownNode,
  SpinnerNode,
  TableNode,
  TabsNode,
  TreeNode,
} from '@ifc-lite/extensions';
import { Button } from '@/components/ui/button';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { ScrollArea } from '@/components/ui/scroll-area';
import { useTranslation, type UseTranslationResult } from '@/i18n';
import { cn } from '@/lib/utils';
import { WidgetRenderer, asArray, resolveBinding, type WidgetRendererContext } from './WidgetRenderer';

export function RenderTable({ node, ctx }: { node: TableNode; ctx: WidgetRendererContext }) {
  const { t } = useTranslation();
  const rows = asArray(resolveBinding(node.data, ctx.state));
  if (rows.length === 0) {
    return (
      <div className="text-xs text-muted-foreground italic px-2 py-3">
        {t('extensionsPanels.widgetRenderer.noRows')}
      </div>
    );
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

export function RenderChart({ node, ctx }: { node: ChartNode; ctx: WidgetRendererContext }) {
  // Lightweight ASCII-bar chart for v1. Avoids pulling in a chart lib.
  // Real charting can swap this implementation later without changing
  // the DSL.
  const { t } = useTranslation();
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
      <div className="text-2xs text-muted-foreground">
        {t('extensionsPanels.widgetRenderer.chartLabel', {
          variant: localizedChartVariant(node.variant, t),
        })}
      </div>
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

function localizedChartVariant(
  variant: ChartNode['variant'],
  t: UseTranslationResult['t'],
): string {
  switch (variant) {
    case 'bar':
      return t('extensionsPanels.widgetRenderer.chartVariant.bar');
    case 'line':
      return t('extensionsPanels.widgetRenderer.chartVariant.line');
    case 'pie':
      return t('extensionsPanels.widgetRenderer.chartVariant.pie');
    default: {
      const exhaustive: never = variant;
      return exhaustive;
    }
  }
}

export function RenderMarkdown({ node }: { node: MarkdownNode; ctx: WidgetRendererContext }) {
  // We render plain text only — no HTML, no parser. This preserves
  // the "host renders chrome" invariant; rich markdown ships when
  // we adopt a sanitising renderer in the host.
  return <div className="text-xs whitespace-pre-wrap leading-relaxed">{node.content}</div>;
}

export function RenderTabs({ node, ctx }: { node: TabsNode; ctx: WidgetRendererContext }) {
  const first = node.tabs.some(tab => tab.id === node.defaultTab) ? node.defaultTab : node.tabs[0]?.id;
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

export function RenderEmptyState({ node, ctx }: { node: EmptyStateNode; ctx: WidgetRendererContext }) {
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

export function RenderSpinner({ node }: { node: SpinnerNode }) {
  return (
    <div className="flex items-center gap-2 text-xs text-muted-foreground">
      <Spinner size="xs" />
      {node.label && <span>{node.label}</span>}
    </div>
  );
}

export function RenderErrorBanner({ node, ctx }: { node: ErrorBannerNode; ctx: WidgetRendererContext }) {
  const { t } = useTranslation();
  return (
    <div className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs">
      <AlertCircle className="h-3.5 w-3.5 text-destructive mt-0.5 shrink-0" />
      <div className="flex-1">
        <div className="text-destructive">{node.message}</div>
        {node.retryCommand && (
          <Button size="sm" variant="ghost" className="mt-1 h-7 px-2" onClick={() => ctx.invokeCommand?.(node.retryCommand!)}>
            {t('extensionsPanels.widgetRenderer.retryButton')}
          </Button>
        )}
      </div>
    </div>
  );
}

export function RenderEntityList({ node, ctx }: { node: EntityListNode; ctx: WidgetRendererContext }) {
  const { t } = useTranslation();
  const rows = asArray(resolveBinding(node.data, ctx.state));
  return (
    <ul className="divide-y rounded-md border">
      {rows.length === 0 && (
        <li className="px-2 py-3 text-xs text-muted-foreground italic">
          {t('extensionsPanels.widgetRenderer.noEntities')}
        </li>
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

export function RenderTree({ node, ctx }: { node: TreeNode; ctx: WidgetRendererContext }) {
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

export function RenderKeyValueGrid({ node }: { node: KeyValueGridNode }) {
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

export function UnknownNode({ node }: { node: { type?: string } }) {
  const { t } = useTranslation();
  return (
    <div className="text-xs text-destructive italic px-2 py-1">
      {t('extensionsPanels.widgetRenderer.unknownNodeLabel', { type: String(node.type ?? '?') })}
    </div>
  );
}

/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Basic-catalog layout and text components, rendered on the viewer's own
 * primitives and tokens (the upstream basic catalog ships Lit elements with
 * their own styling, which we do not use).
 */

import type { ReactNode } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { createComponentImplementation, type ReactA2uiComponentProps } from '@a2ui/react';
import { CardApi, ColumnApi, DividerApi, ListApi, RowApi, TabsApi, TextApi } from '@a2ui/web_core/v1_0';
import { Separator } from '@/components/ui/separator';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { cn } from '@/lib/utils';

type ChildRef = string | { id: string; basePath?: string };
type BuildChild = ReactA2uiComponentProps<unknown>['buildChild'];

function renderChildren(children: unknown, buildChild: BuildChild): ReactNode[] {
  if (!Array.isArray(children)) return [];
  return (children as ChildRef[]).map((child, i) => {
    const id = typeof child === 'string' ? child : child.id;
    const basePath = typeof child === 'string' ? undefined : child.basePath;
    return <div key={`${id}:${basePath ?? i}`} className="contents">{buildChild(id, basePath)}</div>;
  });
}

/** Flex-grow for a child with `weight`, the A2UI equivalent of CSS flex-grow. */
export function weightStyle(weight: unknown): React.CSSProperties | undefined {
  return typeof weight === 'number' && weight > 0 ? { flexGrow: weight, flexBasis: 0, minWidth: 0 } : undefined;
}

/**
 * Markdown without raw HTML, images or links: surfaces are data, and a model
 * must not be able to put a clickable URL or a tracking pixel in front of the user.
 */
const MARKDOWN_COMPONENTS = {
  a: ({ children }: { children?: ReactNode }) => <span className="underline decoration-dotted">{children}</span>,
  img: () => null,
  p: ({ children }: { children?: ReactNode }) => <p className="my-1">{children}</p>,
  ul: ({ children }: { children?: ReactNode }) => <ul className="my-1 list-disc pl-5">{children}</ul>,
  ol: ({ children }: { children?: ReactNode }) => <ol className="my-1 list-decimal pl-5">{children}</ol>,
  code: ({ children }: { children?: ReactNode }) => <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs">{children}</code>,
};

export function SafeMarkdown({ text, className }: { text: string; className?: string }) {
  return (
    <div className={cn('text-sm leading-relaxed [&_h1]:text-base [&_h1]:font-semibold [&_h2]:text-sm [&_h2]:font-semibold [&_h3]:font-semibold', className)}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml components={MARKDOWN_COMPONENTS}>{text}</ReactMarkdown>
    </div>
  );
}

const JUSTIFY: Record<string, string> = {
  start: 'justify-start', center: 'justify-center', end: 'justify-end', spaceBetween: 'justify-between',
  spaceAround: 'justify-around', spaceEvenly: 'justify-evenly', stretch: 'justify-stretch',
};
const ALIGN: Record<string, string> = { start: 'items-start', center: 'items-center', end: 'items-end', stretch: 'items-stretch' };

export const TextImpl = createComponentImplementation(TextApi, ({ props }) => (
  <div style={weightStyle(props.weight)} className={cn(props.variant === 'caption' && 'text-xs text-muted-foreground')}>
    <SafeMarkdown text={String(props.text ?? '')} />
  </div>
));

export const RowImpl = createComponentImplementation(RowApi, ({ props, buildChild }) => (
  <div style={weightStyle(props.weight)} className={cn('flex flex-row flex-wrap gap-2', JUSTIFY[props.justify ?? 'start'], ALIGN[props.align ?? 'stretch'])}>
    {renderChildren(props.children, buildChild)}
  </div>
));

export const ColumnImpl = createComponentImplementation(ColumnApi, ({ props, buildChild }) => (
  <div style={weightStyle(props.weight)} className={cn('flex min-w-0 flex-col gap-2', JUSTIFY[props.justify ?? 'start'], ALIGN[props.align ?? 'stretch'])}>
    {renderChildren(props.children, buildChild)}
  </div>
));

export const ListImpl = createComponentImplementation(ListApi, ({ props, buildChild }) => (
  <ul
    style={weightStyle(props.weight)}
    className={cn('flex gap-1.5', props.direction === 'horizontal' ? 'flex-row overflow-x-auto' : 'flex-col', ALIGN[props.align ?? 'stretch'])}
  >
    {renderChildren(props.children, buildChild).map((child, i) => <li key={i}>{child}</li>)}
  </ul>
));

export const CardImpl = createComponentImplementation(CardApi, ({ props, buildChild }) => (
  <div style={weightStyle(props.weight)} className="rounded-lg border bg-card p-3 text-card-foreground shadow-sm">
    {typeof props.child === 'string' ? buildChild(props.child) : null}
  </div>
));

export const DividerImpl = createComponentImplementation(DividerApi, ({ props }) => (
  <Separator orientation={props.axis === 'vertical' ? 'vertical' : 'horizontal'} className={props.axis === 'vertical' ? 'mx-1 h-auto self-stretch' : 'my-1'} />
));

export const TabsImpl = createComponentImplementation(TabsApi, ({ props, buildChild }) => {
  const tabs = Array.isArray(props.tabs) ? props.tabs : [];
  if (tabs.length === 0) return null;
  return (
    <Tabs defaultValue="0" style={weightStyle(props.weight)} className="min-w-0">
      <TabsList scrollable className="max-w-full">
        {tabs.map((tab, i) => <TabsTrigger key={i} value={String(i)}>{String(tab.title ?? '')}</TabsTrigger>)}
      </TabsList>
      {tabs.map((tab, i) => (
        <TabsContent key={i} value={String(i)}>{typeof tab.child === 'string' ? buildChild(tab.child) : null}</TabsContent>
      ))}
    </Tabs>
  );
});

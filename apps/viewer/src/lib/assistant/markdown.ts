/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The Markdown subset assistant models actually emit (headings, paragraphs,
 * lists, pipe tables, fenced code, rules), parsed once into blocks so the
 * panel and native documents present the same structure. Model output is
 * untrusted: HTML is always escaped before inline marks are applied, and
 * nothing here produces links, images or raw HTML.
 */

export type MarkdownBlock =
  | { kind: 'heading'; level: 1 | 2 | 3; text: string }
  | { kind: 'paragraph'; text: string }
  | { kind: 'list'; ordered: boolean; items: string[] }
  | { kind: 'table'; header: string[]; rows: string[][] }
  | { kind: 'code'; text: string }
  | { kind: 'rule' };

const FENCE = /^\s*```/;
const HEADING = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const BULLET = /^\s*[-*+•]\s+(.*)$/;
const ORDERED = /^\s*\d+[.)]\s+(.*)$/;
const RULE = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/;
const TABLE_ROW = /^\s*\|.*\|\s*$/;
const TABLE_SEPARATOR = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;

function cells(line: string): string[] {
  return line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(cell => cell.trim());
}

export function parseMarkdown(source: string): MarkdownBlock[] {
  const lines = source.replace(/\r\n?/g, '\n').split('\n');
  const blocks: MarkdownBlock[] = [];
  let paragraph: string[] = [];
  const flush = () => {
    if (paragraph.length) blocks.push({ kind: 'paragraph', text: paragraph.join('\n') });
    paragraph = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (FENCE.test(line)) {
      flush();
      const code: string[] = [];
      for (i++; i < lines.length && !FENCE.test(lines[i]); i++) code.push(lines[i]);
      blocks.push({ kind: 'code', text: code.join('\n') });
      continue;
    }
    if (!line.trim()) { flush(); continue; }
    const heading = HEADING.exec(line);
    if (heading) {
      flush();
      blocks.push({ kind: 'heading', level: Math.min(heading[1].length, 3) as 1 | 2 | 3, text: heading[2] });
      continue;
    }
    if (TABLE_ROW.test(line) && i + 1 < lines.length && TABLE_SEPARATOR.test(lines[i + 1])) {
      flush();
      const header = cells(line);
      const rows: string[][] = [];
      for (i += 2; i < lines.length && TABLE_ROW.test(lines[i]); i++) rows.push(cells(lines[i]));
      i--;
      blocks.push({ kind: 'table', header, rows });
      continue;
    }
    if (RULE.test(line)) { flush(); blocks.push({ kind: 'rule' }); continue; }
    const bullet = BULLET.exec(line), ordered = ORDERED.exec(line);
    if (bullet || ordered) {
      flush();
      const isOrdered = !bullet;
      const items: string[] = [];
      for (; i < lines.length; i++) {
        const item = (isOrdered ? ORDERED : BULLET).exec(lines[i]);
        if (item) { items.push(item[1]); continue; }
        // Indented continuation lines belong to the previous item.
        if (lines[i].trim() && /^\s{2,}/.test(lines[i]) && items.length) { items[items.length - 1] += ` ${lines[i].trim()}`; continue; }
        break;
      }
      i--;
      blocks.push({ kind: 'list', ordered: isOrdered, items });
      continue;
    }
    paragraph.push(line.trim());
  }
  flush();
  return blocks;
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

const CITATION = /\[(E\d{1,4})\]/g;

/** Escaped inline HTML; `[E12]` becomes a citation chip the panel can act on. */
export function inlineHtml(text: string): string {
  return escapeHtml(text)
    .replace(/`([^`]+)`/g, '<code class="rounded bg-muted px-1 py-0.5 font-mono">$1</code>')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\s][^*]*?)\*(?!\*)/g, '$1<em>$2</em>')
    .replace(CITATION, '<button type="button" data-citation="$1" class="mx-px inline-flex items-center rounded border border-primary/30 bg-primary/5 px-1 font-mono text-2xs leading-tight text-primary hover:bg-primary/15 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring">$1</button>')
    .replace(/\n/g, '<br/>');
}

export function markdownHtml(source: string): string {
  return parseMarkdown(source).map(block => {
    switch (block.kind) {
      case 'heading': return `<p class="mt-2 mb-1 font-semibold ${block.level === 1 ? 'text-sm' : 'text-xs'}">${inlineHtml(block.text)}</p>`;
      case 'paragraph': return `<p class="my-1.5">${inlineHtml(block.text)}</p>`;
      case 'list': return `<${block.ordered ? 'ol' : 'ul'} class="my-1.5 space-y-0.5 pl-4 ${block.ordered ? 'list-decimal' : 'list-disc'}">${
        block.items.map(item => `<li>${inlineHtml(item)}</li>`).join('')}</${block.ordered ? 'ol' : 'ul'}>`;
      case 'table': return `<div class="my-1.5 overflow-x-auto"><table class="w-full border-collapse"><thead><tr>${
        block.header.map(cell => `<th class="border-b border-border px-1.5 py-0.5 text-left font-semibold">${inlineHtml(cell)}</th>`).join('')
      }</tr></thead><tbody>${block.rows.map(row => `<tr>${row.map(cell => `<td class="border-b border-border/60 px-1.5 py-0.5 align-top">${inlineHtml(cell)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
      case 'code': return `<pre class="my-1.5 overflow-x-auto rounded bg-muted p-2 font-mono text-2xs">${escapeHtml(block.text)}</pre>`;
      case 'rule': return '<hr class="my-2 border-border"/>';
    }
  }).join('');
}

/** Inline marks removed for plain-text targets such as native document blocks. */
export function plainInline(text: string): string {
  return text.replace(/`([^`]+)`/g, '$1').replace(/\*\*(.+?)\*\*/g, '$1').replace(/(^|[^*])\*([^*\s][^*]*?)\*(?!\*)/g, '$1$2');
}

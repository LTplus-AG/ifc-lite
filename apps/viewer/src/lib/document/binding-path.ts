/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Model selectors support escaped filenames; existing selectors retain their literal syntax (#6485). */
export interface Segment {
  name: string;
  selector?: string;
}

/** Filenames survive reloads; session model ids do not. Escape braces used by templates. */
export function modelBindingPath(modelName: string, path: string): string {
  if (path === 'Today') return path;
  const selector = JSON.stringify(modelName).replace(/\{/g, '\\u007b').replace(/\}/g, '\\u007d');
  return `Model[${selector}].${path.startsWith('Model.') ? path.slice(6) : path}`;
}

export function parsePath(path: string): Segment[] | null {
  const segments: Segment[] = [];
  let i = 0;
  while (i < path.length) {
    const start = i;
    while (i < path.length && path[i] !== '.' && path[i] !== '[') i++;
    if (i === start) return null;
    const segment: Segment = { name: path.slice(start, i) };
    if (path[i] === '[') {
      if (segment.name !== 'Model') {
        // Saved spatial/element selectors predate JSON quoting; their backslashes are literal.
        const close = path.indexOf(']', i + 1);
        if (close === -1) return null;
        const raw = path.slice(i + 1, close).trim();
        segment.selector = (raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'")) ? raw.slice(1, -1) : raw;
        i = close;
      } else {
        const selectorStart = ++i;
        let quote = '';
        let escaped = false;
        for (; i < path.length; i++) {
          const char = path[i];
          if (escaped) { escaped = false; continue; }
          if (quote) {
            if (char === '\\') escaped = true;
            else if (char === quote) quote = '';
          } else if (char === '"' || char === "'") quote = char;
          else if (char === ']') break;
        }
        if (i === path.length) return null;
        const raw = path.slice(selectorStart, i).trim();
        if (raw.startsWith('"')) {
          try {
            const value: unknown = JSON.parse(raw);
            if (typeof value !== 'string') return null;
            segment.selector = value;
          } catch {
            return null; // Invalid quoted selectors are a malformed path, not a load failure.
          }
        } else if (raw.startsWith("'")) {
          if (!raw.endsWith("'")) return null;
          segment.selector = raw.slice(1, -1).replace(/\\(['\\])/g, '$1');
        } else segment.selector = raw;
      }
      i++;
    }
    segments.push(segment);
    if (i < path.length) {
      if (path[i] !== '.') return null;
      i++; // Keep the existing parser's tolerance for a trailing separator in saved fields.
    }
  }
  return segments;
}

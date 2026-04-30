/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Minimal XML parser — works in dedicated Web Workers where DOMParser
 * isn't available.
 *
 * Scope: well-formed XML produced by E57 writers (Faro, Leica, Trimble,
 * generic exporters). Specifically:
 *   - Open + close tag pairs and self-closing tags
 *   - Double-quoted attribute values (E57 always uses double quotes)
 *   - Element text content (no mixed content; XML declaration + DOCTYPE
 *     + comments + CDATA are skipped)
 *   - Standard XML entities (&amp; &lt; &gt; &quot; &apos;)
 *
 * NOT a full XML 1.0 implementation — it's deliberately just enough for
 * E57 + similar shallow, attribute-heavy formats. Keeps the worker
 * bundle small (no `xmldom` dep) and avoids a per-file decode round-trip
 * back to the main thread.
 */

export interface XmlElement {
  name: string;
  attrs: Map<string, string>;
  children: XmlElement[];
  text: string;
}

/** Parse XML and return the root element. Throws on truly malformed input. */
export function parseXml(xml: string): XmlElement {
  const root: XmlElement = { name: '', attrs: new Map(), children: [], text: '' };
  const stack: XmlElement[] = [root];
  let i = 0;
  const n = xml.length;
  let textStart = -1;

  const flushText = (end: number): void => {
    if (textStart < 0 || textStart >= end) {
      textStart = -1;
      return;
    }
    const slice = xml.slice(textStart, end).trim();
    if (slice.length > 0) {
      const top = stack[stack.length - 1];
      // Only set text if the element has no element children — E57 leaf
      // values like `<guid>...</guid>` use this path.
      if (top.children.length === 0) {
        top.text = top.text + decodeEntities(slice);
      }
    }
    textStart = -1;
  };

  while (i < n) {
    const ch = xml.charCodeAt(i);
    if (ch !== 0x3c /* < */) {
      if (textStart < 0) textStart = i;
      i++;
      continue;
    }
    flushText(i);

    // Skip XML declaration <?xml ... ?>
    if (xml.startsWith('<?', i)) {
      const end = xml.indexOf('?>', i + 2);
      i = end < 0 ? n : end + 2;
      continue;
    }
    // Skip comment <!-- ... -->
    if (xml.startsWith('<!--', i)) {
      const end = xml.indexOf('-->', i + 4);
      i = end < 0 ? n : end + 3;
      continue;
    }
    // Skip CDATA — not used in E57 prototype shapes; preserve text content.
    if (xml.startsWith('<![CDATA[', i)) {
      const end = xml.indexOf(']]>', i + 9);
      const cdata = xml.slice(i + 9, end < 0 ? n : end);
      const top = stack[stack.length - 1];
      if (top.children.length === 0) top.text = top.text + cdata;
      i = end < 0 ? n : end + 3;
      continue;
    }
    // Skip DOCTYPE / other markup declarations
    if (xml.startsWith('<!', i)) {
      const end = xml.indexOf('>', i + 2);
      i = end < 0 ? n : end + 1;
      continue;
    }
    // Closing tag </name>
    if (xml.charCodeAt(i + 1) === 0x2f /* / */) {
      const end = xml.indexOf('>', i + 2);
      if (end < 0) throw new Error('XML: unterminated closing tag');
      const name = xml.slice(i + 2, end).trim();
      const top = stack[stack.length - 1];
      if (top.name !== name) {
        throw new Error(`XML: mismatched closing tag </${name}> (expected </${top.name}>)`);
      }
      stack.pop();
      i = end + 1;
      continue;
    }
    // Opening tag <name attr="..." [/]>
    const tagEnd = findTagEnd(xml, i + 1);
    if (tagEnd < 0) throw new Error('XML: unterminated tag');
    let inner = xml.slice(i + 1, tagEnd).trim();
    let selfClosing = false;
    if (inner.endsWith('/')) {
      selfClosing = true;
      inner = inner.slice(0, -1).trim();
    }
    const nameMatch = inner.match(/^([A-Za-z_][\w:.\-]*)/);
    if (!nameMatch) {
      // Unknown thing — skip past it to avoid a hang on malformed input.
      i = tagEnd + 1;
      continue;
    }
    const name = nameMatch[1];
    const attrSpan = inner.slice(name.length).trim();
    const attrs = parseAttrs(attrSpan);

    const node: XmlElement = { name, attrs, children: [], text: '' };
    if (stack.length === 1 && root.name === '') {
      // First real element becomes the root.
      root.name = name;
      root.attrs = attrs;
      // root.children/text initialised; from here on we descend through it.
      if (!selfClosing) stack.push(root);
    } else {
      stack[stack.length - 1].children.push(node);
      if (!selfClosing) stack.push(node);
    }
    i = tagEnd + 1;
  }
  flushText(n);
  return root;
}

/** Find the `>` that closes a tag, respecting `>` inside attribute values. */
function findTagEnd(xml: string, from: number): number {
  let inAttr = false;
  for (let i = from; i < xml.length; i++) {
    const c = xml.charCodeAt(i);
    if (c === 0x22 /* " */) inAttr = !inAttr;
    else if (c === 0x3e /* > */ && !inAttr) return i;
  }
  return -1;
}

const ATTR_RE = /([A-Za-z_][\w:.\-]*)\s*=\s*"([^"]*)"/g;

function parseAttrs(span: string): Map<string, string> {
  const out = new Map<string, string>();
  if (!span) return out;
  let m: RegExpExecArray | null;
  ATTR_RE.lastIndex = 0;
  while ((m = ATTR_RE.exec(span)) !== null) {
    out.set(m[1], decodeEntities(m[2]));
  }
  return out;
}

function decodeEntities(s: string): string {
  if (s.indexOf('&') < 0) return s;
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCharCode(parseInt(d, 10)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h: string) => String.fromCharCode(parseInt(h, 16)))
    // &amp; last so we don't re-decode the &-escapes above.
    .replace(/&amp;/g, '&');
}

// ─── tree helpers ───────────────────────────────────────────────────────────

export function childByName(parent: XmlElement, name: string): XmlElement | null {
  for (const c of parent.children) {
    if (c.name === name) return c;
  }
  return null;
}

export function childrenByName(parent: XmlElement, name: string): XmlElement[] {
  return parent.children.filter((c) => c.name === name);
}

export function textChild(parent: XmlElement, name: string): string | null {
  const c = childByName(parent, name);
  if (!c) return null;
  const t = c.text.trim();
  return t.length > 0 ? t : null;
}

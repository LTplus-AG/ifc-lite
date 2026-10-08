/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** XML escaping and the indented line buffer behind `writeIdsXml`. */

/** Characters XML 1.0 cannot carry, even as character references. */
// Matching control characters is the point: they are refused, not allowed through.
// eslint-disable-next-line no-control-regex
const NOT_XML = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/;

/** `field` names the element or attribute, so a refusal says what to fix. */
export function escapeXml(text: string, field: string): string {
  const bad = NOT_XML.exec(text);
  if (bad) {
    const code = bad[0].charCodeAt(0).toString(16).toUpperCase().padStart(4, '0');
    throw new Error(`writeIdsXml: ${field} contains control character U+${code}, which XML 1.0 cannot carry`);
  }
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
    // A raw CR is normalised away by every XML reader; a reference survives.
    .replace(/\r/g, '&#13;');
}

/** Attribute-value normalisation turns raw line breaks and tabs into spaces; references keep them. */
function escapeAttr(text: string, field: string): string {
  return escapeXml(text, field).replace(/\n/g, '&#10;').replace(/\t/g, '&#9;');
}

export class XmlLines {
  readonly lines: string[] = [];
  private depth = 0;

  /** `unit` is the indentation of one nesting level. */
  constructor(private readonly unit = '  ') {}

  open(tag: string, attrs: Record<string, string | undefined> = {}): void {
    this.lines.push(`${this.indent()}<${tag}${renderAttrs(tag, attrs)}>`);
    this.depth++;
  }

  close(tag: string): void {
    this.depth--;
    this.lines.push(`${this.indent()}</${tag}>`);
  }

  leaf(tag: string, text: string, attrs: Record<string, string | undefined> = {}): void {
    this.lines.push(`${this.indent()}<${tag}${renderAttrs(tag, attrs)}>${escapeXml(text, tag)}</${tag}>`);
  }

  /** An XML comment line; `--` cannot appear inside one and is refused. */
  comment(text: string): void {
    if (text.includes('--')) throw new Error('writeIdsXml: an XML comment cannot contain "--"');
    this.lines.push(`${this.indent()}<!-- ${escapeXml(text, 'comment')} -->`);
  }

  empty(tag: string, attrs: Record<string, string | undefined> = {}): void {
    this.lines.push(`${this.indent()}<${tag}${renderAttrs(tag, attrs)}/>`);
  }

  private indent(): string {
    return this.unit.repeat(this.depth);
  }
}

function renderAttrs(tag: string, attrs: Record<string, string | undefined>): string {
  let out = '';
  for (const [key, value] of Object.entries(attrs)) {
    if (value !== undefined) out += ` ${key}="${escapeAttr(value, `${tag} "${key}"`)}"`;
  }
  return out;
}

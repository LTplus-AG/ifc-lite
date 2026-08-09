/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #2323: the two ISO 10303-21 string escapes that are not backslash directives.
 *
 * A doubled apostrophe is one apostrophe and a doubled reverse solidus is one
 * reverse solidus. The apostrophe half was already collapsed here while the
 * Rust attribute path left it doubled; the backslash half was collapsed on
 * NEITHER side, so `C:\\temp` reached every consumer with the separators
 * doubled. Both paths now decode identically and are pinned to the same
 * cross-language vectors (`rust/core/tests/fixtures/ifc_string_vectors.json`).
 *
 * The escapes are spelled `\u0027` / `\u005C` in the fixtures below so the
 * count of consecutive quotes and backslashes is readable rather than guessed.
 */

import { describe, it, expect } from 'vitest';
import { parsePropertyValue } from '@ifc-lite/encoding';
import { EntityExtractor } from '../src/entity-extractor.js';
import type { EntityRef } from '../src/types.js';

const Q = '\u0027'; // apostrophe
const B = '\u005C'; // reverse solidus

/** Extract one `#id=TYPE(...);` line's attributes through the real parser. */
function attrsOf(line: string): unknown[] {
  const buffer = new TextEncoder().encode(line);
  const ref: EntityRef = {
    expressId: parseInt(line.slice(1), 10),
    type: line.slice(line.indexOf('=') + 1, line.indexOf('(')),
    byteOffset: 0,
    byteLength: buffer.length,
  } as EntityRef;
  const entity = new EntityExtractor(buffer).extractEntity(ref);
  expect(entity, `entity parses: ${line}`).not.toBeNull();
  return entity!.attributes as unknown[];
}

describe('STEP doubled-escape collapse on the attribute path', () => {
  it('un-doubles the apostrophe in Name and Description', () => {
    const attrs = attrsOf(
      `#7=IFCWALL('1Ab1c2d3e4f5g6h7i8j9k0',$,'O${Q}${Q}Brien Wall','desc a${Q}${Q}b',$,$,$,$,$);`,
    );
    expect(attrs[2]).toBe(`O${Q}Brien Wall`);
    expect(attrs[3]).toBe(`desc a${Q}b`);
  });

  it('collapses the doubled reverse solidus in a property value', () => {
    const attrs = attrsOf(
      `#11=IFCPROPERTYSINGLEVALUE('Backslash',$,IFCLABEL('C:${B}${B}temp'),$);`,
    );
    expect(attrs[2]).toEqual(['IFCLABEL', `C:${B}temp`]);
  });

  it('handles both escapes in one value', () => {
    const attrs = attrsOf(
      `#13=IFCPROPERTYSINGLEVALUE('Mixed',$,IFCLABEL('a${Q}${Q}b${B}${B}c'),$);`,
    );
    expect(attrs[2]).toEqual(['IFCLABEL', `a${Q}b${B}c`]);
  });

  it('leaves the backslash DIRECTIVE forms decoding as before', () => {
    const attrs = attrsOf(
      `#12=IFCPROPERTYSINGLEVALUE('Unicode',$,IFCLABEL('caf${B}X2${B}00E9${B}X0${B}'),$);`,
    );
    expect(attrs[2]).toEqual(['IFCLABEL', 'caf\u00E9']);
  });

  it('reads fully-doubled directive text as literal characters, not a directive', () => {
    // `\\X2\\00E9\\X0\\` is the author writing the characters `\X2\00E9\X0\`.
    // A decoder that resolved the directive before the pairs would hand back
    // `é` and silently lose the text.
    const attrs = attrsOf(
      `#7=IFCWALL('1Ab1c2d3e4f5g6h7i8j9k0',$,'${B}${B}X2${B}${B}00E9${B}${B}X0${B}${B}',$,$,$,$,$,$);`,
    );
    expect(attrs[2]).toBe(`${B}X2${B}00E9${B}X0${B}`);
  });

  it('does not over-collapse: four apostrophes are two', () => {
    const attrs = attrsOf(
      `#10=IFCPROPERTYSINGLEVALUE('Quotes',$,IFCLABEL('${Q}${Q}${Q}${Q}'),$);`,
    );
    expect(attrs[2]).toEqual(['IFCLABEL', `${Q}${Q}`]);
  });
});

/**
 * The collapse must happen EXACTLY ONCE, at the parse boundary.
 *
 * Correct decoding is not idempotent — running it twice turns `\\` into `\` a
 * second time — so making the decoder idempotent is not an option: idempotence
 * would require treating an authored, still-doubled `\\` and an already-decoded
 * `\` alike, which is precisely the ambiguity #2323 removed. The invariant that
 * has to hold instead is "one decode, at the parse boundary"; the display layer
 * renders what the parse path stored, verbatim.
 *
 * A single-backslash value (`C:\temp`) survives a second decode unharmed, which
 * is why a redundant decode is easy to add and hard to notice — hence the UNC
 * path, whose adjacent backslashes make the extra pass visible.
 */
describe('the parse path decodes exactly once (display must not decode again)', () => {
  /** The authored value: a Windows UNC path, `\\server\share`. */
  const AUTHORED = `${B}${B}server${B}share`;
  /** Its on-the-wire form: ISO 10303-21 doubles every reverse solidus. */
  const WIRE = AUTHORED.replace(/\\/g, `${B}${B}`);

  it('stores the authored UNC path, and displays it unchanged', () => {
    const attrs = attrsOf(
      `#20=IFCPROPERTYSINGLEVALUE('UNCPath',$,IFCTEXT('${WIRE}'),$);`,
    );
    // Parse decodes once: the wire's doubled separators become the real ones.
    expect(attrs[2]).toEqual(['IFCTEXT', AUTHORED]);

    // Display must be a pure passthrough. A second `decodeIfcString` here
    // rendered `\server\share` and silently lost a separator.
    expect(parsePropertyValue(attrs[2]).displayValue).toBe(AUTHORED);
  });

  it('is a passthrough for the property NAME too', () => {
    const attrs = attrsOf(
      `#21=IFCPROPERTYSINGLEVALUE('P ${WIRE}',$,IFCTEXT('x'),$);`,
    );
    expect(attrs[0]).toBe(`P ${AUTHORED}`);
    // The property cards render `prop.name` / `pset.name` directly for the
    // same reason the value is rendered directly.
    expect(parsePropertyValue(attrs[0]).displayValue).toBe(`P ${AUTHORED}`);
  });

  it('shows why a single backslash hides the bug', () => {
    const attrs = attrsOf(
      `#22=IFCPROPERTYSINGLEVALUE('DosPath',$,IFCTEXT('C:${B}${B}temp'),$);`,
    );
    // `C:\temp` is a fixed point of the decoder (`\t` matches no escape arm),
    // so a redundant second decode is invisible on this value. It is only the
    // adjacent-backslash case above that catches it.
    expect(attrs[2]).toEqual(['IFCTEXT', `C:${B}temp`]);
    expect(parsePropertyValue(attrs[2]).displayValue).toBe(`C:${B}temp`);
  });
});

/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Hide prose while retaining offsets and executable template expressions. */
export function maskScriptLiterals(code: string): string {
  const masked = code.split('');
  const blank = (start: number, end: number) => {
    for (let i = start; i < Math.min(end, code.length); i++) {
      if (code[i] !== '\n' && code[i] !== '\r') masked[i] = ' ';
    }
  };

  const scanQuoted = (start: number): number => {
    const quote = code[start];
    let i = start + 1;
    while (i < code.length) {
      if (code[i] === '\\') i += 2;
      else if (code[i++] === quote) break;
    }
    blank(start, i);
    return i;
  };

  const startsRegex = (start: number): boolean => {
    let previous = start - 1;
    while (previous >= 0 && /\s/.test(masked[previous])) previous--;
    if (previous < 0 || /[=([{,:;!?&|+*%^~<>-]/.test(masked[previous])) return true;
    let wordStart = previous;
    while (wordStart >= 0 && /[A-Za-z]/.test(masked[wordStart])) wordStart--;
    return /^(?:return|throw|case|delete|void|typeof|instanceof|in|of|yield|await|else)$/.test(
      masked.slice(wordStart + 1, previous + 1).join(''),
    );
  };

  const scanRegex = (start: number): number => {
    let inClass = false;
    let i = start + 1;
    while (i < code.length && code[i] !== '\n') {
      if (code[i] === '\\') {
        i += 2;
      } else if (code[i] === '[') {
        inClass = true;
        i++;
      } else if (code[i] === ']') {
        inClass = false;
        i++;
      } else if (code[i] === '/' && !inClass) {
        i++;
        while (/[A-Za-z]/.test(code[i] ?? '')) i++;
        blank(start, i);
        return i;
      } else {
        i++;
      }
    }
    return start + 1;
  };

  const scanCode = (start: number, interpolation = false): number => {
    let braces = 0;
    for (let i = start; i < code.length;) {
      const ch = code[i];
      if (ch === '"' || ch === "'") {
        i = scanQuoted(i);
      } else if (ch === '`') {
        i = scanTemplate(i);
      } else if (ch === '/' && code[i + 1] === '/') {
        const end = code.indexOf('\n', i + 2);
        const next = end < 0 ? code.length : end;
        blank(i, next);
        i = next;
      } else if (ch === '/' && code[i + 1] === '*') {
        const end = code.indexOf('*/', i + 2);
        const next = end < 0 ? code.length : end + 2;
        blank(i, next);
        i = next;
      } else if (ch === '/' && startsRegex(i)) {
        i = scanRegex(i);
      } else if (interpolation && ch === '{') {
        braces++;
        i++;
      } else if (interpolation && ch === '}') {
        if (braces === 0) return i;
        braces--;
        i++;
      } else {
        i++;
      }
    }
    return code.length;
  };

  const scanTemplate = (start: number): number => {
    blank(start, start + 1);
    for (let i = start + 1; i < code.length;) {
      if (code[i] === '\\') {
        blank(i, i + 2);
        i += 2;
      } else if (code[i] === '`') {
        blank(i, i + 1);
        return i + 1;
      } else if (code[i] === '$' && code[i + 1] === '{') {
        blank(i, i + 2);
        const end = scanCode(i + 2, true);
        blank(end, end + 1);
        i = end + 1;
      } else {
        blank(i, i + 1);
        i++;
      }
    }
    return code.length;
  };

  scanCode(0);
  return masked.join('');
}

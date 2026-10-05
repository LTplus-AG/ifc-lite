/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Exact addition of the decimal strings `bim.cost` evaluates (#6833). Cost
 * amounts are decimals (decimal.js in the parser); adding them as binary
 * floats would print totals like `0.30000000000000004`.
 */

interface Scaled { units: bigint; scale: number }

function parse(text: string): Scaled {
  const match = /^([+-]?)(\d*)(?:\.(\d*))?(?:e([+-]?\d+))?$/i.exec(text.trim());
  if (!match || (match[2] === '' && (match[3] ?? '') === '')) throw new Error(`Not a decimal amount: ${text}`);
  const [, sign, whole, fraction = '', exponent = '0'] = match;
  let scale = fraction.length - Number(exponent);
  let digits = `${whole}${fraction}` || '0';
  if (scale < 0) {
    digits += '0'.repeat(-scale);
    scale = 0;
  }
  const units = BigInt(digits);
  return { units: sign === '-' ? -units : units, scale };
}

function format({ units, scale }: Scaled): string {
  const negative = units < 0n;
  const digits = (negative ? -units : units).toString().padStart(scale + 1, '0');
  const whole = digits.slice(0, digits.length - scale);
  const fraction = scale > 0 ? digits.slice(digits.length - scale).replace(/0+$/, '') : '';
  return `${negative ? '-' : ''}${whole}${fraction ? `.${fraction}` : ''}`;
}

export function addDecimalStrings(a: string, b: string): string {
  const left = parse(a);
  const right = parse(b);
  const scale = Math.max(left.scale, right.scale);
  const align = (value: Scaled) => value.units * 10n ** BigInt(scale - value.scale);
  return format({ units: align(left) + align(right), scale });
}

/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * LZF decompressor — Marc Lehmann's algorithm.
 *
 * Used by PCL's PCD `binary_compressed` data section. Pure decompression:
 * we never need to encode. Algorithm reference: liblzf 3.x lzf_d.c.
 *
 * Throws if the bitstream over-runs the input or the declared output length.
 */
export function decompressLZF(input: Uint8Array, outputSize: number): Uint8Array {
  const output = new Uint8Array(outputSize);
  let ip = 0;             // input cursor
  let op = 0;             // output cursor
  const ie = input.length;

  while (ip < ie) {
    let ctrl = input[ip++];

    if (ctrl < 0x20) {
      // Literal run: copy ctrl+1 bytes verbatim
      const run = ctrl + 1;
      if (ip + run > ie) {
        throw new Error('LZF: literal run exceeds input bounds');
      }
      if (op + run > outputSize) {
        throw new Error('LZF: literal run exceeds output bounds');
      }
      output.set(input.subarray(ip, ip + run), op);
      ip += run;
      op += run;
    } else {
      // Back reference
      let len = ctrl >> 5;
      if (len === 7) {
        if (ip >= ie) throw new Error('LZF: truncated extended length');
        len += input[ip++];
      }
      len += 2;

      if (ip >= ie) throw new Error('LZF: truncated back-reference offset');
      const ref = op - ((ctrl & 0x1f) << 8) - input[ip++] - 1;
      if (ref < 0) {
        throw new Error('LZF: back-reference points before output start');
      }
      if (op + len > outputSize) {
        throw new Error('LZF: back-reference exceeds output bounds');
      }

      // The reference can overlap the current write position — the original
      // C code uses byte-by-byte copy for that exact reason (run-length
      // expansion). Mirror that.
      for (let i = 0; i < len; i++) {
        output[op + i] = output[ref + i];
      }
      op += len;
    }
  }

  if (op !== outputSize) {
    throw new Error(`LZF: decompressed ${op} bytes, expected ${outputSize}`);
  }
  return output;
}

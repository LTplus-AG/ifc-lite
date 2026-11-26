/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The in-sandbox JSON serialiser of the script_run wrapper, as JavaScript
 * source spliced into wrapScript's function (script-wrapper.ts). It runs in
 * that scope: the intrinsics (apply, stringify, keys, ...), L and msg/
 * isInternal come from there. Iterative, so a deep value cannot overflow the
 * host stack; it follows JSON.stringify's spec steps for replacers, property
 * lists, indents, toJSON and boxed primitives.
 */
export const SERIALISER_SOURCE = `
  function bigintText(b) { return Str(b) + 'n'; }
  // LengthOfArrayLike: a proxy's fractional, negative or NaN length reads as
  // native JSON reads it.
  function lengthOf(n) { n = +n; return n > 0 ? (n > 9007199254740991 ? 9007199254740991 : n - (n % 1)) : 0; }
  function omitted(v) { var t = typeof v; return t === 'undefined' || t === 'function' || t === 'symbol'; }
  // JSON's per-property steps, in the spec's order: toJSON, then the
  // replacer function (called with the holder), then unboxing in write().
  function resolve(v, k, holder, replacer) {
    if (v !== null && (typeof v === 'object' || typeof v === 'function' || typeof v === 'bigint')) {
      var f = v.toJSON;
      if (typeof f === 'function') v = apply(f, v, [k]);
    }
    return replacer ? apply(replacer, holder, [k, v]) : v;
  }
  // JSON text for v, stopping once it passes limit; undefined when JSON would
  // omit v. Frames live in null-prototype maps: an index setter on
  // Array.prototype cannot intercept them.
  // A boxed primitive's value, as native JSON unwraps it (a boxed BigInt then
  // throws like a bare one); undefined for any other object. Plain objects
  // and arrays skip the brand-checked valueOf calls entirely; anything with
  // another prototype (a boxed value, a subclass of one, a class instance)
  // tries each, and a valueOf that rejects the receiver means "not this type".
  // A Number or String subclass that overrides valueOf or toString is written
  // from its internal value (native JSON calls the override).
  // A boxed value whose prototype was reset to Object.prototype or null is
  // written as an object, unlike native JSON; plain objects stay cheap.
  // A Proxy's getPrototypeOf trap may throw: that reads as 'no prototype to
  // walk' (undefined), but QuickJS's own out-of-memory or stack overflow
  // still propagates.
  function protoOf(v) {
    try { return getProto(v); } catch (e) { if (isInternal(e)) throw e; return undefined; }
  }
  function unboxed(v) {
    var proto = protoOf(v);
    if (proto === undefined || proto === objectProto || proto === null || isArray(v)) return undefined;
    // Walk to a box prototype first, so a class instance costs a short chain
    // walk instead of four thrown brand checks; the chain is capped in case a
    // proxy keeps inventing prototypes.
    var u = -1;
    for (var hops = 0; proto !== null && hops < 64 && u < 0; hops++) {
      for (var b = 0; b < unbox.length; b++) if (proto === unbox[b][0]) u = b;
      if (u < 0 && (proto = protoOf(proto)) === undefined) return undefined;
    }
    if (u >= 0) {
      try { return { v: apply(unbox[u][1], v, []) }; } catch (e) {
        // A brand-check TypeError means "not this wrapper type"; QuickJS's own
        // out-of-memory or stack overflow must not turn the value into {}.
        if (isInternal(e)) throw e;
      }
    }
    return undefined;
  }
  // The replacer and indent of JSON.stringify(value, replacer, space): a
  // function, or a property list (null-prototype, so no Array.prototype
  // setter sees it); and the gap string.
  function jsonOptions(replacer, space) {
    var o = { fn: null, list: null, gap: '' };
    if (typeof replacer === 'function') o.fn = replacer;
    else if (isArray(replacer)) {
      var list = create(null), seen = new SetCtor(), n = 0, len = lengthOf(replacer.length);
      for (var ri = 0; ri < len; ri++) {
        var item = replacer[ri], name = undefined;
        if (typeof item === 'string') name = item;
        else if (typeof item === 'number') name = Str(item);
        else if (item !== null && typeof item === 'object') { var b = unboxed(item); if (b && (typeof b.v === 'string' || typeof b.v === 'number')) name = Str(b.v); }
        if (name !== undefined && !apply(setHas, seen, [name])) { apply(setAdd, seen, [name]); list[n++] = name; }
      }
      list.length = n;
      o.list = list;
    }
    if (space !== null && typeof space === 'object') { var sb = unboxed(space); if (sb) space = sb.v; }
    if (typeof space === 'number') {
      var count = space > 10 ? 10 : space >= 1 ? space - (space % 1) : 0;
      for (var si = 0; si < count; si++) o.gap += ' ';
    } else if (typeof space === 'string') o.gap = apply(slice, space, [0, 10]);
    return o;
  }
  // forLog: an Error nested in a logged value prints as its message, not {}.
  // opts: from jsonOptions, or undefined for plain JSON with no replacer.
  function ser(root, limit, forLog, opts) {
    var fn = opts ? opts.fn : null, list = opts ? opts.list : null, gap = opts ? opts.gap : '';
    // Indent strings per depth, built only when there is a gap.
    var indents = null, built = 0;
    function indent(depth) {
      if (indents === null) { indents = create(null); indents[0] = ''; }
      for (; built < depth; built++) indents[built + 1] = indents[built] + gap;
      return indents[depth];
    }
    // onPath holds the objects being written, so a cycle is named as one
    // (like native JSON) before the length cap could turn it into a preview.
    var out = '', sp = 0, fo = create(null), fk = create(null), fi = create(null), fa = create(null), fw = create(null);
    var onPath = new SetCtor();
    function write(v) {
      if (v === null) { out += 'null'; return; }
      if (forLog && typeof v === 'bigint') { out += stringify(bigintText(v)); return; }
      if (typeof v === 'object') {
        var box = unboxed(v);
        // Unwrapped, it takes the primitive path below (a boxed string is cut too).
        if (box) v = forLog && typeof box.v === 'bigint' ? bigintText(box.v) : box.v;
      }
      if (typeof v === 'object') {
        if (forLog && isError(v)) { out += stringify(msg(v)); return; }
        if (apply(setHas, onPath, [v])) throw new TypeErrorCtor('the value is cyclic');
        if (sp >= L.maxDepth) throw new ErrorCtor('the value is nested deeper than ' + L.maxDepth + ' levels');
        apply(setAdd, onPath, [v]);
        var a = isArray(v);
        // An array's length is read once, as native JSON does, so a toJSON or
        // replacer that appends to it cannot make the walk run forever.
        fo[sp] = v; fk[sp] = a ? lengthOf(v.length) : list || keys(v); fi[sp] = 0; fa[sp] = a; fw[sp] = false; sp++;
        out += a ? '[' : '{';
        return;
      }
      // A BigInt left here would reach native stringify, which calls its
      // toJSON again and could hand native recursion an unchecked deep value.
      if (typeof v === 'bigint') throw new TypeErrorCtor('a BigInt cannot be serialised as JSON; convert it with String() or Number()');
      // A string past the cap is cut before it is escaped, so the preview path
      // runs instead of copying a huge string into out.
      if (typeof v === 'string' && limit !== Infinity && out.length + v.length > limit) v = apply(slice, v, [0, out.length > limit ? 0 : limit - out.length + 1]);
      out += omitted(v) ? 'null' : stringify(v);
    }
    var top = resolve(root, '', { '': root }, fn);
    if (omitted(top)) return undefined;
    write(top);
    while (sp > 0) {
      if (out.length > limit) return out;
      var i = sp - 1, o = fo[i];
      if (fa[i]) {
        if (fi[i] >= fk[i]) {
          if (gap && fk[i] > 0) out += '\\n' + indent(sp - 1);
          out += ']'; apply(setDelete, onPath, [o]); sp--; continue;
        }
        var idx = fi[i]; fi[i] = idx + 1;
        if (idx > 0) out += ',';
        if (gap) out += '\\n' + indent(sp);
        write(resolve(o[idx], Str(idx), o, fn));
      } else {
        var ks = fk[i];
        if (fi[i] >= ks.length) {
          if (gap && fw[i]) out += '\\n' + indent(sp - 1);
          out += '}'; apply(setDelete, onPath, [o]); sp--; continue;
        }
        var k = ks[fi[i]]; fi[i] = fi[i] + 1;
        var v = resolve(o[k], k, o, fn);
        if (omitted(v)) continue;
        // A long key can pass the cap on its own: copy only enough of it to
        // pass the cap, so the result is read as a preview, then stop.
        if (out.length + k.length > limit) return out.length > limit ? out : out + (fw[i] ? ',' : '') + stringify(apply(slice, k, [0, limit - out.length + 1]));
        if (fw[i]) out += ',';
        fw[i] = true;
        if (gap) out += '\\n' + indent(sp);
        out += stringify(k) + (gap ? ': ' : ':');
        write(v);
      }
    }
    return out;
  }
`;

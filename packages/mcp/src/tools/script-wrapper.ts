/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The JavaScript that runs inside the QuickJS sandbox around a script_run
 * script. It settles a returned promise and hands back one tagged primitive
 * string: 'J' + JSON, 'P' + a JSON prefix (over the value cap), 'U' + why
 * the value could not be serialised, or 'T' + what the script threw.
 *
 * Every primitive it relies on is bound before the script runs, and the
 * script's own function is created in the global scope outside this
 * closure, so a script that patches Promise, JSON, Array.prototype or
 * Function.prototype.call cannot reshape the result.
 *
 * QuickJS's native JSON.stringify (and the sandbox bridge's dump of console
 * arguments) recurse in C without QuickJS's stack check, so a value nested a
 * few thousand levels deep overflowed Node's stack and aborted the shared
 * module (#1922). The wrapper therefore serialises objects itself,
 * iteratively: each property and toJSON is read once, depth and output
 * length are capped, and native stringify only ever sees primitives. Console
 * methods are replaced so non-string arguments go through the same path
 * before they reach the bridge, and the script's own JSON.stringify and
 * JSON.parse are replaced with depth-checked versions. Still open: a deeply
 * nested value passed as an argument to a bim.* method is dumped by the
 * sandbox bridge unchecked (#11600).
 *
 * The catch blocks inside the generated source are not silent in the house
 * rule's sense: this code runs in the sandbox with no host logger, and each
 * one turns the failure into a stated result (an envelope tag, a fallback
 * label or "not this wrapper type").
 */

import { SANDBOX_CONSOLE_LEVELS } from '@ifc-lite/sandbox';
import { MAX_LOG_CHARS, MAX_MESSAGE_CHARS, MAX_VALUE_CHARS, VALUE_PREVIEW_CHARS } from './script-output.js';

/** Deepest value the wrapper serialises; about 3000 levels overflowed the host stack. */
const MAX_VALUE_DEPTH = 1_000;

const LIMITS = {
  max: MAX_VALUE_CHARS, preview: VALUE_PREVIEW_CHARS, maxMessage: MAX_MESSAGE_CHARS,
  maxDepth: MAX_VALUE_DEPTH, maxLog: MAX_LOG_CHARS, levels: SANDBOX_CONSOLE_LEVELS,
};

export function wrapScript(code: string): string {
  return `(function (run, P, isInstance, then, apply, slice, Str, stringify, keys, isArray, create, defineProperty, freeze, glob, ErrorCtor, TypeErrorCtor, SetCtor, setAdd, setHas, setDelete, unbox, objectProto, getProto, parse, charCodeAt, SyntaxErrorCtor, L) {
  function msg(e) {
    // message is read once and coerced inside the try, so a getter or
    // toString cannot throw past the wrapper and pose as a sandbox error.
    var m;
    try {
      var x = e && e.message, n = e && e.name;
      m = typeof x !== 'string' || x === '' ? Str(e)
        : typeof n === 'string' && n !== '' && n !== 'Error' ? n + ': ' + x : x;
    } catch (c) {
      // QuickJS raises InternalError for both exhausted memory and stack overflow.
      try {
        if (c && c.name === 'InternalError' && c.message === 'out of memory') return 'out of memory while printing the error';
        if (c && c.name === 'InternalError' && c.message === 'stack overflow') return 'stack overflow while printing the error';
        return 'a thrown value with no string form';
      }
      catch (_) { return 'a thrown value with no string form'; }
    }
    if (m === '') return 'an empty ' + (typeof e) + ' was thrown';
    return apply(slice, m, [0, L.maxMessage + 1]);
  }
  function bigintText(b) { return Str(b) + 'n'; }
  function omitted(v) { var t = typeof v; return t === 'undefined' || t === 'function' || t === 'symbol'; }
  function resolve(v, k) {
    if (v !== null && (typeof v === 'object' || typeof v === 'function' || typeof v === 'bigint')) {
      var f = v.toJSON;
      if (typeof f === 'function') return apply(f, v, [k]);
    }
    return v;
  }
  // JSON text for v, stopping once it passes limit; undefined when JSON would
  // omit v. Frames live in null-prototype maps: an index setter on
  // Array.prototype cannot intercept them.
  // A boxed primitive's value, as native JSON unwraps it (a boxed BigInt then
  // throws like a bare one); undefined for any other object. Plain objects
  // and arrays skip the brand-checked valueOf calls entirely; anything with
  // another prototype (a boxed value, a subclass of one, a class instance)
  // tries each, and a valueOf that rejects the receiver means "not this type".
  // A boxed value whose prototype was reset to Object.prototype or null is
  // written as an object, unlike native JSON; plain objects stay cheap.
  function unboxed(v) {
    var proto = getProto(v);
    if (proto === objectProto || proto === null || isArray(v)) return undefined;
    for (var u = 0; u < unbox.length; u++) {
      try { return { v: apply(unbox[u], v, []) }; } catch (_) { /* receiver is not this wrapper type */ }
    }
    return undefined;
  }
  // forLog: an Error nested in a logged value prints as its message, not {}.
  function ser(root, limit, forLog) {
    // onPath holds the objects being written, so a cycle is named as one
    // (like native JSON) before the length cap could turn it into a preview.
    var out = '', sp = 0, fo = create(null), fk = create(null), fi = create(null), fa = create(null), fw = create(null);
    var onPath = new SetCtor();
    function write(v) {
      if (v === null) { out += 'null'; return; }
      if (forLog && typeof v === 'bigint') { out += stringify(bigintText(v)); return; }
      if (typeof v === 'object') {
        var box = unboxed(v);
        if (box) { out += stringify(forLog && typeof box.v === 'bigint' ? bigintText(box.v) : box.v); return; }
        if (forLog && apply(isInstance, ErrorCtor, [v])) { out += stringify(msg(v)); return; }
        if (apply(setHas, onPath, [v])) throw new TypeErrorCtor('the value is cyclic');
        if (sp >= L.maxDepth) throw new ErrorCtor('the value is nested deeper than ' + L.maxDepth + ' levels');
        apply(setAdd, onPath, [v]);
        var a = isArray(v);
        fo[sp] = v; fk[sp] = a ? null : keys(v); fi[sp] = 0; fa[sp] = a; fw[sp] = false; sp++;
        out += a ? '[' : '{';
        return;
      }
      out += omitted(v) ? 'null' : stringify(v);
    }
    var top = resolve(root, '');
    if (omitted(top)) return undefined;
    write(top);
    while (sp > 0) {
      if (out.length > limit) return out;
      var i = sp - 1, o = fo[i];
      if (fa[i]) {
        if (fi[i] >= o.length) { out += ']'; apply(setDelete, onPath, [o]); sp--; continue; }
        var idx = fi[i]; fi[i] = idx + 1;
        if (idx > 0) out += ',';
        write(resolve(o[idx], Str(idx)));
      } else {
        var ks = fk[i];
        if (fi[i] >= ks.length) { out += '}'; apply(setDelete, onPath, [o]); sp--; continue; }
        var k = ks[fi[i]]; fi[i] = fi[i] + 1;
        var v = resolve(o[k], k);
        if (omitted(v)) continue;
        if (fw[i]) out += ',';
        fw[i] = true;
        out += stringify(k) + ':';
        write(v);
      }
    }
    return out;
  }
  function env(v) {
    var j;
    try { j = ser(v, L.max); } catch (e) { return 'U' + msg(e); }
    if (j === undefined) return 'Jnull';
    return j.length > L.max ? 'P' + apply(slice, j, [0, L.preview + 1]) : 'J' + j;
  }
  function fail(e) { return 'T' + msg(e); }
  // Console text keeps what the bridge's own dump used to show for errors
  // and BigInts, which JSON rules would turn into {} or a TypeError.
  // Cut a little under the host log budget so the marker itself survives it.
  function cut(text, max) {
    if (text.length <= max) return text;
    // Never end on the first half of a surrogate pair.
    var c = text.charCodeAt(max - 1), end = c >= 0xD800 && c <= 0xDBFF ? max - 1 : max;
    return apply(slice, text, [0, end]) + ' [truncated]';
  }
  function logArg(a) {
    if (typeof a === 'string') return a;
    if (typeof a === 'bigint') return bigintText(a);
    if (typeof a === 'number') return Str(a);
    try {
      if (apply(isInstance, ErrorCtor, [a])) {
        var st = a.stack;
        var head = cut(msg(a), L.maxMessage);
        return head + (typeof st === 'string' && st !== '' ? '\\n' + cut(st, L.maxLog - 32 - head.length) : '');
      }
    } catch (_) { /* an unreadable stack: fall through to the JSON form */ }
    try {
      var s = ser(a, L.maxLog, true);
      // A root whose toJSON gave a string (a Date, say) prints as that text, not quoted.
      if (s !== undefined && s.charCodeAt(0) === 34) s = parse(s);
      return cut(s === undefined ? Str(a) : s, L.maxLog - 32);
    }
    catch (e) { return '[unserialisable: ' + msg(e) + ']'; }
  }
  var original = glob.console, safe = create(null);
  for (var li = 0; li < L.levels.length; li++) {
    (function (level) {
      var fn = original[level];
      safe[level] = function () {
        var args = create(null), n = arguments.length;
        for (var ai = 0; ai < n; ai++) args[ai] = logArg(arguments[ai]);
        args.length = n;
        return apply(fn, original, args);
      };
    })(L.levels[li]);
  }
  defineProperty(glob, 'console', { value: freeze(safe), writable: false, configurable: false });
  // The script's own JSON calls hit the same C recursion, so it gets a JSON
  // whose stringify is the wrapper's serialiser (a replacer or indent runs on
  // its depth-capped copy) and whose parse first scans nesting depth.
  function depthOf(text) {
    var depth = 0, top = 0, inString = false, n = text.length;
    // Each level takes at least one character, so short text cannot be too deep.
    if (n <= L.maxDepth) return 0;
    // One argument array, reused: its index is an own property, so no
    // Array.prototype setter can intercept the writes.
    var at = [0];
    for (var p = 0; p < n; p++) {
      at[0] = p;
      var ch = apply(charCodeAt, text, at);
      if (inString) {
        if (ch === 92) p++;
        else if (ch === 34) inString = false;
      } else if (ch === 34) inString = true;
      else if (ch === 91 || ch === 123) { if (++depth > top) top = depth; }
      else if (ch === 93 || ch === 125) depth--;
    }
    return top;
  }
  var safeJson = create(null);
  safeJson.stringify = function (value, replacer, space) {
    var text = ser(value, Infinity, false);
    if (replacer === undefined && space === undefined) return text;
    return text === undefined ? undefined : stringify(parse(text), replacer, space);
  };
  safeJson.parse = function (text, reviver) {
    var t = Str(text);
    if (depthOf(t) > L.maxDepth) throw new SyntaxErrorCtor('JSON text is nested deeper than ' + L.maxDepth + ' levels');
    return reviver === undefined ? parse(t) : parse(t, reviver);
  };
  defineProperty(glob, 'JSON', { value: freeze(safeJson), writable: false, configurable: false });
  var r, isPromise;
  try { r = run(); isPromise = apply(isInstance, P, [r]); } catch (e) { return fail(e); }
  if (!isPromise) return env(r);
  // Settle through a promise the wrapper owns: then() on the script's
  // promise builds its result via the script-controlled species constructor,
  // and a throwing constructor getter becomes an ordinary script failure.
  return new P(function (resolveWrapper) {
    // Each callback resolves even if building its envelope throws (e.g. out
    // of memory), so the wrapper promise cannot be left pending by it.
    try {
      apply(then, r, [
        function (v) { try { resolveWrapper(env(v)); } catch (_) { resolveWrapper('Uthe result envelope could not be built'); } },
        function (e) { try { resolveWrapper(fail(e)); } catch (_) { resolveWrapper('Tthe error envelope could not be built'); } },
      ]);
    }
    catch (e) { resolveWrapper(fail(e)); }
  });
})(function () { return eval(${JSON.stringify(code)}); }, Promise, Function.prototype[Symbol.hasInstance], Promise.prototype.then, Reflect.apply, String.prototype.slice, String, JSON.stringify, Object.keys, Array.isArray, Object.create, Object.defineProperty, Object.freeze, globalThis, Error, TypeError, Set, Set.prototype.add, Set.prototype.has, Set.prototype.delete, [Number.prototype.valueOf, String.prototype.valueOf, Boolean.prototype.valueOf, BigInt.prototype.valueOf], Object.prototype, Object.getPrototypeOf, JSON.parse, String.prototype.charCodeAt, SyntaxError, ${JSON.stringify(LIMITS)})`;
}

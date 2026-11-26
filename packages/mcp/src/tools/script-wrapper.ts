/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The JavaScript that runs inside the QuickJS sandbox around a script_run
 * script. It settles a returned promise and hands back one tagged primitive
 * string: 'J' + JSON, 'P' + a JSON prefix (over the value cap), 'U' + why
 * the value could not be serialised, 'T' + what the script threw, or 'Q' +
 * the message of QuickJS's own InternalError (out of memory, stack overflow).
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
 * JSON.parse are replaced with depth-checked versions, and every object
 * argument to a bim.* method is passed through that same bounded path before
 * the bridge dumps it (#11600 tracks the bridge-side fix).
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
  return `(function (run, I, L) {
  // The intrinsics, by name: read once here, before the script runs.
  var P = I.P, isInstance = I.isInstance, then = I.then, apply = I.apply, slice = I.slice, Str = I.Str, stringify = I.stringify, keys = I.keys, isArray = I.isArray, create = I.create, defineProperty = I.defineProperty, glob = I.glob, ErrorCtor = I.ErrorCtor, TypeErrorCtor = I.TypeErrorCtor, SetCtor = I.SetCtor, setAdd = I.setAdd, setHas = I.setHas, setDelete = I.setDelete, unbox = I.unbox, objectProto = I.objectProto, getProto = I.getProto, parse = I.parse, charCodeAt = I.charCodeAt, SyntaxErrorCtor = I.SyntaxErrorCtor, RegExpCtor = I.RegExpCtor, exec = I.exec, bind = I.bind, InternalErrorCtor = I.InternalErrorCtor, toStringTag = I.toStringTag;
  // Guarded: a thrown Proxy whose getPrototypeOf trap throws must not make the
  // wrapper itself throw.
  function isInternal(e) {
    try { return !!InternalErrorCtor && apply(isInstance, InternalErrorCtor, [e]); }
    catch (_) { return false; }
  }
  function msg(e) {
    // message is read once and coerced inside the try, so a getter or
    // toString cannot throw past the wrapper and pose as a sandbox error.
    var m;
    try {
      var x = e && e.message, n = e && e.name;
      // Only QuickJS's own InternalError keeps that name, so a thrown look-alike
      // cannot earn the memory or stack hints.
      if (n === 'InternalError' && !(isInternal(e))) n = 'Error';
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
  function unboxed(v) {
    var proto = getProto(v);
    if (proto === objectProto || proto === null || isArray(v)) return undefined;
    // Walk to a box prototype first, so a class instance costs a short chain
    // walk instead of four thrown brand checks; the chain is capped in case a
    // proxy keeps inventing prototypes.
    var u = -1;
    for (var hops = 0; proto !== null && hops < 64 && u < 0; hops++) {
      for (var b = 0; b < unbox.length; b++) if (proto === unbox[b][0]) u = b;
      if (u < 0) proto = getProto(proto);
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
      var list = create(null), seen = new SetCtor(), n = 0, len = replacer.length;
      for (var ri = 0; ri < len; ri++) {
        var item = replacer[ri], name;
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
        if (forLog && apply(isInstance, ErrorCtor, [v])) { out += stringify(msg(v)); return; }
        if (apply(setHas, onPath, [v])) throw new TypeErrorCtor('the value is cyclic');
        if (sp >= L.maxDepth) throw new ErrorCtor('the value is nested deeper than ' + L.maxDepth + ' levels');
        apply(setAdd, onPath, [v]);
        var a = isArray(v);
        // An array's length is read once, as native JSON does, so a toJSON or
        // replacer that appends to it cannot make the walk run forever.
        fo[sp] = v; fk[sp] = a ? v.length : list || keys(v); fi[sp] = 0; fa[sp] = a; fw[sp] = false; sp++;
        out += a ? '[' : '{';
        return;
      }
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
        // A long key can pass the cap on its own; stop before copying more.
        if (out.length > limit) return out;
        if (fw[i]) out += ',';
        fw[i] = true;
        if (gap) out += '\\n' + indent(sp);
        out += stringify(k) + (gap ? ': ' : ':');
        write(v);
      }
    }
    return out;
  }
  function env(v) {
    var j;
    // 'Q' marks QuickJS's own InternalError class. The script has no
    // InternalError global, though one it caught can still be reused.
    try { j = ser(v, L.max); } catch (e) { return (isInternal(e) ? 'Q' : 'U') + msg(e); }
    if (j === undefined) return 'Jnull';
    return j.length > L.max ? 'P' + apply(slice, j, [0, L.preview + 1]) : 'J' + j;
  }
  function fail(e) { return (isInternal(e) ? 'Q' : 'T') + msg(e); }
  // Console text keeps what the bridge's own dump used to show for errors
  // and BigInts, which JSON rules would turn into {} or a TypeError.
  // Cut a little under the host log budget so the marker itself survives it.
  function cut(text, max) {
    if (text.length <= max) return text;
    // Never end on the first half of a surrogate pair.
    var c = apply(charCodeAt, text, [max - 1]), end = c >= 0xD800 && c <= 0xDBFF ? max - 1 : max;
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
      if (s !== undefined && apply(charCodeAt, s, [0]) === 34) s = parse(s);
      return cut(s === undefined ? Str(a) : s, L.maxLog - 32);
    }
    catch (e) { return '[unserialisable: ' + msg(e) + ']'; }
  }
  // A function that maps each argument and then calls fn on thisArg. The
  // argument list is a null-prototype array-like, out of Array.prototype's reach.
  function forwardMapped(fn, thisArg, mapper) {
    return function () {
      var args = create(null), n = arguments.length;
      for (var ai = 0; ai < n; ai++) args[ai] = mapper(arguments[ai]);
      args.length = n;
      return apply(fn, thisArg, args);
    };
  }
  var original = glob.console, safe = create(null);
  for (var li = 0; li < L.levels.length; li++) safe[L.levels[li]] = forwardMapped(original[L.levels[li]], original, logArg);
  // Writable and configurable like the originals: a script that replaces them
  // only affects itself, since the bridge's console is reachable only from here.
  defineProperty(glob, 'console', { value: safe, writable: true, configurable: true });
  delete glob.InternalError;
  // The bridge vm.dump()s every object argument of a bim method (JSON
  // semantics), and that recursion has no stack check either (#11600). Each
  // object argument therefore goes through the wrapper's bounded serialiser
  // and native parse first: the bridge gets the same data, capped in depth.
  function safeArg(a) {
    if (a === null || (typeof a !== 'object' && typeof a !== 'function')) return a;
    var text = ser(a, Infinity, false);
    return text === undefined ? undefined : parse(text);
  }
  function wrapMethods(source, level) {
    var target = create(null), ks = keys(source);
    for (var wi = 0; wi < ks.length; wi++) {
      var member = source[ks[wi]];
      target[ks[wi]] = typeof member === 'function' ? forwardMapped(member, source, safeArg)
        : member !== null && typeof member === 'object' && level < 3 ? wrapMethods(member, level + 1)
        : member;
    }
    return target;
  }
  if (glob.bim !== null && typeof glob.bim === 'object') {
    defineProperty(glob, 'bim', { value: wrapMethods(glob.bim, 0), writable: true, configurable: true });
  }
  // The script's own JSON calls hit the same C recursion, so it gets a JSON
  // whose stringify is the wrapper's serialiser (replacer and indent applied
  // in the same iterative walk) and whose parse first scans nesting depth.
  // Brackets, quotes and backslashes only: exec (bound before the script ran,
  // on a regex no script can reach) jumps between them natively, so the scan
  // costs per structural character, not per character.
  var structural = new RegExpCtor('[\\\\[\\\\]{}"\\\\\\\\]', 'g');
  var nextStructural = apply(bind, exec, [structural]);
  function depthOf(text) {
    var depth = 0, top = 0, inString = false, m;
    // Each level takes at least one character, so short text cannot be too deep.
    if (text.length <= L.maxDepth) return 0;
    structural.lastIndex = 0;
    while ((m = nextStructural(text)) !== null) {
      var ch = m[0];
      if (inString) {
        if (ch === '\\\\') structural.lastIndex++;
        else if (ch === '"') inString = false;
      } else if (ch === '"') inString = true;
      else if (ch === '[' || ch === '{') { if (++depth > top) top = depth; }
      else if (ch === ']' || ch === '}') depth--;
    }
    return top;
  }
  var safeJson = create(null);
  safeJson.stringify = function (value, replacer, space) {
    return ser(value, Infinity, false, jsonOptions(replacer, space));
  };
  safeJson.parse = function (text, reviver) {
    var t = Str(text);
    if (depthOf(t) > L.maxDepth) throw new SyntaxErrorCtor('JSON text is nested deeper than ' + L.maxDepth + ' levels');
    return reviver === undefined ? parse(t) : parse(t, reviver);
  };
  defineProperty(safeJson, toStringTag, { value: 'JSON', configurable: true });
  defineProperty(glob, 'JSON', { value: safeJson, writable: true, configurable: true });
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
})(function () { return (0, eval)(${JSON.stringify(code)}); }, { P: Promise, isInstance: Function.prototype[Symbol.hasInstance], then: Promise.prototype.then, apply: Reflect.apply, slice: String.prototype.slice, Str: String, stringify: JSON.stringify, keys: Object.keys, isArray: Array.isArray, create: Object.create, defineProperty: Object.defineProperty, glob: globalThis, ErrorCtor: Error, TypeErrorCtor: TypeError, SetCtor: Set, setAdd: Set.prototype.add, setHas: Set.prototype.has, setDelete: Set.prototype.delete, unbox: [[Number.prototype, Number.prototype.valueOf], [String.prototype, String.prototype.valueOf], [Boolean.prototype, Boolean.prototype.valueOf], [BigInt.prototype, BigInt.prototype.valueOf]], objectProto: Object.prototype, getProto: Object.getPrototypeOf, parse: JSON.parse, charCodeAt: String.prototype.charCodeAt, SyntaxErrorCtor: SyntaxError, RegExpCtor: RegExp, exec: RegExp.prototype.exec, bind: Function.prototype.bind, InternalErrorCtor: typeof InternalError === 'function' ? InternalError : undefined, toStringTag: Symbol.toStringTag }, ${JSON.stringify(LIMITS)})`;
}

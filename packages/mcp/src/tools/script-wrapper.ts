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

import { NAMESPACE_SCHEMAS, SANDBOX_CONSOLE_LEVELS } from '@ifc-lite/sandbox';
import { MAX_LOG_CHARS, MAX_MESSAGE_CHARS, MAX_VALUE_CHARS, VALUE_PREVIEW_CHARS } from './script-output.js';
import { SERIALISER_SOURCE } from './script-serialiser.js';

/** Deepest value the wrapper serialises; about 3000 levels overflowed the host stack. */
const MAX_VALUE_DEPTH = 1_000;

/**
 * For each bim method the schema declares, the argument positions the bridge
 * vm.dump()s ('dump' and the entityRefs kinds). Only those are bounded, so a
 * string or number argument keeps its toString/valueOf coercion.
 */
const DUMPED_ARGS: Record<string, Record<number, true>> = Object.fromEntries(
  NAMESPACE_SCHEMAS.flatMap((ns) => ns.methods.map((m) => [
    `${ns.name}.${m.name}`,
    Object.fromEntries(m.args.flatMap((kind, i) => (kind === 'dump' || kind.startsWith('entityRefs') ? [[i, true]] : []))),
  ])),
);

const LIMITS = {
  max: MAX_VALUE_CHARS, preview: VALUE_PREVIEW_CHARS, maxMessage: MAX_MESSAGE_CHARS,
  maxDepth: MAX_VALUE_DEPTH, maxLog: MAX_LOG_CHARS, levels: SANDBOX_CONSOLE_LEVELS, dumped: DUMPED_ARGS,
};

/**
 * The intrinsics the wrapper binds before the script runs, as [local name,
 * source expression]: one list feeds both the object literal passed in and the
 * locals unpacked from it, so the two cannot drift.
 */
const INTRINSICS: ReadonlyArray<readonly [string, string]> = [
  ['P', 'Promise'],
  ['isInstance', 'Function.prototype[Symbol.hasInstance]'],
  ['then', 'Promise.prototype.then'],
  ['apply', 'Reflect.apply'],
  ['slice', 'String.prototype.slice'],
  ['Str', 'String'],
  ['stringify', 'JSON.stringify'],
  ['keys', 'Object.keys'],
  ['isArray', 'Array.isArray'],
  ['create', 'Object.create'],
  ['defineProperty', 'Object.defineProperty'],
  ['glob', 'globalThis'],
  ['ErrorCtor', 'Error'],
  ['TypeErrorCtor', 'TypeError'],
  ['SetCtor', 'Set'],
  ['setAdd', 'Set.prototype.add'],
  ['setHas', 'Set.prototype.has'],
  ['setDelete', 'Set.prototype.delete'],
  ['unbox', '[[Number.prototype, Number.prototype.valueOf], [String.prototype, String.prototype.valueOf], [Boolean.prototype, Boolean.prototype.valueOf], [BigInt.prototype, BigInt.prototype.valueOf]]'],
  ['objectProto', 'Object.prototype'],
  ['indexOf', 'String.prototype.indexOf'],
  ['lastIndexOf', 'String.prototype.lastIndexOf'],
  ['getProto', 'Object.getPrototypeOf'],
  ['parse', 'JSON.parse'],
  ['charCodeAt', 'String.prototype.charCodeAt'],
  ['SyntaxErrorCtor', 'SyntaxError'],
  ['RegExpCtor', 'RegExp'],
  ['exec', 'RegExp.prototype.exec'],
  ['bind', 'Function.prototype.bind'],
  ['InternalErrorCtor', 'typeof InternalError === \'function\' ? InternalError : undefined'],
  ['toStringTag', 'Symbol.toStringTag'],
];
const INTRINSICS_OBJECT = `{ ${INTRINSICS.map(([n, v]) => `${n}: ${v}`).join(', ')} }`;
const INTRINSICS_LOCALS = INTRINSICS.map(([n]) => `${n} = I.${n}`).join(', ');

export function wrapScript(code: string): string {
  return `(function (run, I, L) {
  // The intrinsics, by name: read once here, before the script runs.
  var ${INTRINSICS_LOCALS};
  // instanceof, guarded: a thrown Proxy whose getPrototypeOf trap throws must
  // not make the wrapper itself throw.
  function instanceOf(ctor, e) {
    try { return !!ctor && apply(isInstance, ctor, [e]); }
    catch (_) { return false; }
  }
  function isError(e) { return instanceOf(ErrorCtor, e); }
  function isInternal(e) { return instanceOf(InternalErrorCtor, e); }
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
${SERIALISER_SOURCE}
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
    if (typeof a === 'number') return a === 0 && 1 / a < 0 ? '-0' : Str(a);
    if (isError(a)) {
      var head = cut(msg(a), L.maxMessage), st;
      try { st = a.stack; } catch (_) { st = '[stack unreadable]'; }
      // The wrapper's own frames (and the eval that runs the script) mean
      // nothing to the script's author: cut the stack where they start.
      if (typeof st === 'string') {
        var cutAt = apply(indexOf, st, ['at eval (native)']);
        if (cutAt < 0) cutAt = apply(indexOf, st, ['internal-script-wrapper.js']);
        if (cutAt >= 0) {
          var lineStart = apply(lastIndexOf, st, ['\\n', cutAt]);
          st = apply(slice, st, [0, lineStart < 0 ? 0 : lineStart]);
        }
      }
      return head + (typeof st === 'string' && st !== '' ? '\\n' + cut(st, L.maxLog - 32 - head.length) : '');
    }
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
  // only, when given, maps just the argument indexes it marks true.
  function forwardMapped(fn, thisArg, mapper, only) {
    var forward = function () {
      var args = create(null), n = arguments.length;
      for (var ai = 0; ai < n; ai++) args[ai] = only && only[ai] !== true ? arguments[ai] : mapper(arguments[ai]);
      args.length = n;
      return apply(fn, thisArg, args);
    };
    // Keep the original's name and arity, which scripts may introspect.
    defineProperty(forward, 'name', { value: fn.name, configurable: true });
    defineProperty(forward, 'length', { value: fn.length, configurable: true });
    return forward;
  }
  // Ordinary objects, like the originals; they are filled before the script runs.
  var original = glob.console, safe = create(objectProto);
  for (var li = 0; li < L.levels.length; li++) safe[L.levels[li]] = forwardMapped(original[L.levels[li]], original, logArg);
  // Writable and configurable like the originals: a script that replaces them
  // only affects itself, since the bridge's console is reachable only from here.
  defineProperty(glob, 'console', { value: safe, writable: true, configurable: true });
  delete glob.InternalError;
  // The bridge vm.dump()s every object argument of a bim method (JSON
  // semantics), and that recursion has no stack check either (#11600). Each
  // object argument therefore goes through the wrapper's bounded serialiser
  // and native parse first: the bridge gets the same data, capped in depth
  // (except an Error, which JSON writes as {} where vm.dump kept its fields).
  function safeArg(a) {
    if (a === null || (typeof a !== 'object' && typeof a !== 'function')) return a;
    var text = ser(a, Infinity, false);
    return text === undefined ? undefined : parse(text);
  }
  // path is the dotted namespace ('query'); a method the schema lists bounds
  // only its dumped positions, one it does not list bounds every object.
  // safeArg, with a refusal named after the bim method it came from.
  function labelled(label) {
    return function (a) {
      try { return safeArg(a); }
      catch (e) { if (isInternal(e)) throw e; throw new TypeErrorCtor(label + ': ' + msg(e)); }
    };
  }
  function wrapMethods(source, level, path) {
    var target = create(objectProto), ks = keys(source);
    for (var wi = 0; wi < ks.length; wi++) {
      var member = source[ks[wi]], name = path === '' ? ks[wi] : path + '.' + ks[wi];
      var listed = L.dumped[name];
      target[ks[wi]] = typeof member === 'function' ? forwardMapped(member, source, labelled('bim.' + name), listed)
        : member !== null && typeof member === 'object' && level < 3 ? wrapMethods(member, level + 1, name)
        : member;
    }
    return target;
  }
  if (glob.bim !== null && typeof glob.bim === 'object') {
    defineProperty(glob, 'bim', { value: wrapMethods(glob.bim, 0, ''), writable: true, configurable: true });
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
  var safeJson = create(objectProto);
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
})(function () { return (0, eval)(${JSON.stringify(code)}); }, ${INTRINSICS_OBJECT}, ${JSON.stringify(LIMITS)})`;
}

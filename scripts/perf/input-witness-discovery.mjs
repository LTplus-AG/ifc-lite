/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Plain, self-contained callback. Registered once before upload; never waits,
// initializes a renderer, requests a frame, or mutates React/production state.
export function discoverViewerInput() {
  const fail = reason => { throw new Error(`REFUSE input witness: ${reason}`); };
  const canvas = document.querySelector('canvas');
  const key = canvas && Object.keys(canvas).find(name => name.startsWith('__reactFiber$'));
  let fiber = key && canvas[key], renderer, props, root;
  const parents = new Set();
  for (let count = 0; fiber && count < 200; count++, fiber = fiber.return) {
    if (parents.has(fiber)) fail('Fiber cycle');
    parents.add(fiber);
    if (!Number.isSafeInteger(fiber.tag) || fiber.tag < 0 || fiber.tag > 31) fail('unknown Fiber tag');
    if (fiber.tag === 3) {
      if (root && root !== fiber.stateNode) fail('ambiguous FiberRoot');
      root = fiber.stateNode;
    }
  }
  if (fiber || !root || root.current?.tag !== 3 || root.current.stateNode !== root) fail('FiberRoot unavailable/capped');
  // Return pointers may refer to an alternate during a bailout. Authorize the
  // canvas and its ancestors solely through committed current child edges.
  const stack = [{ fiber: root.current, path: [] }], visited = new Set(); let path, nodes = 0;
  while (stack.length) {
    if (++nodes > 65536) fail('current subtree work cap');
    const entry = stack.pop(), node = entry.fiber;
    if (!node || typeof node !== 'object' || !Number.isSafeInteger(node.tag)
      || node.tag < 0 || node.tag > 31 || visited.has(node)) fail('unknown/cyclic current subtree');
    visited.add(node);
    const currentPath = [...entry.path, node];
    if (currentPath.length > 200) fail('current subtree depth cap');
    if (node.tag === 5 && node.stateNode === canvas) {
      if (path) fail('ambiguous committed canvas');
      path = currentPath;
    }
    if (node.sibling) stack.push({ fiber: node.sibling, path: entry.path });
    if (node.child) stack.push({ fiber: node.child, path: currentPath });
  }
  if (!path) fail('canvas absent from committed current subtree');
  let hooks = 0;
  for (const fiber of path) {
    if (![0, 11, 14, 15].includes(fiber.tag)) continue;
    const seen = new Set(); let hook = fiber.memoizedState, countHooks = 0;
    for (; hook && countHooks < 2048 && hooks < 65536; countHooks++, hooks++, hook = hook.next) {
      if (typeof hook !== 'object' || (hook.next !== null && typeof hook.next !== 'object')) fail('unknown Hook shape');
      if (seen.has(hook)) fail('Hook cycle');
      seen.add(hook);
      const candidate = hook.memoizedState?.current;
      if (!candidate || typeof candidate.getScene !== 'function' || typeof candidate.isReady !== 'function') continue;
      if (renderer && renderer !== candidate) fail('ambiguous renderer');
      renderer = candidate;
      if (!Object.hasOwn(fiber.memoizedProps ?? {}, 'geometry')) continue;
      if (props && props !== fiber.memoizedProps) fail('ambiguous renderer-owning props');
      props = fiber.memoizedProps;
    }
    if (hook) fail('Hook discovery cap');
  }
  if (!renderer || !props) fail('incomplete/current renderer discovery');
  if (props.geometry !== null && !Array.isArray(props.geometry)) fail('unknown viewport input');
  return { renderer, props, canvas, scene: renderer.getScene(), parents: path.length, currentTreeNodes: nodes, hooks };
}

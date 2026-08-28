/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Where a host camera pose waits while a destructive load is in flight (#3390).
 *
 * `LOAD_MODEL` is not atomic from the store's point of view. The bridge awaits
 * `ctx.loadModelFromUrl`, which fetches the file and reads its body before it
 * ever calls `loadFile`, and `loadFile` is where `resetViewerState()` runs. So
 * a whole network round trip separates "the LOAD_MODEL message was handled"
 * from "the session was reset", and any `SET_CAMERA` the host posts in that
 * window is applied to the outgoing session and then destroyed by the reset.
 * The reverse order fails the same way: a pose set just before LOAD_MODEL is
 * armed as `pendingCameraRotation` and the same reset clears it. Both are
 * ACKed, and neither moves the camera. (`LOAD_MODEL_BUFFER` has no pre-reset
 * await, but it is routed through here too so the two commands cannot drift.)
 *
 * The reset itself is correct and stays: #3364/#3375 made a session reset
 * expire `pendingCameraRotation` because a pose armed against the OUTGOING
 * model was replaying onto the next file. What the store cannot see is which
 * model a pose was meant for. This module can, because it is the only place
 * that knows a destructive load is running.
 *
 * A readiness gate on the renderer — the other option #3390 lists — cannot
 * make that call. With a renderer already registered (a second load into a
 * live embed) it lets every pose straight through, so `loadModel(url)` then
 * `setCamera(...)` still aims the outgoing scene; it only ever separates
 * "renderer up" from "renderer down", which is not the question.
 *
 * The discriminator used here, and why it keeps #3364 closed. #3364's rule is
 * "a pose the OUTGOING model already showed must die with it", so the question
 * a load has to answer at its entry is whether there was an outgoing model at
 * all — `geometryResult`, the meshes on screen at the instant the load starts,
 * before `loadFile`'s reset is anywhere near. Given that:
 *
 *  - A pose that reached a renderer WHILE a model was on screen was shown on
 *    that model. Nothing is lifted, and the incoming model gets its default
 *    framing. That is exactly #3364's case, unchanged.
 *  - A pose that reached a renderer with NO model on screen was actuated
 *    against an empty scene. There was no outgoing model for it to have been
 *    shown on, so it is still intent for the model arriving and it is lifted.
 *    Codex found this half missing: the lift used to read only
 *    `pendingCameraRotation`, which `cameraSlice.ts` arms solely when no
 *    actuator was registered, so with a mounted `Viewport` a `SET_CAMERA`
 *    posted just before the first `LOAD_MODEL` left nothing behind to lift and
 *    the command was lost with `home()` framing over the top of it.
 *  - A pose sitting in `pendingCameraRotation` never reached any renderer, so
 *    it was never on screen for any model. At the moment a destructive load
 *    starts it can only be intent for the model arriving, and it is lifted out
 *    of the store into this module's queue, where the reset cannot reach it.
 *  - A pose commanded WHILE a destructive load runs is likewise intent for the
 *    incoming model, so it is queued instead of applied.
 *
 * Queuing a pose defers its EFFECT, so it has to defer the ACK with it.
 * `offerHostPose` resolves only once the pose has reached the store, which is
 * what makes `await v.setCamera(...); v.getScreenshot()` capture the pose the
 * host just asked for rather than the outgoing angle. Before #3390 the
 * actuator ran inside the SET_CAMERA handler and the ACK followed it, so the
 * ordering was free; a queue that ACKs on receipt breaks it silently.
 *
 * The queue is released by the load itself, not by a later render: once
 * `aroundDestructiveLoad` resolves, `loadFile` has returned, so the session
 * reset is already behind us and the ordinary `setCameraRotation` path is safe
 * again — it actuates if a renderer is registered and otherwise arms a fresh
 * replay that nothing is left in flight to clear. An earlier draft had the
 * embed's post-load effect pull the pose out instead, which put React's flush
 * order on the correctness path: under `act` the effect really does run before
 * the load's own continuation, and the pose was stranded until some unrelated
 * later load picked it up.
 *
 * What the component still needs is one bit, not the pose: whether the model
 * now on screen got a host pose, so the first-load auto-fit frames it with
 * `fitAll` instead of tweening it away with `home()`. That is a plain read
 * ({@link hostPoseAppliedToCurrentModel}), cleared by the next destructive
 * load, so no number of effect runs can consume it at the wrong moment.
 *
 * The queue is module state, and its owner is the embed component rather than
 * the bridge: the `?modelUrl=` auto-load drives `aroundDestructiveLoad` too,
 * and the bridge never sees it. Nothing resets it in production — the embed
 * mounts once and this state dies with the page — and deliberately so: hanging
 * the reset off the bridge effect's cleanup meant StrictMode's dev-only
 * mount -> cleanup -> remount zeroed the queue while the auto-load's fetch was
 * still outstanding. `resetCameraIntent` exists for tests.
 */

import type { GeometryResult } from '@ifc-lite/geometry';

import type { CameraRotation } from '@/store/types.js';

/** The slice of the store this module reads and drives. */
interface CameraIntentState {
  pendingCameraRotation: CameraRotation | null;
  setCameraRotation: (rotation: CameraRotation) => void;
  /**
   * The geometry on screen. Read at a destructive load's ENTRY, where it still
   * describes the OUTGOING model — `loadFile`'s `resetViewerState()` is a whole
   * fetch away — so "empty here" means no model has ever been shown in this
   * embed and a pose already actuated cannot have belonged to one.
   */
  geometryResult: GeometryResult | null;
}

/** The pose to apply to the model currently arriving, if the host asked for one. */
let queuedPose: CameraRotation | null = null;

/**
 * How many destructive (scene-replacing) loads are running. A counter rather
 * than a flag so two overlapping `LOAD_MODEL`s cannot release the queue early;
 * federated `ADD_MODEL` never resets the session and is deliberately not
 * counted here, so a `SET_CAMERA` during one still acts on the live scene.
 */
let destructiveLoadsInFlight = 0;

/**
 * Whether the model currently on screen arrived with a host pose applied to it.
 * Read (never consumed) by the embed's first-load framing; cleared when the
 * next destructive load starts, so it always answers for the newest model.
 */
let poseAppliedToCurrentModel = false;

/**
 * The last pose `offerHostPose` sent straight to the store, kept for the case
 * the store cannot represent: a live renderer actuates it and records nothing,
 * so with no model on screen yet there is no `pendingCameraRotation` for the
 * next load to lift. Only ever read when the store says no model has landed —
 * once one has, a pose that went straight through was shown on it and #3364
 * says it dies there.
 */
let poseActuatedSinceLastLoad: CameraRotation | null = null;

/**
 * Hosts still awaiting the ACK for a pose that is sitting in the queue.
 * Resolved together the moment the queue is drained, so no `setCamera()`
 * promise outlives the effect it is reporting — and none is left hanging by a
 * load that failed, which releases the queue on its way out too.
 *
 * Non-empty only while a destructive load is running: entries are added on
 * `offerHostPose`'s queued branch alone, and every load drains them as it
 * leaves. That is why the only other caller is `resetCameraIntent`, which a
 * test can reach mid-load and which would otherwise strand a promise.
 */
let queuedPoseWaiters: Array<() => void> = [];

/** Let every held ACK go. Safe to call when there are none. */
function settleQueuedPoseWaiters(): void {
  const waiting = queuedPoseWaiters;
  queuedPoseWaiters = [];
  for (const resolve of waiting) resolve();
}

/** Put the queue back to its initial state. For tests: no production caller
 *  resets this module, see the note on ownership above. */
export function resetCameraIntent(): void {
  queuedPose = null;
  destructiveLoadsInFlight = 0;
  poseAppliedToCurrentModel = false;
  poseActuatedSinceLastLoad = null;
  settleQueuedPoseWaiters();
}

/**
 * Did the host command the pose the current model is sitting at?
 *
 * `home()` would animate it away, so the embed's first-load auto-fit frames
 * with `fitAll` instead when this is true (`useEmbedPostLoad.ts`). A read, not
 * a take: the effect that asks can run more than once per load, and consuming
 * the answer on the first of those runs is how the framing loses it.
 */
export function hostPoseAppliedToCurrentModel(): boolean {
  return poseAppliedToCurrentModel;
}

/** Clamped, because a test can call `resetCameraIntent` between cases while a
 *  load is still pending; a negative count would leave every later pose
 *  unqueueable. */
function endDestructiveLoad(): void {
  destructiveLoadsInFlight = Math.max(0, destructiveLoadsInFlight - 1);
}

/**
 * Take the host's `SET_CAMERA` pose.
 *
 * With no destructive load running this is today's path exactly — straight to
 * `setCameraRotation`, which actuates the renderer or arms the store's replay
 * buffer if none has registered yet (#2934). With one running the pose is held
 * until the incoming model lands, because applying it now aims the outgoing
 * scene and the load's reset then discards it.
 *
 * Resolves when the pose has reached the store — immediately on the direct
 * path, at the end of the load on the queued one. The bridge ACKs `SET_CAMERA`
 * on that promise, so a host awaiting `setCamera()` still gets the guarantee it
 * had before the queue existed: the next command it sends sees the new angle.
 */
export function offerHostPose(
  pose: CameraRotation,
  getState: () => CameraIntentState,
): Promise<void> {
  if (destructiveLoadsInFlight > 0) {
    queuedPose = pose;
    // Held, so the ACK is held with it: the SDK's `setCamera()` promise is the
    // host's only ordering primitive, and resolving it here would let the next
    // awaited command run against the scene this load is replacing.
    //
    // It inherits the SDK's 30 s per-request timeout (`embed-sdk/src/index.ts`
    // `request`), which is the same ceiling the `LOAD_MODEL` it is waiting on
    // already sits under — a load slow enough to time this out has failed the
    // host's `loadModel()` call too, so it is not a new way to fail.
    return new Promise<void>((resolve) => { queuedPoseWaiters.push(resolve); });
  }
  // A direct command supersedes anything left queued by a load that never
  // delivered a model, so a stale pose cannot resurface at the next load.
  queuedPose = null;
  getState().setCameraRotation(pose);
  poseActuatedSinceLastLoad = pose;
  return Promise.resolve();
}

/**
 * Run one scene-replacing load with the camera queue held open across it.
 *
 * Wrapping rather than exposing a begin/end pair keeps the two halves balanced
 * at every call site: an unbalanced increment would leave every later
 * `SET_CAMERA` queued forever.
 *
 * The load is taken as a function plus its arguments rather than a closure so
 * the bridge can hand over `ctx.loadModelFromUrl` directly. `ctx` is a mutable
 * module-level binding, so TypeScript drops its non-null narrowing inside a
 * callback; `BridgeContext`'s members are plain function properties (its
 * `getState` is already passed detached, right here), so forwarding one costs
 * nothing and keeps the null check where it already is.
 */
export async function aroundDestructiveLoad<A extends unknown[], R>(
  getState: () => CameraIntentState,
  load: (...args: A) => Promise<R>,
  ...args: A
): Promise<R> {
  destructiveLoadsInFlight += 1;
  // A new model is arriving, so whatever the outgoing one was framed for stops
  // being the answer to "did the host pose this?".
  poseAppliedToCurrentModel = false;
  // Lift an unactuated pose out of the store before the reset can clear it.
  // The store copy is deliberately left alone: on a load that fails no reset
  // runs, and the store's own replay must keep working as it did.
  //
  // Only when the queue is empty, and that guard is load-bearing rather than
  // defensive. The reset that clears `pendingCameraRotation` runs inside
  // `loadFile`, a whole fetch after the load starts, so a SECOND destructive
  // load beginning in that window still reads the FIRST load's pose out of the
  // store. Re-lifting it would overwrite whatever the host queued in between
  // and end the camera on a command the host had already superseded — the same
  // ACKed-but-wrong failure this module exists to close.
  //
  // A queued pose here is always the newer of the two: `offerHostPose` reaches
  // the store only on its no-load path, which clears `queuedPose` first, so
  // anything left in the queue was commanded after the store's copy was armed.
  //
  // With a renderer already up the store keeps no copy at all, so the second
  // source is this module's own record of the last pose that went straight
  // through — admissible only while the scene has never held a model, which is
  // the line between "actuated against nothing" and #3364's "shown on the
  // model that is leaving".
  const state = getState();
  // `geometryResult !== null`, NOT `meshes.length > 0`. A spatial-only IFC --
  // storeys and spaces with no geometry -- loads to a non-null result holding
  // ZERO meshes, and that is a real state in this repo rather than a
  // pathological one. Counting meshes would call such a model "never shown",
  // re-lift a pose the user watched it at, and replay it onto the next file:
  // #3364 re-opened for exactly the model class least likely to be tested.
  // The question is whether a model was ever LOADED, which is what the field's
  // nullness answers.
  const everLoaded = state.geometryResult != null;
  const neverShown = state.pendingCameraRotation
    ?? (everLoaded ? null : poseActuatedSinceLastLoad);
  poseActuatedSinceLastLoad = null;
  if (neverShown && queuedPose === null) queuedPose = neverShown;

  try {
    const result = await load(...args);
    endDestructiveLoad();
    // Past `loadFile`, so past `resetViewerState()`: the pose can go to the
    // store now and nothing is left to discard it.
    if (releaseQueuedPose(getState)) poseAppliedToCurrentModel = true;
    return result;
  } catch (err) {
    endDestructiveLoad();
    // A load that failed replaced nothing and reset nothing, so there is no
    // incoming model for the queued pose to wait for and no reset it needed
    // protecting from. Apply it to the scene that is still on screen, which is
    // where it would have landed before this queue existed. Leaving it queued
    // would be worse than losing it: it would surface on some later load and
    // aim a model the host never asked about. The framing bit stays false —
    // no model arrived to frame.
    releaseQueuedPose(getState);
    throw err;
  }
}

/**
 * Hand any queued pose to the store, once no destructive load is still running.
 * Returns whether a pose was applied.
 */
function releaseQueuedPose(getState: () => CameraIntentState): boolean {
  if (destructiveLoadsInFlight > 0) return false;
  const pose = queuedPose;
  queuedPose = null;
  if (pose) getState().setCameraRotation(pose);
  // After the actuation, never before: the ACK's whole job is to say the
  // camera has already moved.
  settleQueuedPoseWaiters();
  return pose !== null;
}

// SPDX-License-Identifier: MPL-2.0
// Evidence-only supplemental admission. Does not launch, retry or rewrite samples.
// node join.mjs PLAN.json SIDECARS ORIGINAL-STRICT-SUMMARY.json NEW-OUTPUT.json
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { validateAnchors } from './anchors.mjs';
import { validateFrameTimes, sidecarPath, validateVideoTimebase } from './contracts.mjs';
const [planFile, sidecars, strictFile, output] = process.argv.slice(2);
if (!planFile || !sidecars || !strictFile || !output || fs.existsSync(output)) throw Error('Explicit plan, sidecars, original strict summary and NEW output required');
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const must = (value, why) => { if (!value) throw Error(why); };
const finite = value => typeof value === 'number' && Number.isFinite(value);
const bytes = file => fs.readFileSync(file);
const json = file => JSON.parse(bytes(file));
const protocol = 'ifc6940-native-recording-matched-v1';
const report = { schema: 1, protocol, preparedOnlyChecker: false, at: new Date().toISOString(), recordingAdmissionPassed: false,
  performanceQualified: false, sourceHeadsSelectedByChecker: false, rows: [], errors: [],
  scope: 'Supplemental recorded-T3 lifecycle/cadence/video admission only. Original strict/canonical verdicts remain authoritative and unchanged. No unrecorded performance or continuous30Hz guarantee.',
  limits: ['Joins actual supplied tool/page/video receipts; does not attest to unrecorded tool activity or unknown native recorder bugs.', 'Native video decoding/inspection receipts are separately executed outside timers; this checker does not decode video.', 'Pre/post cadence does not discard or adjust slow in-timer frames.'],
  checkerSha256: sha(bytes(new URL(import.meta.url))) };
const usedTabs = new Set(), usedArtifacts = new Set(), usedFiles = new Set(), usedNonces = new Set();
function load(ref, binary = false) {
  must(ref && typeof ref.path === 'string' && path.isAbsolute(ref.path) && /^[a-f0-9]{64}$/.test(ref.sha256), 'Explicit absolute receipt path/hash required');
  const raw = bytes(ref.path); must(sha(raw) === ref.sha256, `Receipt hash differs: ${ref.path}`);
  if (binary) return raw;
  let result = JSON.parse(raw);
  // A caller must name the exact actual tool-result envelope; no synthesized value.
  if (ref.pointer) {
    must(ref.pointer.startsWith('/'), 'JSON pointer must start with /');
    for (const part of ref.pointer.slice(1).split('/')) {
      const key = part.replaceAll('~1', '/').replaceAll('~0', '~');
      must(result != null && Object.hasOwn(result, key), 'Missing actual JSON pointer field'); result = result[key];
    }
  }
  return result;
}
function cadence(probe, phase, sample, tabId, epoch) {
  must(probe.protocol === protocol && probe.statusKind === 'timed' && probe.phase === phase && probe.id === sample.id && probe.tabId === tabId, 'Cadence identity mismatch');
  must(probe.source?.head === sample.expectedSource && probe.source?.side === sample.side && probe.source?.epoch === epoch, 'Cadence source/epoch mismatch');
  must(probe.viewport?.innerWidth === 1280 && probe.viewport?.innerHeight === 800 && finite(probe.viewport.devicePixelRatio), 'Cadence viewport missing');
  must(probe.finished === true && probe.timeout === false, 'Cadence did not explicitly finish without timeout');
  must(probe.samples?.length === 60 && finite(probe.startNow) && finite(probe.finishNow) && finite(probe.timeOrigin), 'Complete actual60-callback probe required');
  must(probe.finishNow >= probe.startNow && probe.finishNow - probe.startNow <= 3000, 'Nominal cadence probe exceeded3000ms');
  validateFrameTimes(probe.samples.map(s => s.timestamp), probe.startNow, probe.finishNow, must);
  const intervals = [];
  for (let i = 0; i < 60; i++) {
    const s = probe.samples[i];
    must(s.visibility === 'visible' && s.hasFocus === true, 'Invalid/hidden/unfocused callback');
    if (i) intervals.push(s.timestamp - probe.samples[i - 1].timestamp);
  }
  const nominal = 1000 / 30, limit = nominal * 0.03;
  must(intervals.every(dt => dt > 0 && Math.abs(dt - nominal) <= limit), 'Actual inter-frame interval outside nominal30Hz±3% prerequisite');
  return { count: intervals.length, nominalMs: nominal, absoluteDeviationLimitMs: limit,
    minimumMs: Math.min(...intervals), maximumMs: Math.max(...intervals),
    medianMs: [...intervals].sort((a, b) => a - b)[29], totalProbeMs: probe.finishNow - probe.startNow };
}
try {
  const plan = json(planFile), strict = json(strictFile);
  report.plan = { path: path.resolve(planFile), sha256: sha(bytes(planFile)) };
  report.strictSummary = { path: path.resolve(strictFile), sha256: sha(bytes(strictFile)), qualified: strict.qualified };
  must(plan.recordingPolicy?.protocol === protocol && plan.recordingPolicy?.checkerSha256 === report.checkerSha256, 'Plan did not freeze this supplemental checker');
  must(plan.recordingPolicy?.contractsSha256 === sha(bytes(new URL('contracts.mjs', import.meta.url))), 'Plan did not freeze shared frame/discovery contracts');
  must(plan.recordingPolicy?.anchorJoinSha256 === sha(bytes(new URL('anchors.mjs', import.meta.url))), 'Plan did not freeze anchor join helper');
  must(plan.recordingPolicy?.policySha256 === sha(bytes(new URL('README.md', import.meta.url))), 'Policy prose differs from frozen plan');
  const originals = {
    collector: '470f3febe606b7f4d9677e486a4dc5d6b98d851a1fd98d7bb8b02a425159dc17',
    reportWrapper: '3fa1e9b34f260cdf9a856dc3921b5da271a84fe9907faf99b851b6629957db26',
    reporter: '40ef0f8f677c9361ee671e86db0131834197e8d57328985693d3d4acba109e1d',
    hostObserver: '28fbde1659c9bf1183f4834421602e2ba7bf5587a81e414da0acc4fc8fa96f40',
    hostWindowsObserver: '6eaa816aa0209cfb723123285b1f1c7d8a1c056464ff41ef728619a18b4613c6',
  };
  for (const [key, expected] of Object.entries(originals)) {
    must(plan[key]?.sha256 === expected && sha(bytes(plan[key].path)) === expected, `Original ${key} changed`);
  }
  must(strict.plan?.sha256 === report.plan.sha256 && strict.rows?.length === 30 && strict.missing?.length === 0, 'Original strict report missing/wrong/incomplete');
  must(plan.samples?.every(s => /^[a-f0-9]{40}$/.test(s.expectedSource) && s.expectedSource === plan.manifests[s.side]?.head), 'Immutable source heads not frozen');
  must(plan.samples?.length === 30 && new Set(plan.samples.map(s => s.id)).size === 30, 'Complete unique30 plan required');
  for (const fixture of ['fzk', 'issue129', 'holter']) for (let round = 1; round <= 5; round++) for (const side of ['base', 'branch']) {
    must(plan.samples.filter(s => s.fixture === fixture && s.pair === round && s.side === side).length === 1, 'Missing/duplicate matched fixture/round/arm');
  }
  // Both arms' heavy-fixture artifact feasibility must be real, prior and source-matched.
  report.feasibility = [];
  for (const side of ['base', 'branch']) {
    const ref = plan.recordingPolicy.feasibility?.[side], f = load(ref);
    must(f.schema === 1 && f.statusKind === 'functional' && f.protocol === protocol && f.functionalOnly === true && f.fixture === 'holter' && f.side === side && f.sourceHead === plan.manifests[side].head, 'Actual source-matched untimed Holter feasibility absent');
    must(f.complete === true && f.artifactValidated === true && f.recordingContinuousThroughSettling === true && f.noTimingQualification === true, 'Holter feasibility incomplete');
    must(f.validationReport, 'Holter feasibility underlying validation absent');
    const validation = load(f.validationReport);
    const validator = plan.recordingPolicy.nativeHistoryValidator;
    must(validator && path.isAbsolute(validator.path) && /^[a-f0-9]{64}$/.test(validator.sha256)
      && sha(bytes(validator.path)) === validator.sha256 && validation.validatorSHA256 === validator.sha256,
    'Holter feasibility validator is not the frozen reviewed source');
    must(validation.ok === true && validation.statusKind === 'functional' && validation.lifecycleCoverageVerified === true
      && validation.actualCompleteNativeHistoryReviewed === true && validation.recordingInterrupted === false
      && validation.performanceQualified === false, 'Holter feasibility underlying functional validation incomplete');
    const exported={...f};delete exported.validationReport;
    must(isDeepStrictEqual(exported, validation.functionalFeasibility), 'Holter summary borrowed from a different validation/source');
    must(validation.actualInputs && Object.keys(validation.actualInputs).length > 0, 'Holter validation input closure absent');
    for (const [file, digest] of Object.entries(validation.actualInputs)) {
      must(path.isAbsolute(file) && /^[a-f0-9]{64}$/.test(digest) && sha(bytes(file)) === digest,
        'Holter validation input changed since actual review');
    }
    must(validation.nativeHistory && validation.actualInputs[validation.nativeHistory.path] === validation.nativeHistory.sha256,
      'Holter validation is not bound to its actual native history');
    for(const [key,field]of [['nativeHistoryRecorder','recorderSHA256'],['nativeHistoryEmitter','emitterSHA256'],['nativeHistoryDynamicHelper','dynamicHelperSHA256'],['canonicalPayloadValidator','canonicalPayloadValidatorSHA256'],['releaseGenerator','releaseGeneratorSHA256'],['functionalPrepareGenerator','functionalPrepareGeneratorSHA256']]){
      const helper=plan.recordingPolicy[key];must(helper&&path.isAbsolute(helper.path)&&/^[a-f0-9]{64}$/.test(helper.sha256)&&sha(bytes(helper.path))===helper.sha256&&validation[field]===helper.sha256,'Holter feasibility helper source differs from frozen plan: '+key);
    }
    must(isDeepStrictEqual(f.recordingMode,plan.recordingPolicy.configuredMode),'Holter feasibility recording mode differs from timed plan');
    const completed=f.validationCompletedClock,sealed=f.nativeHistorySealedClock;
    must(completed&&sealed&&isDeepStrictEqual(completed,validation.validationCompletedClock)&&isDeepStrictEqual(sealed,validation.nativeHistorySealedClock)&&isDeepStrictEqual(completed.clockDomain,sealed.clockDomain)&&/^[0-9]+$/.test(completed.monotonicNs)&&/^[0-9]+$/.test(sealed.monotonicNs)&&BigInt(completed.monotonicNs)>=BigInt(sealed.monotonicNs),'Holter actual completion clock missing/inconsistent');
    report.feasibility.push({ side, ...ref,validationCompletedClock:f.validationCompletedClock });
  }
  let lastStopOrdinal = -1, recordingMode, recordingTimebase;
  for (const [index, sample] of plan.samples.entries()) {
    const row = { id: sample.id, side: sample.side, fixture: sample.fixture, pair: sample.pair, ok: false };
    report.rows.push(row);
    try {
      const file = sidecarPath(sidecars, index, sample); row.sidecar = { path: path.resolve(file), sha256: sha(bytes(file)) };
      const s = json(file);
      must(s.schema === 1 && s.protocol === protocol && s.id === sample.id && s.side === sample.side && s.fixture === sample.fixture && s.pair === sample.pair, 'Sidecar/sample identity mismatch');
      must(typeof s.tabId === 'string' && !usedTabs.has(s.tabId), 'Tab lifecycle reused/missing'); usedTabs.add(s.tabId);
      const intent = load(s.intent), start = load(s.start), pre = load(s.preCadence), post = load(s.postCadence), stop = load(s.stop), timed = load(s.timedReceipt), journal = load(s.journal);
      must(intent.id === sample.id && intent.tabId === s.tabId && intent.protocol === protocol && intent.expectedSource === sample.expectedSource && intent.fixtureSha256 === sample.fixtureIdentity.sha256, 'Pre-start intent differs');
      must(start.recording === true && start.tabId === s.tabId && Number.isFinite(Date.parse(start.startedAt)), 'Native recording start did not succeed');
      must(stop.tabId === s.tabId && typeof stop.id === 'string' && !usedArtifacts.has(stop.id), 'Native stop artifact missing/reused'); usedArtifacts.add(stop.id);
      must(timed.id === sample.id && timed.side === sample.side && timed.pair === sample.pair && timed.fixture === sample.fixture && timed.ok === true && timed.payload?.schema === 3 && timed.collectorSha256 === originals.collector, 'Actual timed receipt failed/mismatched');
      must(timed.server?.manifest?.head === sample.expectedSource && timed.server.manifest.distManifestSha256 === plan.manifests[sample.side].distManifestSha256 && timed.fixtureIdentity?.sha256 === sample.fixtureIdentity.sha256, 'Actual timed source/build/fixture differs');
      const strictRow = strict.rows.find(r => r.receipt?.sha256 === s.timedReceipt.sha256);
      must(strictRow?.receipt?.sha256 === s.timedReceipt.sha256 && strictRow.side === sample.side && strictRow.fixture === sample.fixture && strictRow.round === sample.pair, 'Sidecar not joined to actual original strict row');
      must(journal.complete === true && Array.isArray(journal.events), 'Complete owned native recording tool journal required');
      const events = journal.events, kinds = ['intent', 'recording-start', 'pre-marker-show', 'pre-marker-remove', 'pre-cadence', 'host-observation', 'upload-release', 'settling-complete', 'collector-durable', 'post-cadence', 'post-marker-show', 'post-marker-remove', 'recording-stop', 'artifact-validated', 'anchors-validated'];
      const event = kind => events.find(e => e.kind === kind);
      must(events.length === kinds.length, 'Unexpected/missing recording lifecycle event or restart');
      for (let i = 0; i < kinds.length; i++) must(events[i].kind === kinds[i] && events[i].tabId === s.tabId && Number.isSafeInteger(events[i].ordinal) && events[i].ordinal > (i ? events[i - 1].ordinal : lastStopOrdinal), 'Lifecycle order/tab differs');
      lastStopOrdinal = events.at(-1).ordinal;
      for (const [kind, ref] of [['intent', s.intent], ['recording-start', s.start], ['pre-cadence', s.preCadence], ['post-cadence', s.postCadence], ['recording-stop', s.stop]]) must(events.find(e => e.kind === kind).receiptSha256 === ref.sha256, 'Journal/raw receipt hash mismatch');
      const host = load(event('host-observation').receipt), release = load(event('upload-release').receipt);
      must(JSON.stringify(host) === JSON.stringify(timed.externalAdmission) && host.quiet === true && host.policy?.version === 'native-host-v12-departure-observation' && host.policy.minimumLinuxKiB === 41943040 && host.policy.maximumWindowsCpuPercent === 10, 'Actual recording-time host observation missing/different');
      must(host.linux?.activeGraphs?.length === 0 && host.linux.MemAvailableKiB >= 41943040 && host.windows?.length === 3 && host.windows.every(w => finite(w.totalProcessorPercent) && w.totalProcessorPercent <= 10), 'Original host thresholds failed');
      must(release.released === true && event('upload-release').sampleId === sample.id, 'Actual collector release failed');
      const settled = load(event('settling-complete').receipt), durable = load(event('collector-durable').receipt);
      must(settled.id === sample.id && ['hashing-outside-timer', 'persisting', 'done'].includes(settled.stage), 'Recording stop boundary lacks actual settling-complete witness');
      must(durable.id === sample.id && durable.stage === 'done' && durable.persistence === 'saved', 'Collector not durably complete');
      row.preCadence = cadence(pre, 'pre', sample, s.tabId, timed.epoch);
      row.postCadence = cadence(post, 'post', sample, s.tabId, timed.epoch);
      must(pre.timeOrigin === post.timeOrigin && pre.finishNow < timed.uploadStart && post.startNow >= timed.observedReady && post.startNow > pre.finishNow, 'Cadence/timer clocks or sequence differ');
      must(pre.viewport.devicePixelRatio === timed.environment?.viewport?.devicePixelRatio && post.viewport.devicePixelRatio === pre.viewport.devicePixelRatio, 'DPR changed');
      must(post.collector?.id === sample.id && post.collector?.stage === 'done' && post.collector?.persistence === 'saved', 'Postflight precedes actual durable collector');
      const video = load(s.video, true), inspection = load(s.videoInspection);
      must(event('artifact-validated').receiptSha256 === s.videoInspection.sha256, 'Final artifact validation not journal-bound');
      const probe = load(inspection.ffprobeOutput), decoderStderr = load(inspection.decoderStderr, true);
      const videoStream = probe.streams?.filter(stream => stream.codec_type === 'video');
      must(videoStream?.length === 1 && Number.isFinite(Number(probe.format?.duration)) && Number(probe.format.duration) > 0, 'Actual video stream/duration absent');
      must(inspection.videoPath === s.video.path && inspection.decodeCommand?.includes(s.video.path) && inspection.probeCommand?.includes(s.video.path) && decoderStderr.length === 0, 'Decode/probe inputs/errors not bound to artifact');
      must(inspection.durationSeconds === Number(probe.format.duration), 'Derived duration differs from raw probe');
      must(!usedFiles.has(s.video.path) && stop.path === s.video.path && stop.sizeBytes === video.length && video.length > 0 && video.length <= 50 * 1024 * 1024, 'Video wrong/reused/truncated/over transfer limit'); usedFiles.add(s.video.path);
      must(inspection.videoSha256 === s.video.sha256 && inspection.decodeExitCode === 0 && inspection.noDecodeErrors === true && inspection.complete === true && inspection.monotoneFrameTimestamps === true && inspection.videoFrameCount > 0, 'Complete artifact decode/frame inspection missing');
      must(inspection.durationSeconds >= (post.finishNow - pre.startNow) / 1000, 'Artifact shorter than full observed lifecycle');
      row.anchors = validateAnchors({s, sample, pre, post, timed, journal, inspection, probe, plan, event, load, must, sha, bytes,feasibility:report.feasibility});
      must(!usedNonces.has(row.anchors.nonce),'Optical nonce reused across sample lifecycles');usedNonces.add(row.anchors.nonce);
      const mode = JSON.stringify(inspection.configuredMode);
      must(inspection.configuredMode?.nativeTool === 'preview_recording_start' && inspection.configuredMode?.captureMode === 'native-default' && inspection.configuredMode?.width === videoStream[0].width && inspection.configuredMode?.height === videoStream[0].height && inspection.configuredMode?.codec === videoStream[0].codec_name && Number.isSafeInteger(videoStream[0].width) && videoStream[0].width > 0 && Number.isSafeInteger(videoStream[0].height) && videoStream[0].height > 0, 'Actual recording mode/dimensions missing');
      recordingMode ??= mode; must(mode === recordingMode && mode === JSON.stringify(plan.recordingPolicy.configuredMode), 'Configured recording mode changed or was not frozen from untimed feasibility');
      recordingTimebase = validateVideoTimebase(videoStream[0].time_base, inspection.observedTimeBase, recordingTimebase, must);
      // Average encoded FPS is deliberately NOT a setting: dropped/slow frames remain evidence.
      row.video = { ...s.video, bytes: video.length, artifactId: stop.id, inspection: s.videoInspection, timebase: recordingTimebase }; row.ok = true;
    } catch (error) { row.error = error.message; report.errors.push(sample.id + ': ' + error.message); }
  }
  report.recordingAdmissionPassed = report.rows.length === 30 && report.rows.every(r => r.ok) && report.errors.length === 0;
  report.originalStrictQualified = strict.qualified === true;
  // This checker never computes or grants a performance verdict, including when strict=true.
} catch (error) { report.errors.push(error.message); }
fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify({ recordingAdmissionPassed: report.recordingAdmissionPassed, rows: report.rows.length, errors: report.errors }));
process.exitCode = report.recordingAdmissionPassed ? 0 : 1;

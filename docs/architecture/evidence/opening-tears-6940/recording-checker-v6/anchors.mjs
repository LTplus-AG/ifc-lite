// SPDX-License-Identifier: MPL-2.0
import { validateFrameTimes } from './contracts.mjs';
import { isDeepStrictEqual } from 'node:util';
// Evidence-only conjunctive anchor/lifecycle join; no runtime or timing mutation.
export function validateAnchors({s, sample, pre, post, timed, journal, inspection, probe, plan, event, load, must, sha, bytes,feasibility}) {
  const finite = x => typeof x === 'number' && Number.isFinite(x);
  const refs = s.markers;
  must(refs && s.anchorDetection && s.lifecycleCoverage, 'Complete actual marker/detection/lifecycle refs required');
  const names=['preShow','preRemove','postShow','postRemove'];
  const markers=Object.fromEntries(names.map(k=>[k,load(refs[k])]));
  const tokens=new Set();
  for(const name of names){
    const a=markers[name], phase=name.startsWith('pre')?'pre':'post', action=name.endsWith('Show')?'show':'remove';
    must(a.protocol==='ifc6940-media-anchor-v1' && a.statusKind==='timed' && a.phase===phase && a.action===action && a.id===sample.id && a.tabId===s.tabId, 'Marker identity mismatch');
    must(a.head===sample.expectedSource && a.side===sample.side && a.epoch===timed.epoch && a.source?.head===a.head && a.source?.side===a.side && a.source?.epoch===a.epoch, 'Marker source/epoch mismatch');
    must(/^[a-f0-9]{32}$/.test(a.nonce) && /^[a-f0-9]{32}$/.test(a.token) && a.finished===true && a.markerPresent===(action==='show'), 'Marker completion/removal absent');
    must(a.generatorSha256===plan.recordingPolicy.markerGenerator?.sha256,'Actual marker generator differs from frozen plan');
    const identity={protocol:a.protocol,statusKind:a.statusKind,phase:a.phase,id:a.id,tabId:a.tabId,head:a.head,side:a.side,epoch:a.epoch,nonce:a.nonce};
    must(sha(Buffer.from(JSON.stringify(identity))).slice(0,32)===a.token,'Marker digest differs');
    must(a.timeOrigin===pre.timeOrigin && finite(a.startNow) && finite(a.finishNow) && a.finishNow>=a.startNow && a.finishNow-a.startNow<=3000,'Marker clock/deadline differs');
    must(a.frames?.length===(action==='show'?60:3) && Array.isArray(a.frames),'Actual marker paint callbacks absent');
    validateFrameTimes(a.frames, a.startNow, a.finishNow, must);
    must(a.viewport?.innerWidth===1280 && a.viewport?.innerHeight===800 && a.viewport?.devicePixelRatio===pre.viewport.devicePixelRatio && JSON.stringify(a.rect)===JSON.stringify({x:24,y:24,width:160,height:160}),'Marker viewport/rectangle differs');
    if(phase==='pre')for(const status of [a.collectorBefore,a.collectorAfter])must(status==null||(status.id===sample.id&&status.stage==='prepared-awaiting-host-admission'),'PRE marker during sampling');
    if(phase==='post')for(const status of [a.collectorBefore,a.collectorAfter])must(status?.id===sample.id&&status.stage==='done'&&status.persistence==='saved','POST marker before durable output');
    const kind=phase+'-marker-'+action;must(event(kind).receiptSha256===refs[name].sha256,'Marker raw tool receipt not journal-bound');
    tokens.add(a.token);
  }
  must(tokens.size===2 && names.every(k=>markers[k].nonce===markers.preShow.nonce),'Marker phases/nonces differ');
  must(markers.preShow.token===markers.preRemove.token && markers.postShow.token===markers.postRemove.token,'Wrong marker removed');
  must(markers.preShow.finishNow<markers.preRemove.startNow && markers.preRemove.finishNow<pre.startNow && pre.finishNow<timed.uploadStart,'PRE marker not removed before admission/timer');
  must(post.finishNow<markers.postShow.startNow && markers.postShow.finishNow<markers.postRemove.startNow,'POST marker does not bracket postflight');
  const detected=load(s.anchorDetection), manifest=load(s.anchorInputManifest);
  must(detected.decodeExitCode===0 && load(detected.decoderStderr,true).length===0,'Actual optical decode errors/exit not bound');
  must(detected.ok===true && !detected.error && detected.inputsUnchanged===true && detected.protocol==='ifc6940-media-anchor-v1' && detected.performanceQualified===false,'Optical detection incomplete');
  must(detected.manifestSHA256===s.anchorInputManifest.sha256 && event('anchors-validated').receiptSha256===s.anchorDetection.sha256,'Actual detector input/output not bound');
  for(const [key,expected] of [['video',s.video],['inspection',s.videoInspection],['pre',refs.preShow],['post',refs.postShow]]){
    must(JSON.stringify(manifest[key])===JSON.stringify(expected)&&JSON.stringify(detected.inputs?.[key])===JSON.stringify(expected),'Optical input reference differs');
    load(expected,key==='video');
  }
  must(JSON.stringify(detected.inputs.ffprobeOutput)===JSON.stringify(inspection.ffprobeOutput),'Optical PTS reference differs');
  must(plan.recordingPolicy.anchorDetector?.sha256===detected.detectorSHA256 && sha(bytes(plan.recordingPolicy.anchorDetector.path))===detected.detectorSHA256,'Unfrozen optical detector');
  must(plan.recordingPolicy.markerGenerator?.sha256===sha(bytes(plan.recordingPolicy.markerGenerator.path)),'Unfrozen marker generator');
  const frames=probe.frames.filter(f=>f.media_type==='video');
  must(detected.videoSHA256===s.video.sha256 && detected.decodedFrames===frames.length && frames.length===inspection.videoFrameCount,'Incomplete optical frame stream');
  must(detected.command?.includes(s.video.path)&&detected.command.includes('passthrough')&&detected.matches?.length===2,'Detector invocation incomplete');
  function rational(x){const [a,b='1']=String(x).split('/');return [BigInt(a),BigInt(b)];}
  const timeBase=rational(detected.timeBase);must(detected.timeBase===inspection.observedTimeBase,'Optical time base differs');
  for(let j=0;j<2;j++){
    const match=detected.matches[j],a=j?markers.postShow:markers.preShow;
    must(match.phase===a.phase&&match.token===a.token&&match.frames.length>=3&&match.pts.length===match.frames.length,'Optical phase/token missing');
    must(match.frames.every((v,i)=>Number.isSafeInteger(v)&&v>=0&&v<frames.length&&(!i||v>match.frames[i-1])),'Invalid matched frame index');
    must(match.frames.some((v,i)=>i>=2&&v===match.frames[i-1]+1&&v===match.frames[i-2]+2),'No three consecutive optical frames');
    match.frames.forEach((index,i)=>{const pt=rational(match.pts[i]);must(BigInt(frames[index].best_effort_timestamp)*timeBase[0]*pt[1]===pt[0]*timeBase[1],'Optical frame PTS differs');});
  }
  must(detected.matches[0].frames.at(-1)<detected.matches[1].frames[0],'Optical anchors out of order');
  // Media integrity is deliberately distinct from actual native lifecycle review.
  const coverage=load(s.lifecycleCoverage);
  must(coverage.ok===true && coverage.statusKind==='timed' && coverage.performanceQualified===false && coverage.lifecycleCoverageVerified===true && coverage.recordingInterrupted===false && coverage.actualCompleteNativeHistoryReviewed===true,'Native timed lifecycle still unverified');
  const validator=plan.recordingPolicy.nativeHistoryValidator;
  must(validator && /^[a-f0-9]{64}$/.test(validator.sha256) && sha(bytes(validator.path))===validator.sha256 && coverage.validatorSHA256===validator.sha256,'Native history validator source differs from frozen plan');
  for(const [key,field]of [['nativeHistoryRecorder','recorderSHA256'],['nativeHistoryEmitter','emitterSHA256'],['nativeHistoryDynamicHelper','dynamicHelperSHA256'],['canonicalPayloadValidator','canonicalPayloadValidatorSHA256'],['releaseGenerator','releaseGeneratorSHA256']]){
    const helper=plan.recordingPolicy[key];must(helper&&/^[a-f0-9]{64}$/.test(helper.sha256)&&sha(bytes(helper.path))===helper.sha256&&coverage[field]===helper.sha256,'Native timed helper source differs: '+key);
  }
  const actualHistory=load(coverage.nativeHistory),initial=load(actualHistory.initialization);
  must(isDeepStrictEqual(initial.clock,coverage.nativeHistoryInitializationClock),'Actual native initialization clock differs');
  must(feasibility?.length===2,'Both actual feasibility completion clocks required');
  for(const f of feasibility){const clock=f.validationCompletedClock;must(clock&&isDeepStrictEqual(clock.clockDomain,initial.clock.clockDomain)&&/^[0-9]+$/.test(clock.monotonicNs)&&/^[0-9]+$/.test(initial.clock.monotonicNs)&&BigInt(initial.clock.monotonicNs)>=BigInt(clock.monotonicNs),'Timed history began before source-matched Holter feasibility completed');}
  must(coverage.actualInputs && Object.keys(coverage.actualInputs).length>0,'Complete native lifecycle input closure absent');
  for(const [file,digest] of Object.entries(coverage.actualInputs)){
    // load performs absolute-path/hash validation; binary mode preserves actual bytes.
    load({path:file,sha256:digest},true);
  }
  for(const ref of [s.start,s.stop,s.preCadence,s.postCadence,...Object.values(refs),s.video,s.videoInspection,s.anchorDetection,s.anchorInputManifest,s.journal,s.timedReceipt,coverage.nativeHistory]){
    must(ref && coverage.actualInputs[ref.path]===ref.sha256,'Native lifecycle review borrowed from different actual inputs');
  }
  for(const [key,ref] of [['video',s.video],['inspection',s.videoInspection],['anchorDetection',s.anchorDetection],['journal',s.journal]])must(coverage[key+'SHA256']===ref.sha256,'Lifecycle review not bound to actual artifacts');
  must(coverage.nativeHistory && JSON.stringify(coverage.nativeHistory)===JSON.stringify(journal.nativeHistory),'Raw complete native history absent');load(coverage.nativeHistory);
  must(journal.recordingToolCalls?.length===2,'Extra/missing native recording operation');
  for(const [i,tool,ref] of [[0,'preview_recording_start',s.start],[1,'preview_recording_stop',s.stop]]){
    const call=journal.recordingToolCalls[i];must(call.tool===tool&&call.tabId===s.tabId&&JSON.stringify(call.result)===JSON.stringify(ref),'Native operation history differs');load(call.result);
  }
  return {nonce:markers.preShow.nonce,preToken:markers.preShow.token,postToken:markers.postShow.token,decodedFrames:detected.decodedFrames,detection:s.anchorDetection,lifecycle:s.lifecycleCoverage,scope:'Optical endpoints plus separately reviewed complete native recording history; not continuous in-timer30Hz.'};
}

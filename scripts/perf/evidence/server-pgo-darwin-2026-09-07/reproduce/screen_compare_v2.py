# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.

"""Strict persisted v2 witness/raw comparison and descriptive pair statistics."""
import hashlib,json,math,statistics
from pathlib import Path

def sha(path):
 h=hashlib.sha256()
 with Path(path).open('rb') as f:
  while block:=f.read(2*1024*1024):h.update(block)
 return h.hexdigest()

def raw(path):
 events=[json.loads(x) for x in (path/'events.jsonl').read_text().splitlines()]
 batches=[e for e in events if e['type']=='batch']
 hashes=[sha(path/e['file']) for e in batches]
 assert hashes==[e['wireSha256'] for e in batches],'Saved wire changed'
 return hashes

def compare(a,b):
 # Persisted canonical JSON encodes all v2 fields and ordering. Exact equality
 # is stronger than accepting only selected geometry or metadata fields.
 return {'fullSemanticExact':sha(a/'semantic-v2.json')==sha(b/'semantic-v2.json'),
         'rawGeometryBatchesExact':raw(a)==raw(b),
         'rawDataModelExact':sha(a/'data-model.bin')==sha(b/'data-model.bin')}

def qualify(base,candidate,fixture_sha):
 results=[json.loads((p/'result.json').read_text()) for p in (base,candidate)]
 comparisons={'coldBaseCandidate':compare(base,candidate),'baseCache':compare(base,base/'cache-replay'),'candidateCache':compare(candidate,candidate/'cache-replay')}
 gates={'transportSuccess':all(r.get('transportSuccess') for r in results),
        'fixtureExact':all(r['fixtureSha256']==fixture_sha for r in results),
        'shutdownComplete':all(not r.get('shutdownTimedOut') and not r.get('deadlineKilled') for r in results),
        'completeExactChannels':all(all(c.values()) for c in comparisons.values())}
 def measurements(r):
  result={k:r.get(k) for k in ('httpFeatureReadyMs','startupReadyMs','peakSampledRss','peakSampledRssThroughColdReady','shutdownStartMs','shutdownEndMs')}
  peak=r.get('peakSampledRss',0);samples=[x for x in r.get('memorySamples',[]) if x['rss']==peak]
  first=samples[0]['ms'] if samples else None
  result['peakFirstMs']=first
  result['peakPhase']='cold' if first is not None and first<=r.get('dataModelReceivedMs',0) else 'cache/replay/cleanup'
  return result
 return {'gates':gates,'passed':all(gates.values()),'comparisons':comparisons,'base':measurements(results[0]),'candidate':measurements(results[1])}

def summary(rows):
 out={}
 for name,subset in [('heldOut22',[r for r in rows if not r['training']]),('all27',rows),('training5',[r for r in rows if r['training']])]:
  valid=[r for r in subset if r.get('qualification',{}).get('passed')]
  ratios=[r['qualification']['candidate']['httpFeatureReadyMs']/r['qualification']['base']['httpFeatureReadyMs'] for r in valid]
  out[name]={'attempted':len(subset),'qualified':len(valid),'excludedFailures':[r['label'] for r in subset if r not in valid],
    'equalWeightGeometricMeanTimeReductionPercent':100*(1-math.exp(statistics.mean(map(math.log,ratios)))) if ratios else None,
    'qualification':'One pair per model; descriptive screen, no repeated-pair or no-regression claim; failures remain excluded explicitly, never greenwashed.'}
 return out

// Only dispatch existing V5 comparator exports over saved receipts.
import {readFileSync} from 'node:fs';
import {compareObservationPair,comparePublicRoutes,compareOncePublicRoute,compareReceipts} from './adapter/compare.mjs';
import {validateNativeCapture} from './adapter/schema.mjs';
const [kind,a,b,policy]=process.argv.slice(2),read=p=>JSON.parse(readFileSync(p,'utf8'));
try{
 let result;
 if(kind==='validate-native')result={valid:validateNativeCapture(read(a))};
 else{const x=read(a),y=read(b),p=read(policy);result=kind==='pair:wasm'?compareObservationPair(x,y,p,'wasm'):kind==='pair:native'?compareObservationPair(x,y,p,'native'):kind==='routes'?comparePublicRoutes(x,y,p):kind==='once'?compareOncePublicRoute(x,y,p):compareReceipts(x,y,p);}
 console.log(JSON.stringify(result,null,2));if(result.result&&result.result!=='MATCH_OR_EXACT_EXPECTED_DIFF')process.exitCode=1;
}catch(error){console.log(JSON.stringify({result:'INCOMPLETE',error:String(error)},null,2));process.exitCode=1;}

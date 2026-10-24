// SPDX-License-Identifier: MIT
// Reduced Emscripten 4.0.15 loader structure; see ../retained-notices/LICENSE.
// Generator-format fixture, not a built SDK or qualification evidence.
async function Module(moduleArg={}){
var moduleRtn;
var Module=moduleArg;
var ENVIRONMENT_IS_WEB=typeof window=="object";
var ENVIRONMENT_IS_WORKER=typeof WorkerGlobalScope!="undefined";
var ENVIRONMENT_IS_NODE=typeof process=="object"&&process.versions?.node&&process.type!="renderer";
if(ENVIRONMENT_IS_NODE){const{createRequire}=await import("module");var require=createRequire(import.meta.url)}
var arguments_=[];
var thisProgram="./this.program";
var quit_=(status,toThrow)=>{throw toThrow};
var _scriptName=import.meta.url;
var scriptDirectory="";
function locateFile(path){if(Module["locateFile"]){return Module["locateFile"](path,scriptDirectory)}return scriptDirectory+path}
var readAsync,readBinary;
if(ENVIRONMENT_IS_NODE){var fs=require("fs");if(_scriptName.startsWith("file:")){scriptDirectory=require("path").dirname(require("url").fileURLToPath(_scriptName))+"/"}readBinary=filename=>{filename=isFileURI(filename)?new URL(filename):filename;var ret=fs.readFileSync(filename);return ret};readAsync=async(filename,binary=true)=>{filename=isFileURI(filename)?new URL(filename):filename;var ret=fs.readFileSync(filename,binary?undefined:"utf8");return ret};if(process.argv.length>1){thisProgram=process.argv[1].replace(/\\/g,"/")}arguments_=process.argv.slice(2);quit_=(status,toThrow)=>{process.exitCode=status;throw toThrow}}else if(ENVIRONMENT_IS_WEB||ENVIRONMENT_IS_WORKER){try{scriptDirectory=new URL(".",_scriptName).href}catch{}{if(ENVIRONMENT_IS_WORKER){readBinary=url=>{var xhr=new XMLHttpRequest;xhr.open("GET",url,false);xhr.responseType="arraybuffer";xhr.send(null);return new Uint8Array(xhr.response)}}readAsync=async url=>{var response=await fetch(url,{credentials:"same-origin"});if(response.ok){return response.arrayBuffer()}throw new Error(response.status+" : "+response.url)}}}else{}
var wasmBinaryFile;
function findWasmBinary(){if(Module["locateFile"]){return locateFile("ifclite_smlib_browser.wasm")}return new URL("ifclite_smlib_browser.wasm",import.meta.url).href}
function getBinarySync(file){if(file==wasmBinaryFile&&wasmBinary){return new Uint8Array(wasmBinary)}if(readBinary){return readBinary(file)}throw"both async and sync fetching of the wasm failed"}
async function getWasmBinary(binaryFile){if(!wasmBinary){try{var response=await readAsync(binaryFile);return new Uint8Array(response)}catch{}}return getBinarySync(binaryFile)}
async function instantiateArrayBuffer(binaryFile,imports){try{var binary=await getWasmBinary(binaryFile);var instance=await WebAssembly.instantiate(binary,imports);return instance}catch(reason){err(`failed to asynchronously prepare wasm: ${reason}`);abort(reason)}}
async function instantiateAsync(binary,binaryFile,imports){if(!binary&&!ENVIRONMENT_IS_NODE){try{var response=fetch(binaryFile,{credentials:"same-origin"});var instantiationResult=await WebAssembly.instantiateStreaming(response,imports);return instantiationResult}catch(reason){err(`wasm streaming compile failed: ${reason}`);err("falling back to ArrayBuffer instantiation")}}return instantiateArrayBuffer(binaryFile,imports)}
async function createWasm(){ wasmBinaryFile??=findWasmBinary(); var result=await instantiateAsync(wasmBinary,wasmBinaryFile,info); }
var asyncLoad=async url=>{var arrayBuffer=await readAsync(url);return new Uint8Array(arrayBuffer)};
}
export default Module;

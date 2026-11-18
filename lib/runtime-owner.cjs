'use strict';
const fs=require('node:fs/promises');
const path=require('node:path');
const {spawnSync}=require('node:child_process');
const {createHash,randomUUID}=require('node:crypto');
const failure=(message,code='owner_state_invalid')=>Object.assign(new Error(message),{code,status:409});
const equalPath=(a,b)=>typeof a==='string'&&typeof b==='string'&&path.resolve(a).toLowerCase()===path.resolve(b).toLowerCase();
function probeProcess(pid){
 if(!Number.isInteger(pid)||pid<1)throw failure('Stored process ID is invalid. Use installer Diagnose before recovery.');
 const script=`$ErrorActionPreference='Stop';try{$p=[Diagnostics.Process]::GetProcessById(${pid})}catch [ArgumentException]{'null';exit 0};try{@{pid=$p.Id;startedAt=$p.StartTime.ToUniversalTime().ToString('o');executablePath=$p.MainModule.FileName}|ConvertTo-Json -Compress}finally{$p.Dispose()}`;
 const result=spawnSync('pwsh.exe',['-NoProfile','-NonInteractive','-Command',script],{encoding:'utf8',windowsHide:true,timeout:10000,maxBuffer:16384});
 if(result.error||result.status!==0)throw failure('Windows process ownership could not be inspected. No owner was assumed stopped.','owner_probe_failed');
 let value;try{value=JSON.parse(result.stdout);}catch{throw failure('Windows returned invalid process ownership metadata.','owner_probe_failed');}
 if(value===null)return null;
 if(value.pid!==pid||!Number.isFinite(Date.parse(value.startedAt))||!path.isAbsolute(value.executablePath||''))throw failure('Windows process ownership metadata is incomplete.','owner_probe_failed');
 return value;
}
function classify(record,identity){
 if(identity===null)return {state:'stale',reason:'owner_stopped'};
 if(identity.pid!==record.pid)return {state:'unknown',reason:'owner_probe_mismatch'};
 const created=Date.parse(identity.startedAt),recorded=Date.parse(record.processStartedAt||record.startedAt);
 if(!Number.isFinite(recorded))return {state:'unknown',reason:'owner_time_missing'};
 if(record.processStartedAt){
  if(created!==recorded)return {state:'stale',reason:'pid_reused'};
  if(!equalPath(record.executablePath,identity.executablePath))return {state:'unknown',reason:'owner_executable_changed'};
  return {state:'live',reason:'exact_process_identity'};
 }
 // A process created after the saved service record cannot be its original owner.
 if(created>recorded+2000)return {state:'stale',reason:'legacy_pid_reused'};
 if(path.basename(identity.executablePath).toLowerCase()!=='node.exe'||created<recorded-120000)return {state:'unknown',reason:'legacy_owner_unverified'};
 return {state:'live',reason:'legacy_process_identity'};
}
async function inspectService(runtimeHome,{probe=probeProcess}={}){
 const file=path.join(runtimeHome,'state','config-server.json');let raw;
 try{raw=await fs.readFile(file,'utf8');}catch(e){if(e.code==='ENOENT')return {state:'absent',reason:'no_startup_record'};throw e;}
 let record,url;try{record=JSON.parse(raw);url=new URL(record.url);}catch{throw failure('Saved Config Builder metadata is invalid. Run installer Diagnose; do not delete execution journals.');}
 if(!Number.isInteger(record.pid)||record.pid<1||!path.isAbsolute(record.projectRoot||'')||!path.isAbsolute(record.outputRoot||'')||url.protocol!=='http:'||url.hostname!=='127.0.0.1'||url.username||url.password||url.pathname!=='/config-builder.html'||url.search||!/^#session=[A-Za-z0-9_-]+$/.test(url.hash))throw failure('Saved Config Builder metadata has an invalid ownership or loopback scope.');
 const identity=await probe(record.pid);
 return {...classify(record,identity),record,hash:createHash('sha256').update(raw).digest('hex')};
}
function publicService(value){return {state:value.state,reason:value.reason,...(value.record?{pid:value.record.pid,projectRoot:value.record.projectRoot,outputRoot:value.record.outputRoot}: {})};}
async function quarantineStartup(runtimeHome,expectedHash,options){
 const current=await inspectService(runtimeHome,options);
 if(current.state!=='stale'||current.hash!==expectedHash)throw failure('Service ownership changed before recovery. Inspect it again.','owner_changed');
 const directory=path.join(runtimeHome,'state','recovery');await fs.mkdir(directory,{recursive:true});
 const destination=path.join(directory,`${Date.now()}-${randomUUID()}-config-server.json`);
 await fs.rename(path.join(runtimeHome,'state','config-server.json'),destination);
 return {recovered:true,reason:current.reason,archivedStartup:destination,processStopped:false};
}
let ownIdentity;
function currentProcess(){if(!ownIdentity){ownIdentity=probeProcess(process.pid);if(!ownIdentity)throw failure('The current process identity could not be confirmed.','owner_probe_failed');}return ownIdentity;}
module.exports={probeProcess,classify,inspectService,publicService,quarantineStartup,currentProcess};

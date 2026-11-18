'use strict';
const {test,before,after}=require('node:test');
const assert=require('node:assert/strict'),fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
const {spawn,execFile}=require('node:child_process'),{promisify}=require('node:util'),{randomUUID}=require('node:crypto');
const exec=promisify(execFile),release=require('../release.json'),root=path.resolve(__dirname,'..');
let shared,packageRoot;
const ps=(file,args=[],env=process.env)=>exec('pwsh.exe',['-NoProfile','-NonInteractive','-File',file,...args],{env,windowsHide:true,timeout:60000,maxBuffer:2*1024*1024});
async function command(script,env){return exec('pwsh.exe',['-NoProfile','-NonInteractive','-Command',script],{env,windowsHide:true,timeout:30000,maxBuffer:2*1024*1024});}
async function rejectsRun(work,pattern){await assert.rejects(work,e=>pattern.test(e.stderr||e.message));}
before(async()=>{shared=await fs.mkdtemp(path.join(os.tmpdir(),'sn-ready-'));let zip=process.env.SN_DEMOSEEDER_TEST_ZIP;if(!zip){zip=JSON.parse((await ps(path.join(root,'scripts','build-release.ps1'),['-Destination',shared])).stdout).archive;}await command('Expand-Archive -LiteralPath $env:SN_TEST_ZIP -DestinationPath $env:SN_TEST_EXTRACT',{...process.env,SN_TEST_ZIP:zip,SN_TEST_EXTRACT:path.join(shared,'extract')});packageRoot=path.join(shared,'extract',release.archivePrefix+'-Scout-'+release.version);});
after(async()=>{if(shared)await fs.rm(shared,{recursive:true,force:true,maxRetries:10,retryDelay:100});});
async function fixture(t){
 const temp=await fs.mkdtemp(path.join(shared,"User [B] O'Neil & Team ")),home=path.join(temp,'Home'),bundle=path.join(temp,'Release');await fs.mkdir(home);await fs.cp(packageRoot,bundle,{recursive:true});
 const env={...process.env,HOME:home,USERPROFILE:home,APPDATA:path.join(temp,'Roaming'),LOCALAPPDATA:path.join(temp,'Local'),SN_DEMOSEEDER_NO_PAUSE:'1'};
 const skillStore=path.join(home,'.scout','m-skills'),skill=path.join(skillStore,release.skillName),output=path.join(home,'.copilot',release.outputFolder),runtime=path.join(env.LOCALAPPDATA,'Scout','ServiceNowDemoSeeder'),installer=path.join(bundle,'Install-SN-DemoLoader.ps1'),launcher=path.join(skill,'scripts','launch.ps1');
 let serverPid;const extra=new Set();
 const install=(args=[],changedEnv=env)=>ps(installer,['-SkillStore',skillStore,'-OutputRoot',output,'-PrerequisitesConfirmed',...args],changedEnv);
 const launch=async args=>{const result=await ps(launcher,args,env);if(args.includes('Configure'))serverPid=JSON.parse(result.stdout).processId;if(args.includes('StopConfig')&&JSON.parse(result.stdout).stopped)serverPid=null;return result;};
 t.after(async()=>{if(serverPid)extra.add(serverPid);for(const id of extra){try{process.kill(id);}catch(e){if(e.code!=='ESRCH')throw e;}}await fs.rm(temp,{recursive:true,force:true,maxRetries:10,retryDelay:100});});
 return {temp,home,bundle,env,skillStore,skill,output,runtime,installer,launcher,install,launch,extra};
}
async function marked(file){try{return (await fs.readFile(file+':Zone.Identifier','utf8')).includes('ZoneId=3');}catch(e){if(e.code==='ENOENT')return false;throw e;}}
async function mark(file){await fs.writeFile(file+':Zone.Identifier','[ZoneTransfer]\r\nZoneId=3\r\n');}
async function markPayload(f){for(const directory of [f.bundle]){const entries=await fs.readdir(directory,{recursive:true,withFileTypes:true});for(const entry of entries){if(entry.isFile()&&entry.name.endsWith('.ps1'))await mark(path.join(entry.parentPath,entry.name));}}}
async function bootstrap(f,input){return new Promise((resolve,reject)=>{
 const child=spawn(process.env.ComSpec||'C:\\Windows\\System32\\cmd.exe',['/d','/s','/c','""'+path.join(f.bundle,'Install.cmd')+'""'],{env:{...f.env,PSExecutionPolicyPreference:'RemoteSigned'},windowsVerbatimArguments:true,windowsHide:true,stdio:['pipe','pipe','pipe']});let stdout='',stderr='';const timer=setTimeout(()=>{child.kill();reject(new Error('Bootstrap did not finish.'));},60000);child.stdout.on('data',data=>stdout+=data);child.stderr.on('data',data=>stderr+=data);child.once('error',e=>{clearTimeout(timer);reject(e);});child.once('close',code=>{clearTimeout(timer);resolve({code,stdout,stderr});});child.stdin.end(input+'\r\n');
 });}
test('download-marked release installs and launches under RemoteSigned after exact TRUST consent',async t=>{
 const f=await fixture(t);await markPayload(f);const neighbor=path.join(f.bundle,'unmanaged-neighbor.ps1');await fs.writeFile(neighbor,'Write-Output untouched');await mark(neighbor);
 await rejectsRun(()=>ps(f.installer,['-Confirm'],{...f.env,PSExecutionPolicyPreference:'RemoteSigned'}),/not digitally signed|cannot be loaded|running scripts/i);
 const result=await bootstrap(f,'READY\r\nTRUST');assert.equal(result.code,0,result.stderr+result.stdout);assert.equal(await marked(neighbor),true);assert.equal(await marked(f.launcher),false);assert.match(result.stdout,/admin, itil_admin, knowledge_admin, user_admin/);assert.match(result.stdout,/acknowledgement only/);
 const launched=JSON.parse((await ps(f.launcher,['-Action','Paths'],{...f.env,PSExecutionPolicyPreference:'RemoteSigned'})).stdout);assert.equal(launched.outputRoot,f.output);assert.equal(launched.installed,true);
 assert.equal(/Set-ExecutionPolicy|ExecutionPolicy\s+Bypass/i.test(await fs.readFile(path.join(f.bundle,'Install.cmd'),'utf8')),false);
});
test('bootstrap cancellation and changed installer bytes unblock/install nothing',async t=>{
 const f=await fixture(t);await markPayload(f);let result=await bootstrap(f,'');assert.equal(result.code,2,result.stderr);assert.equal(await marked(f.installer),true);await assert.rejects(fs.access(f.skill),{code:'ENOENT'});
 await fs.appendFile(f.installer,' ');result=await bootstrap(f,'TRUST');assert.equal(result.code,1);assert.match(result.stderr,/integrity mismatch/);assert.equal(await marked(f.installer),true);await assert.rejects(fs.access(f.skill),{code:'ENOENT'});
});
test('a reused stale PID is never killed and no longer blocks update or Configure',async t=>{
 const f=await fixture(t);await f.install(['-Confirm']);const unrelated=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore',windowsHide:true});f.extra.add(unrelated.pid);
 const state=path.join(f.runtime,'state');await fs.mkdir(state,{recursive:true});await fs.writeFile(path.join(state,'config-server.json'),JSON.stringify({schemaVersion:1,pid:unrelated.pid,projectRoot:path.join(f.skill,'app'),outputRoot:f.output,startedAt:'2020-01-01T00:00:00Z',url:'http://127.0.0.1:9/config-builder.html#session=local-fixture'}));
 assert.equal(JSON.parse((await f.install(['-Confirm'])).stdout).action,'Update');
 const configured=JSON.parse((await f.launch(['-Action','Configure'])).stdout);assert.notEqual(configured.processId,unrelated.pid);process.kill(unrelated.pid,0);
 const current=JSON.parse(await fs.readFile(path.join(state,'config-server.json'),'utf8'));assert.equal(current.schemaVersion,2);assert.ok(current.processStartedAt);assert.ok((await fs.readdir(path.join(state,'recovery'))).some(name=>name.endsWith('config-server.json')));
 await f.launch(['-Action','StopConfig','-Confirm']);process.kill(unrelated.pid,0);
});
test('Diagnose/Recover clear only abandoned local installer metadata, preserving PDI locks and data',async t=>{
 const f=await fixture(t);await f.install(['-Confirm']);const state=path.join(f.runtime,'state');await fs.mkdir(state,{recursive:true});await fs.writeFile(path.join(state,'installation.lock'),JSON.stringify({pid:1,startedAt:'2020-01-01T00:00:00Z',action:'Install'}));
 const pdi=path.join(state,'pdi-locks');await fs.mkdir(pdi);await fs.writeFile(path.join(pdi,'preserve.lock'),'SOURCE-UNCERTAINTY');await fs.writeFile(path.join(f.output,'configs','keep.txt'),'KEEP-DATA');
 assert.equal(JSON.parse((await f.launch(['-Action','Diagnose'])).stdout).installationLease,'abandoned');await rejectsRun(()=>f.launch(['-Action','Recover']),/requires -Confirm/);
 const result=JSON.parse((await f.launch(['-Action','Recover','-Confirm'])).stdout);assert.equal(result.pdiLocksPreserved,1);assert.equal(result.processStopped,false);
 assert.equal(await fs.readFile(path.join(pdi,'preserve.lock'),'utf8'),'SOURCE-UNCERTAINTY');assert.equal(await fs.readFile(path.join(f.output,'configs','keep.txt'),'utf8'),'KEEP-DATA');assert.equal(JSON.parse((await f.launch(['-Action','Paths'])).stdout).ok,true);
});
test('recovery restores a verified previous installation after an interrupted directory swap',async t=>{
 const f=await fixture(t);await f.install(['-Confirm']);const stage=path.join(f.skillStore,'.sn-install-'+randomUUID().replaceAll('-',''));await fs.mkdir(stage);await fs.rename(f.skill,path.join(stage,'previous'));await fs.mkdir(path.join(stage,'payload'));await fs.writeFile(path.join(stage,'payload','unfinished.txt'),'PRESERVE-STAGING');
 const state=path.join(f.runtime,'state');await fs.mkdir(state,{recursive:true});await fs.writeFile(path.join(state,'installation.lock'),JSON.stringify({schemaVersion:2,pid:1,action:'Install',startedAt:'2020-01-01T00:00:00Z',targetSkillRoot:f.skill,outputRoot:f.output,stageRoot:stage}));
 const before=JSON.parse((await f.install(['-Action','Diagnose'])).stdout);assert.equal(before.stages.length,1);assert.equal(before.stages[0].hasPrevious,true);
 const result=JSON.parse((await f.install(['-Action','Recover','-Confirm'])).stdout);assert.ok(result.changes.some(text=>text.startsWith('Restored')));assert.equal(result.sourceChanges,false);await f.install(['-Action','Verify']);assert.equal(JSON.parse((await f.launch(['-Action','Paths'])).stdout).installed,true);
 const archive=(await fs.readdir(f.skillStore)).find(name=>name.startsWith('.sn-recovered-'));assert.equal(await fs.readFile(path.join(f.skillStore,archive,'payload','unfinished.txt'),'utf8'),'PRESERVE-STAGING');
});
test('an actively held installer lease cannot be recovered or removed',async t=>{
 const f=await fixture(t);await f.install(['-Confirm']);const state=path.join(f.runtime,'state');await fs.mkdir(state,{recursive:true});const file=path.join(state,'installation.lock'),handle=await fs.open(file,'wx');await handle.writeFile('ACTIVE');
 try{assert.equal(JSON.parse((await f.install(['-Action','Diagnose'])).stdout).installationLease,'active');await rejectsRun(()=>f.install(['-Action','Recover','-Confirm']),/actively held/);assert.equal(await fs.readFile(file,'utf8'),'ACTIVE');}finally{await handle.close();}
});
test('installer and packaged Doctor support a per-user Edge installation',async t=>{
 const f=await fixture(t),env={...f.env};for(const key of Object.keys(env)){if(['programfiles','programfiles(x86)'].includes(key.toLowerCase()))delete env[key];}env.ProgramFiles=path.join(f.temp,'empty64');env['ProgramFiles(x86)']=path.join(f.temp,'empty86');const edge=path.join(f.env.LOCALAPPDATA,'Microsoft','Edge','Application','msedge.exe');await fs.mkdir(path.dirname(edge),{recursive:true});await fs.writeFile(edge,'presence-only-layout-fixture');
 await f.install(['-Confirm'],env);const doctor=JSON.parse((await ps(f.launcher,['-Action','Doctor'],env)).stdout);assert.equal(doctor.ok,true);assert.equal(doctor.requirements.edgePath,edge);
});
test('a live service is not recovered, and can be safely stopped despite an abandoned installer lease',async t=>{
 const f=await fixture(t);await f.install(['-Confirm']);await f.launch(['-Action','Configure']);const state=path.join(f.runtime,'state');await fs.writeFile(path.join(state,'installation.lock'),JSON.stringify({pid:1,startedAt:'2020-01-01T00:00:00Z'}));
 const diagnosis=JSON.parse((await f.launch(['-Action','Diagnose'])).stdout);assert.equal(diagnosis.service.state,'live');assert.equal(diagnosis.installationLease,'abandoned');
 await rejectsRun(()=>f.launch(['-Action','Recover','-Confirm']),/ownership is live or unverified/);assert.equal(JSON.parse((await f.launch(['-Action','StopConfig','-Confirm'])).stdout).stopped,true);
 assert.equal(JSON.parse((await f.launch(['-Action','Recover','-Confirm'])).stdout).ok,true);
});
test('recovery refuses a staged resource swap while PDI evidence exists and never erases it',async t=>{
 const f=await fixture(t);await f.install(['-Confirm']);const stage=path.join(f.skillStore,'.sn-install-'+randomUUID().replaceAll('-',''));await fs.mkdir(stage);await fs.rename(f.skill,path.join(stage,'previous'));
 const state=path.join(f.runtime,'state'),pdi=path.join(state,'pdi-locks');await fs.mkdir(pdi,{recursive:true});await fs.writeFile(path.join(pdi,'keep.lock'),'UNCERTAIN-SOURCE-WRITE');const lease=JSON.stringify({pid:1,startedAt:'2020-01-01T00:00:00Z',targetSkillRoot:f.skill,outputRoot:f.output});await fs.writeFile(path.join(state,'installation.lock'),lease);
 await rejectsRun(()=>f.install(['-Action','Recover','-Confirm']),/blocked by a PDI operation/);assert.equal(await fs.readFile(path.join(pdi,'keep.lock'),'utf8'),'UNCERTAIN-SOURCE-WRITE');assert.equal(await fs.readFile(path.join(state,'installation.lock'),'utf8'),lease);await fs.access(path.join(stage,'previous'));await assert.rejects(fs.access(f.skill),{code:'ENOENT'});
});
test('a changed payload is rejected before any payload script is unblocked',async t=>{
 const f=await fixture(t);await markPayload(f);const changed=path.join(f.bundle,'skill','app','scripts','manage.ps1');await fs.appendFile(changed,' ');const result=await bootstrap(f,'READY\r\nTRUST');assert.equal(result.code,1);assert.match(result.stderr,/missing or changed/);assert.equal(await marked(changed),true);await assert.rejects(fs.access(f.skill),{code:'ENOENT'});
});
test('install refuses missing prerequisite acknowledgement and GUIDE remains an explicit choice',async t=>{
 const f=await fixture(t);await rejectsRun(()=>ps(f.installer,['-SkillStore',f.skillStore,'-OutputRoot',f.output,'-Confirm'],f.env),/Before installing: open PREREQUISITES.html/);await assert.rejects(fs.access(f.skill),{code:'ENOENT'});
 await markPayload(f);const cancelled=await bootstrap(f,'TRUST');assert.equal(cancelled.code,2);assert.equal(await marked(f.installer),true);await assert.rejects(fs.access(f.skill),{code:'ENOENT'});
 const bootstrapText=await fs.readFile(path.join(f.bundle,'Install.cmd'),'utf8');assert.ok(bootstrapText.includes("$ready -ceq 'GUIDE'"));assert.ok(bootstrapText.indexOf('Type GUIDE')<bootstrapText.indexOf('Type TRUST'));
 await command('Unblock-File -LiteralPath $env:SN_TEST_INSTALLER',{...f.env,SN_TEST_INSTALLER:f.installer});const installed=JSON.parse((await f.install(['-Confirm','-TrustDownloadedPayload'])).stdout);assert.equal(installed.prerequisites.acknowledged,true);assert.equal(installed.prerequisites.verified,false);
 const receipt=JSON.parse(await fs.readFile(path.join(f.skill,'.sn-demoseeder-install.json'),'utf8'));assert.equal(receipt.prerequisites.source,'operator-acknowledgement-only');assert.equal(receipt.prerequisites.verified,false);assert.deepEqual(receipt.prerequisites.requiredSetupRoles,['admin','itil_admin','knowledge_admin','user_admin']);assert.equal(await fs.readFile(path.join(f.skill,'app','PREREQUISITES.html'),'utf8'),await fs.readFile(path.join(f.bundle,'PREREQUISITES.html'),'utf8'));
});
test('changed prerequisite guide is rejected before consent or unblocking',async t=>{
 const f=await fixture(t);await markPayload(f);await fs.appendFile(path.join(f.bundle,'PREREQUISITES.html'),' ');const result=await bootstrap(f,'READY\r\nTRUST');assert.equal(result.code,1);assert.match(result.stderr,/guide integrity mismatch/);assert.equal(await marked(f.installer),true);await assert.rejects(fs.access(f.skill),{code:'ENOENT'});
});

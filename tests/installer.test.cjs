'use strict';
const {test,before,after}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const {execFile,spawn}=require('node:child_process');
const {promisify}=require('node:util');
const {createHash}=require('node:crypto');
const exec=promisify(execFile);
const {locations}=require('../lib/locations.cjs');
const {ProfileStore}=require('../lib/profiles.cjs');
const {ConfigServer}=require('../lib/server.cjs');
const release=require('../release.json');
const root=path.resolve(__dirname,'..');
let packageRoot,shared;
const ps=(file,args=[],env=process.env)=>exec('pwsh.exe',['-NoProfile','-NonInteractive','-File',file,...args],{env,windowsHide:true,timeout:60000,maxBuffer:2*1024*1024});
before(async()=>{
 shared=await fs.mkdtemp(path.join(os.tmpdir(),'sn-release-test-'));
 const built=process.env.SN_DEMOSEEDER_TEST_ZIP?{archive:process.env.SN_DEMOSEEDER_TEST_ZIP,version:release.version}:JSON.parse((await ps(path.join(root,'scripts','build-release.ps1'),['-Destination',shared])).stdout);
 assert.equal(built.version,release.version);
 await assert.rejects(fs.access(built.archive+'.sha256'),{code:'ENOENT'});
 await exec('pwsh.exe',['-NoProfile','-NonInteractive','-Command','Expand-Archive -LiteralPath $env:SN_TEST_ZIP -DestinationPath $env:SN_TEST_EXTRACT'],{env:{...process.env,SN_TEST_ZIP:built.archive,SN_TEST_EXTRACT:path.join(shared,'extracted')},windowsHide:true,timeout:30000});
 packageRoot=path.join(shared,'extracted',release.archivePrefix+'-Scout-'+release.version);
 const manifest=JSON.parse(await fs.readFile(path.join(packageRoot,'package-manifest.json'),'utf8'));assert.equal(manifest.files.length,29);
});
after(async()=>{if(shared)await fs.rm(shared,{recursive:true,force:true});});
async function fixture(t){
 const temp=await fs.mkdtemp(path.join(os.tmpdir(),'sn-install [paths] ')),home=path.join(temp,'User Home');
 const env={...process.env,HOME:home,USERPROFILE:home,LOCALAPPDATA:path.join(temp,'Local AppData')};
 const skillStore=path.join(home,'.scout','m-skills'),skill=path.join(skillStore,release.skillName),output=path.join(home,'.copilot',release.outputFolder),runtime=path.join(env.LOCALAPPDATA,'Scout','ServiceNowDemoSeeder');
 await fs.mkdir(home,{recursive:true});
 const installer=path.join(packageRoot,'Install-SN-DemoLoader.ps1');
 const install=(args=[])=>ps(installer,['-SkillStore',skillStore,'-OutputRoot',output,'-PrerequisitesConfirmed',...args],env);
 const launch=(args=[])=>ps(path.join(skill,'scripts','launch.ps1'),args,env);
 t.after(async()=>{
  let state;try{state=JSON.parse(await fs.readFile(path.join(runtime,'state','config-server.json'),'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;}
  if(state){try{process.kill(state.pid);}catch(e){if(e.code!=='ESRCH')throw e;}}
  await fs.rm(temp,{recursive:true,force:true,maxRetries:10,retryDelay:100});
 });
 return {temp,home,env,skillStore,skill,output,runtime,installer,install,launch};
}
function rejectsRun(work,pattern){return assert.rejects(work,e=>pattern.test(e.stderr||e.message));}
async function legacyFixture(f){
 await f.install(['-Confirm']);const legacy=path.join(f.skillStore,'sn-demoseeder');await fs.rename(f.skill,legacy);
 const skillFile=path.join(legacy,'SKILL.md');let skill=await fs.readFile(skillFile,'utf8');skill=skill.replace('name: "sn-demoloader"','name: "sn-demoseeder"');await fs.writeFile(skillFile,skill);
 const metadataFile=path.join(legacy,'app','release.json'),metadata=JSON.parse(await fs.readFile(metadataFile,'utf8'));metadata.version='0.11.3';delete metadata.skillName;delete metadata.displayName;delete metadata.archivePrefix;metadata.outputFolder='SN-DemoSeed-Output-Scout';await fs.writeFile(metadataFile,JSON.stringify(metadata));
 const receiptFile=path.join(legacy,'.sn-demoseeder-install.json'),receipt=JSON.parse(await fs.readFile(receiptFile,'utf8'));receipt.version='0.11.3';delete receipt.skillName;delete receipt.displayName;const output=path.join(f.home,'.copilot','SN-DemoSeed-Output-Scout');await fs.rename(f.output,output);receipt.outputRoot=output;
 for(const file of receipt.files)file.sha256=createHash('sha256').update(await fs.readFile(path.join(legacy,file.path))).digest('hex');await fs.writeFile(receiptFile,JSON.stringify(receipt));return {legacy,output};
}
test('new peer-facing names are complete while protected/source authority stays compatible',async t=>{
 const f=await fixture(t);assert.equal(release.displayName,'SN DemoLoader');assert.equal(release.skillName,'sn-demoloader');assert.equal(release.archivePrefix,'SN-DemoLoader');assert.equal(release.product,'sn-demoseeder');assert.equal(release.outputFolder,'SN-DemoLoader-Output-Scout');
 const installed=JSON.parse((await f.install(['-Confirm'])).stdout);assert.equal(installed.skillName,'sn-demoloader');assert.ok(installed.next.includes('/sn-demoloader'));const paths=JSON.parse((await f.launch(['-Action','Paths'])).stdout);assert.equal(paths.displayName,'SN DemoLoader');assert.equal(paths.runtimeHome,f.runtime);
 const ui=await fs.readFile(path.join(f.skill,'app','config-builder.html'),'utf8'),guide=await fs.readFile(path.join(f.skill,'app','PREREQUISITES.html'),'utf8'),skill=await fs.readFile(path.join(f.skill,'SKILL.md'),'utf8');assert.ok(ui.includes('<title>SN DemoLoader'));assert.ok(ui.includes("'/sn-demoloader use '"));assert.ok(!ui.includes('/sn-demoseeder'));assert.ok(guide.includes('/sn-demoloader'));assert.ok(!guide.includes('SN-DemoSeeder'));assert.ok(skill.includes('name: "sn-demoloader"'));
});
test('receipt-owned legacy installation upgrades to one new skill without moving output or protected history',async t=>{
 const f=await fixture(t),{legacy,output}=await legacyFixture(f),keep=path.join(output,'configs','keep.txt'),journal=path.join(f.runtime,'state','content-provisioning','opaque-journal.json'),credential=path.join(f.runtime,'credentials','opaque-envelope');await fs.writeFile(keep,'SAVED-CONFIG');await fs.mkdir(path.dirname(journal),{recursive:true});await fs.writeFile(journal,'SAVED-AUTHORITY');await fs.mkdir(path.dirname(credential),{recursive:true});await fs.writeFile(credential,'ENCRYPTED-ENVELOPE');
 const result=JSON.parse((await ps(f.installer,['-SkillStore',f.skillStore,'-Confirm','-PrerequisitesConfirmed'],f.env)).stdout);assert.equal(result.action,'RenameUpgrade');assert.equal(result.skillRoot,f.skill);assert.equal(result.outputRoot,output);await assert.rejects(fs.access(legacy),{code:'ENOENT'});assert.equal(await fs.readFile(keep,'utf8'),'SAVED-CONFIG');assert.equal(await fs.readFile(journal,'utf8'),'SAVED-AUTHORITY');assert.equal(await fs.readFile(credential,'utf8'),'ENCRYPTED-ENVELOPE');const paths=JSON.parse((await f.launch(['-Action','Paths'])).stdout);assert.equal(paths.outputRoot,output);assert.equal(paths.runtimeHome,f.runtime);assert.equal(paths.skillName,'sn-demoloader');await ps(f.installer,['-SkillStore',f.skillStore,'-Action','Verify'],f.env);await assert.rejects(fs.access(f.output),{code:'ENOENT'});
});
test('authored legacy skill and both-name registration collisions are never overwritten',async t=>{
 const f=await fixture(t),legacy=path.join(f.skillStore,'sn-demoseeder');await fs.mkdir(legacy,{recursive:true});await fs.writeFile(path.join(legacy,'SKILL.md'),'AUTHORED');await rejectsRun(()=>f.install(['-Confirm']),/without an installation receipt/);await assert.rejects(fs.access(f.skill),{code:'ENOENT'});assert.equal(await fs.readFile(path.join(legacy,'SKILL.md'),'utf8'),'AUTHORED');await fs.mkdir(f.skill);await rejectsRun(()=>f.install(['-Confirm']),/Both sn-demoloader and legacy sn-demoseeder/);assert.equal(await fs.readFile(path.join(legacy,'SKILL.md'),'utf8'),'AUTHORED');
});
test('renamed and legacy global registrations both prevent duplicate local installs',async t=>{
 const f=await fixture(t),global=path.join(f.home,'.copilot','skills','sn-demoloader');await fs.mkdir(global,{recursive:true});await fs.writeFile(path.join(global,'SKILL.md'),'GLOBAL');await rejectsRun(()=>f.install(['-Confirm']),/global sn-demoloader registration/);assert.equal(await fs.readFile(path.join(global,'SKILL.md'),'utf8'),'GLOBAL');
});
test('reinstall after legacy removal retains its library, and two candidate libraries require an explicit choice',async t=>{
 const f=await fixture(t),{output}=await legacyFixture(f);await ps(f.installer,['-SkillStore',f.skillStore,'-Action','Uninstall','-Confirm'],f.env);await fs.writeFile(path.join(output,'configs','keep.txt'),'LEGACY-DATA');const installed=JSON.parse((await ps(f.installer,['-SkillStore',f.skillStore,'-Confirm','-PrerequisitesConfirmed'],f.env)).stdout);assert.equal(installed.outputRoot,output);assert.equal(await fs.readFile(path.join(output,'configs','keep.txt'),'utf8'),'LEGACY-DATA');
 await ps(f.installer,['-SkillStore',f.skillStore,'-Action','Uninstall','-Confirm'],f.env);await fs.mkdir(f.output,{recursive:true});await rejectsRun(()=>ps(f.installer,['-SkillStore',f.skillStore,'-Confirm','-PrerequisitesConfirmed'],f.env),/Both current and legacy output libraries/);await assert.rejects(fs.access(f.skill),{code:'ENOENT'});
});
test('a stopped legacy update can recover its previous resources under the new registration then finish upgrade',async t=>{
 const f=await fixture(t),{legacy,output}=await legacyFixture(f),stage=path.join(f.skillStore,'.sn-install-'+'a'.repeat(32));await fs.mkdir(stage);await fs.rename(legacy,path.join(stage,'previous'));await fs.mkdir(path.join(stage,'payload'));
 const state=path.join(f.runtime,'state');await fs.mkdir(state,{recursive:true});await fs.writeFile(path.join(state,'installation.lock'),JSON.stringify({schemaVersion:2,pid:1,startedAt:'2020-01-01T00:00:00Z',targetSkillRoot:legacy,outputRoot:output,stageRoot:stage}));const args=['-SkillStore',f.skillStore,'-OutputRoot',output];
 const recovered=JSON.parse((await ps(f.installer,[...args,'-Action','Recover','-Confirm'],f.env)).stdout);assert.equal(recovered.sourceChanges,false);assert.equal(recovered.processStopped,false);await fs.access(path.join(f.skill,'.sn-demoseeder-install.json'));await assert.rejects(fs.access(legacy),{code:'ENOENT'});
 const updated=JSON.parse((await ps(f.installer,[...args,'-Confirm','-PrerequisitesConfirmed'],f.env)).stdout);assert.equal(updated.outputRoot,output);assert.equal(updated.skillName,'sn-demoloader');assert.ok((await fs.readFile(path.join(f.skill,'SKILL.md'),'utf8')).includes('name: "sn-demoloader"'));
});
test('abandoned rename preparation can recover while its original legacy installation is still intact',async t=>{
 const f=await fixture(t),{legacy,output}=await legacyFixture(f),stage=path.join(f.skillStore,'.sn-install-'+'b'.repeat(32));await fs.mkdir(path.join(stage,'payload'),{recursive:true});await fs.writeFile(path.join(stage,'payload','unfinished.txt'),'STAGING');const state=path.join(f.runtime,'state');await fs.mkdir(state,{recursive:true});await fs.writeFile(path.join(state,'installation.lock'),JSON.stringify({pid:1,startedAt:'2020-01-01T00:00:00Z',targetSkillRoot:f.skill,previousSkillRoot:legacy,outputRoot:output,stageRoot:stage}));const args=['-SkillStore',f.skillStore,'-OutputRoot',output];
 const recovered=JSON.parse((await ps(f.installer,[...args,'-Action','Recover','-Confirm'],f.env)).stdout);assert.equal(recovered.sourceChanges,false);await fs.access(legacy);await assert.rejects(fs.access(f.skill),{code:'ENOENT'});const done=JSON.parse((await ps(f.installer,[...args,'-Confirm','-PrerequisitesConfirmed'],f.env)).stdout);assert.equal(done.action,'RenameUpgrade');
});
test('release payload is explicit and excludes personal data, state, tests and snapshots',async()=>{
 const manifest=JSON.parse(await fs.readFile(path.join(packageRoot,'package-manifest.json'),'utf8'));
 for(const entry of manifest.files){assert.ok(!/(?:^|\\)(?:configs|runs|credentials|state|snapshots|tests|schemas)(?:\\|$)/i.test(entry.path));const data=await fs.readFile(path.join(packageRoot,'skill',entry.path),'utf8');assert.ok(!/(?:dev(?!123456\.|12345\.|123\.)\d{6,}\.service-now\.com|(?:m365cpi|diax)\d{6,}\.onmicrosoft\.com|C:\\Users\\(?!Public\b|example\b)[A-Za-z0-9_.-]+\\)/i.test(data),entry.path);}
 assert.ok(manifest.files.some(x=>x.path==='app\\install-layout.json'));
 assert.ok(manifest.files.some(x=>x.path==='scripts\\launch.ps1'));
 const guide=await fs.readFile(path.join(packageRoot,'PREREQUISITES.html'),'utf8');assert.equal(guide,await fs.readFile(path.join(packageRoot,'skill','app','PREREQUISITES.html'),'utf8'));
 assert.deepEqual((await fs.readdir(packageRoot)).sort(),['Install-SN-DemoLoader.ps1','Install.cmd','PREREQUISITES.html','package-manifest.json','skill']);
 assert.ok(!guide.includes('START-HERE.txt'));
});
test('source and installed locations stay distinct, absolute and outside runtime',async t=>{
 const f=await fixture(t),source=locations({projectRoot:root,env:f.env});assert.equal(source.installed,false);assert.equal(source.outputRoot,path.join(path.dirname(root),'SN-DemoSeed-Output'));
 assert.throws(()=>locations({projectRoot:root,runtime:path.join(f.temp,'other'),env:f.env}),{code:'runtime_unsafe'});
 assert.throws(()=>locations({projectRoot:root,output:path.join(f.runtime,'runs'),env:f.env}),{code:'runtime_unsafe'});
 assert.throws(()=>locations({projectRoot:root,output:root,env:f.env}),{code:'runtime_unsafe'});
 const app=path.join(f.temp,'portable skill','app');await fs.mkdir(app,{recursive:true});await fs.writeFile(path.join(app,'install-layout.json'),JSON.stringify({schemaVersion:1,product:'sn-demoseeder'}));
 assert.equal(locations({projectRoot:app,env:f.env}).outputRoot,f.output);
 await fs.writeFile(path.join(app,'install-layout.json'),'{}');assert.throws(()=>locations({projectRoot:app,env:f.env}),{code:'installation_invalid'});
 await fs.mkdir(path.join(f.runtime,'state'),{recursive:true});await fs.writeFile(path.join(f.runtime,'state','installation.lock'),'ACTIVE-INSTALL');
 assert.throws(()=>locations({projectRoot:root,env:f.env}),{code:'installation_busy'});
 const store=new ProfileStore({outputRoot:f.output,runtimeHome:f.runtime});let called=false;await assert.rejects(()=>store.locked(async()=>{called=true;}),{code:'installation_busy'});assert.equal(called,false);
});
test('Scout store junction is respected, but output cannot alias protected runtime',async t=>{
 const f=await fixture(t),actual=path.join(f.temp,'Authored Skills');await fs.mkdir(actual);await fs.mkdir(path.dirname(f.skillStore),{recursive:true});await fs.symlink(actual,f.skillStore,'junction');
 await fs.writeFile(path.join(actual,'keep-peer.txt'),'KEEP-PEER');await f.install(['-Confirm']);assert.equal(JSON.parse((await f.launch(['-Action','Paths'])).stdout).outputRoot,f.output);
 await f.install(['-Action','Uninstall','-Confirm']);assert.ok(await fs.readlink(f.skillStore));assert.equal(await fs.readFile(path.join(actual,'keep-peer.txt'),'utf8'),'KEEP-PEER');
 await fs.mkdir(f.runtime,{recursive:true});const alias=path.join(f.home,'runtime-alias');await fs.symlink(f.runtime,alias,'junction');
 assert.throws(()=>locations({projectRoot:root,output:alias,env:f.env}),{code:'runtime_unsafe'});
 await rejectsRun(()=>ps(f.installer,['-SkillStore',f.skillStore,'-OutputRoot',alias,'-Confirm'],f.env),/including through directory links/);
});
test('fresh install, packaged launcher, update and uninstall preserve all output and protected data',async t=>{
 const f=await fixture(t);
 await rejectsRun(()=>f.install(),/requires -Confirm/);
 const installed=JSON.parse((await ps(f.installer,['-SkillStore',f.skillStore,'-Confirm','-PrerequisitesConfirmed'],f.env)).stdout);assert.equal(installed.action,'Install');assert.equal(installed.outputRoot,f.output);assert.equal(installed.prerequisites.verified,false);
 const paths=JSON.parse((await f.launch(['-Action','Paths'])).stdout);assert.equal(paths.projectRoot,path.join(f.skill,'app'));assert.equal(paths.outputRoot,f.output);assert.equal(paths.runtimeHome,f.runtime);assert.equal(paths.installed,true);
 assert.equal(JSON.parse((await f.launch(['-Action','Doctor'])).stdout).networkRequests,false);
 assert.equal(JSON.parse((await f.launch(['-Action','Profiles'])).stdout).profiles.length,0);
 const data=path.join(f.output,'configs','keep.json'),credential=path.join(f.runtime,'credentials','opaque');await fs.writeFile(data,'KEEP-CONFIG');await fs.mkdir(path.dirname(credential),{recursive:true});await fs.writeFile(credential,'KEEP-ENCRYPTED-ENVELOPE');
 assert.equal(JSON.parse((await f.install(['-Action','Verify'])).stdout).version,release.version);
 assert.equal(JSON.parse((await f.install(['-Confirm'])).stdout).action,'Update');
 const newer=path.join(f.temp,'newer release');await fs.cp(packageRoot,newer,{recursive:true});const manifestFile=path.join(newer,'package-manifest.json'),manifest=JSON.parse(await fs.readFile(manifestFile,'utf8')),next=release.version.split('.').map(Number);next[2]++;const version=next.join('.');manifest.version=version;
 const releaseFile=path.join(newer,'skill','app','release.json'),metadata=JSON.parse(await fs.readFile(releaseFile,'utf8'));metadata.version=version;const changed=JSON.stringify(metadata);await fs.writeFile(releaseFile,changed);manifest.files.find(x=>x.path==='app\\release.json').sha256=createHash('sha256').update(changed).digest('hex');await fs.writeFile(manifestFile,JSON.stringify(manifest));
 assert.equal(JSON.parse((await ps(path.join(newer,'Install-SN-DemoLoader.ps1'),['-SkillStore',f.skillStore,'-OutputRoot',f.output,'-Confirm','-PrerequisitesConfirmed'],f.env)).stdout).version,version);
 assert.equal(JSON.parse((await f.launch(['-Action','Paths'])).stdout).version,version);await rejectsRun(()=>f.install(['-Confirm']),/downgrade is not supported/);
 assert.equal(await fs.readFile(data,'utf8'),'KEEP-CONFIG');assert.equal(await fs.readFile(credential,'utf8'),'KEEP-ENCRYPTED-ENVELOPE');
 await f.install(['-Action','Uninstall','-Confirm']);await assert.rejects(fs.access(f.skill),{code:'ENOENT'});
 assert.equal(await fs.readFile(data,'utf8'),'KEEP-CONFIG');assert.equal(await fs.readFile(credential,'utf8'),'KEEP-ENCRYPTED-ENVELOPE');
});
test('unmanaged, altered, extra files and PDI locks fail closed without replacement',async t=>{
 const f=await fixture(t);await fs.mkdir(f.skill,{recursive:true});await fs.writeFile(path.join(f.skill,'SKILL.md'),'AUTHORED');
 await rejectsRun(()=>f.install(['-Confirm']),/without an installation receipt/);assert.equal(await fs.readFile(path.join(f.skill,'SKILL.md'),'utf8'),'AUTHORED');
 await fs.rm(f.skill,{recursive:true});await f.install(['-Confirm']);
 const changed=path.join(f.skill,'app','release.json'),original=await fs.readFile(changed);await fs.appendFile(changed,' ');
 await rejectsRun(()=>f.install(['-Confirm']),/missing or changed/);await fs.writeFile(changed,original);
 const extra=path.join(f.skill,'my-notes.txt');await fs.writeFile(extra,'KEEP');await rejectsRun(()=>f.install(['-Confirm']),/Unmanaged file/);await fs.unlink(extra);
 const directory=path.join(f.skill,'keep-empty');await fs.mkdir(directory);await rejectsRun(()=>f.install(['-Confirm']),/Unmanaged directory/);await fs.rmdir(directory);
 const locks=path.join(f.runtime,'state','pdi-locks');await fs.mkdir(locks,{recursive:true});const lock=path.join(locks,'active.lock');await fs.writeFile(lock,'KEEP-LOCK');
 await rejectsRun(()=>f.install(['-Confirm']),/PDI execution lock/);assert.equal(await fs.readFile(lock,'utf8'),'KEEP-LOCK');
});
test('payload tampering and a duplicate global registration never overwrite a local skill',async t=>{
 const f=await fixture(t),copy=path.join(f.temp,'release');await fs.cp(packageRoot,copy,{recursive:true});await fs.appendFile(path.join(copy,'skill','SKILL.md'),'UNREVIEWED');
 await rejectsRun(()=>ps(path.join(copy,'Install-SN-DemoLoader.ps1'),['-SkillStore',f.skillStore,'-OutputRoot',f.output,'-Confirm'],f.env),/missing or changed/);
 await assert.rejects(fs.access(f.skill),{code:'ENOENT'});
 const global=path.join(f.home,'.copilot','skills','sn-demoseeder');await fs.mkdir(global,{recursive:true});await fs.writeFile(path.join(global,'SKILL.md'),'KEEP-GLOBAL');
 await rejectsRun(()=>f.install(['-Confirm']),/global sn-demoseeder registration/);assert.equal(await fs.readFile(path.join(global,'SKILL.md'),'utf8'),'KEEP-GLOBAL');
});
test('installed Configure is responsive, reuses only its owner and stops before update',async t=>{
 const f=await fixture(t);await f.install(['-Confirm']);
 const first=JSON.parse((await f.launch(['-Action','Configure'])).stdout);assert.equal(first.ok,true);assert.equal('url' in first,false);
 const state=JSON.parse(await fs.readFile(path.join(f.runtime,'state','config-server.json'),'utf8')),url=new URL(state.url),headers={'X-DemoSeeder-Token':url.hash.slice(9)};
 const api=await fetch(url.origin+'/api/state',{headers});assert.equal(api.status,200);assert.equal((await api.json()).storage.outputRoot,f.output);
 const page=await fetch(url.origin+'/config-builder.html');assert.equal(page.status,200);assert.ok((await page.text()).includes('output-storage-location'));assert.equal((await fetch(url.origin+'/sn-demoseeder-build-plan.html')).status,404);
 assert.equal(JSON.parse((await f.launch(['-Action','Configure'])).stdout).processId,first.processId);
 await rejectsRun(()=>f.install(['-Confirm']),/Config Builder is running/);
 await assert.rejects(()=>exec(process.execPath,[path.join(f.skill,'app','scripts','cli.cjs'),'serve'],{env:f.env,windowsHide:true,timeout:10000}),e=>e.stderr.includes('server_running'));
 await rejectsRun(()=>f.launch(['-Action','StopConfig']),/requires -Confirm/);
 assert.equal(JSON.parse((await f.launch(['-Action','StopConfig','-Confirm'])).stdout).stopped,true);
 assert.equal(JSON.parse((await f.install(['-Confirm'])).stdout).action,'Update');
});
test('expired-session stop requires exact token and blocks busy operations before closing',async t=>{
 const f=await fixture(t),store=new ProfileStore({outputRoot:f.output,runtimeHome:f.runtime});await store.initialize();
 const server=new ConfigServer({store,adapter:{},projectRoot:root});await server.start();t.after(()=>server.close());server.expiresAt=0;
 let stopped=false;server.onShutdown=()=>{stopped=true;};
 const call=(route,body,token=server.token)=>fetch(server.origin+route,{method:body?'POST':'GET',headers:{'X-DemoSeeder-Token':token,...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});
 assert.equal((await call('/api/state')).status,401);assert.equal((await call('/api/server/status',null,'wrong')).status,401);
 assert.equal((await (await call('/api/server/status')).json()).expired,true);
 assert.equal((await call('/api/server/stop',{confirmed:false})).status,409);
 server.busy.add('operation');assert.equal((await call('/api/server/stop',{confirmed:true})).status,409);assert.equal(stopped,false);server.busy.clear();
 const locks=path.join(f.runtime,'state','pdi-locks');await fs.mkdir(locks,{recursive:true});await fs.writeFile(path.join(locks,'still-owned.lock'),'LOCK');assert.equal((await call('/api/server/stop',{confirmed:true})).status,409);assert.equal(server.stopRequested,false);await fs.unlink(path.join(locks,'still-owned.lock'));
 assert.equal((await call('/api/server/stop',{confirmed:true})).status,200);await new Promise(r=>setTimeout(r,20));assert.equal(stopped,true);
});

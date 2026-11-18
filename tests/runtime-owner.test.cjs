'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
const {classify,inspectService,quarantineStartup}=require('../lib/runtime-owner.cjs');
const {findEdge}=require('../lib/dependencies.cjs');
const time='2026-01-01T10:00:00.1230000Z',exe='C:\\Tools\\node.exe';
const identity={pid:123,startedAt:time,executablePath:exe};
const record={schemaVersion:2,pid:123,processStartedAt:time,executablePath:exe,startedAt:'2026-01-01T10:00:01.000Z',projectRoot:'C:\\Skill\\app',outputRoot:'C:\\Output',url:'http://127.0.0.1:12345/config-builder.html#session=unit-fixture'};
async function fixture(t){const root=await fs.mkdtemp(path.join(os.tmpdir(),'sn-owner-'));await fs.mkdir(path.join(root,'state'));t.after(()=>fs.rm(root,{recursive:true,force:true}));return root;}
test('exact creation time and executable identify the owner; a reused PID is not live',()=>{
 assert.equal(classify(record,identity).state,'live');assert.equal(classify(record,null).reason,'owner_stopped');
 assert.equal(classify(record,{...identity,startedAt:'2026-01-02T10:00:00Z'}).reason,'pid_reused');
 assert.equal(classify(record,{...identity,executablePath:'C:\\Other\\node.exe'}).state,'unknown');
 const legacy={...record,processStartedAt:undefined};assert.equal(classify(legacy,identity).state,'live');assert.equal(classify({...legacy,startedAt:'2020-01-01T00:00:00Z'},identity).state,'stale');
});
test('stale startup is archived without stopping a process or clearing source authority',async t=>{
 const root=await fixture(t),startup=path.join(root,'state','config-server.json');await fs.writeFile(startup,JSON.stringify(record));
 const probe=()=>null,current=await inspectService(root,{probe});assert.equal(current.state,'stale');
 const recovered=await quarantineStartup(root,current.hash,{probe});assert.equal(recovered.processStopped,false);assert.deepEqual(JSON.parse(await fs.readFile(recovered.archivedStartup,'utf8')),record);await assert.rejects(fs.access(startup),{code:'ENOENT'});
});
test('changed startup, live owner, malformed data and foreign URL cannot be recovered as stale',async t=>{
 const root=await fixture(t),startup=path.join(root,'state','config-server.json');await fs.writeFile(startup,JSON.stringify(record));
 const current=await inspectService(root,{probe:()=>null});await fs.writeFile(startup,JSON.stringify({...record,pid:456}));await assert.rejects(()=>quarantineStartup(root,current.hash,{probe:()=>null}),{code:'owner_changed'});
 const live=await inspectService(root,{probe:()=>identity});await assert.rejects(()=>quarantineStartup(root,live.hash,{probe:()=>identity}),{code:'owner_changed'});
 await fs.writeFile(startup,JSON.stringify({...record,url:'https://example.com/'}));await assert.rejects(()=>inspectService(root,{probe:()=>null}),{code:'owner_state_invalid'});
});
test('Edge discovery supports x86, 64-bit and per-user installations',async t=>{
 const root=await fixture(t),x86=path.join(root,'x86'),x64=path.join(root,'x64'),local=path.join(root,'local'),env={'ProgramFiles(x86)':x86,ProgramFiles:x64,LOCALAPPDATA:local};
 assert.equal(findEdge(env),null);
 for(const prefix of [local,x64,x86]){const edge=path.join(prefix,'Microsoft','Edge','Application','msedge.exe');await fs.mkdir(path.dirname(edge),{recursive:true});await fs.writeFile(edge,'presence-only-fixture');assert.equal(findEdge(env),edge);}
});

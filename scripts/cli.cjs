'use strict';
const path=require('node:path');
const fs=require('node:fs/promises');
const {spawn}=require('node:child_process');
const {ProfileStore,atomic,error}=require('../lib/profiles.cjs');
const {PlatformAdapter}=require('../lib/platform.cjs');
const {ConfigServer}=require('../lib/server.cjs');
const {Onboarding}=require('../lib/onboarding.cjs');
const {PeopleProvisioning}=require('../lib/people.cjs');
const {ContentProvisioning}=require('../lib/content.cjs');
const {KnowledgePublication}=require('../lib/knowledge.cjs');
const {HRKnowledgePack}=require('../lib/knowledge-pack.cjs');
const {locations}=require('../lib/locations.cjs');
const release=require('../release.json');
const {dependencies}=require('../lib/dependencies.cjs');
const {inspectService,publicService,quarantineStartup,currentProcess}=require('../lib/runtime-owner.cjs');
function args(argv){const out={command:argv[0]||'menu'};for(let i=1;i<argv.length;i++){if(!argv[i].startsWith('--'))throw error('Unexpected command argument.');const key=argv[i].slice(2);if(['open'].includes(key))out[key]=true;else{if(!argv[i+1]||argv[i+1].startsWith('--'))throw error('Missing command value.');out[key]=argv[++i];}}return out;}
async function openBrowser(url){if(process.platform!=='win32')throw error('Opening the initial setup page requires Windows.');await new Promise((resolve,reject)=>{const child=spawn('pwsh.exe',['-NoProfile','-NonInteractive','-Command',"$u=[Console]::In.ReadToEnd(); Start-Process $u"],{windowsHide:true,stdio:['pipe','ignore','ignore']});child.on('error',()=>reject(error('Could not open the initial configuration page.')));child.on('close',code=>code===0?resolve():reject(error('Could not open the initial configuration page.')));child.stdin.on('error',()=>reject(error('Could not pass the local setup address to the browser.')));child.stdin.end(url);});}
async function main(){const options=args(process.argv.slice(2));if(options.command==='dependencies'){console.log(JSON.stringify(dependencies()));return;}const root=path.resolve(__dirname,'..');const resolved=locations({projectRoot:root,output:options.output,runtime:options.runtime,allowInstallationLock:['paths','service-status'].includes(options.command)&&options.diagnostic==='true'});const {outputRoot,runtimeHome}=resolved;if(Number(process.versions.node.split('.')[0])<release.minimumNodeMajor)throw error('Node.js '+release.minimumNodeMajor+' or newer is required.','dependency_missing',409);if(options.command==='paths'){console.log(JSON.stringify({ok:true,...resolved}));return;}if(options.command==='doctor'){console.log(JSON.stringify({...dependencies(),...resolved,bootstrapMachine:'Create an active API-enabled Machine in the PDI with reviewed provisioning roles before onboarding. Enter credentials only in Access.'}));return;}if(options.command==='service-status'){console.log(JSON.stringify({ok:true,...publicService(await inspectService(runtimeHome))}));return;}const store=new ProfileStore({outputRoot,runtimeHome});const adapter=new PlatformAdapter({runtimeHome,scriptRoot:__dirname});await store.initialize();let result;
 switch(options.command){
  case 'pack-preview':{const profile=await store.resolve(options.name);result={ok:true,pack:await new HRKnowledgePack({store,adapter}).preview(profile.id,profile.revision,options.person)};break;}
  case 'pack-status':{const packs=new HRKnowledgePack({store,adapter});result={ok:true,pack:options.plan?await packs.status(options.plan):await packs.statusForProfile((await store.resolve(options.name)).id)};break;}
  case 'pack-approve':result={ok:true,pack:await new HRKnowledgePack({store,adapter}).approve(options.plan,options.hash,options.confirmed==='true')};break;
  case 'pack-apply':case 'pack-reconcile':result={ok:true,pack:await new HRKnowledgePack({store,adapter}).apply(options.plan,options.hash,{reconcile:options.command==='pack-reconcile'})};break;
 case 'menu':result=await store.menu(adapter);break;
 case 'profiles':result={ok:true,...await store.state(adapter)};break;
 case 'history':result={ok:true,runs:await store.history()};break;
  case 'machine-preview':{const profile=await store.resolve(options.name);const roles=(options.roles||'').split(',').map(value=>value.trim()).filter(Boolean);result={ok:true,onboarding:await new Onboarding({store,adapter}).preview(profile.id,profile.revision,roles)};break;}
  case 'machine-status':{const onboarding=new Onboarding({store,adapter});result={ok:true,onboarding:options.plan?await onboarding.status(options.plan):await onboarding.statusForProfile((await store.resolve(options.name)).id)};break;}
  case 'machine-approve':result={ok:true,onboarding:await new Onboarding({store,adapter}).approve(options.plan,options.hash,options.confirmed==='true')};break;
  case 'machine-apply':case 'machine-reconcile':result={ok:true,onboarding:await new Onboarding({store,adapter}).apply(options.plan,options.hash,{reconcile:options.command==='machine-reconcile'})};break;
  case 'people-preview':{const profile=await store.resolve(options.name);result={ok:true,people:await new PeopleProvisioning({store,adapter}).preview(profile.id,profile.revision)};break;}
  case 'people-status':{const people=new PeopleProvisioning({store,adapter});result={ok:true,people:options.plan?await people.status(options.plan):await people.statusForProfile((await store.resolve(options.name)).id)};break;}
  case 'people-approve':result={ok:true,people:await new PeopleProvisioning({store,adapter}).approve(options.plan,options.hash,options.confirmed==='true')};break;
  case 'people-apply':case 'people-reconcile':result={ok:true,people:await new PeopleProvisioning({store,adapter}).apply(options.plan,options.hash,{reconcile:options.command==='people-reconcile'})};break;
  case 'content-preview':{if(!options.input)throw error('Content preview requires a nonsecret normalized input JSON.');const profile=await store.resolve(options.name),input=JSON.parse(await fs.readFile(path.resolve(options.input),'utf8'));result={ok:true,content:await new ContentProvisioning({store,adapter}).preview(profile.id,profile.revision,input)};break;}
  case 'content-status':{const content=new ContentProvisioning({store,adapter});result={ok:true,content:options.plan?await content.status(options.plan):await content.statusForProfile((await store.resolve(options.name)).id)};break;}
  case 'content-approve':result={ok:true,content:await new ContentProvisioning({store,adapter}).approve(options.plan,options.hash,options.confirmed==='true')};break;
  case 'content-apply':case 'content-reconcile':result={ok:true,content:await new ContentProvisioning({store,adapter}).apply(options.plan,options.hash,{reconcile:options.command==='content-reconcile'})};break;
  case 'knowledge-preview':{const profile=await store.resolve(options.name);result={ok:true,publication:await new KnowledgePublication({store,adapter}).preview(profile.id,profile.revision,options.record)};break;}
  case 'knowledge-status':{const knowledge=new KnowledgePublication({store,adapter});result={ok:true,publication:options.plan?await knowledge.status(options.plan):await knowledge.statusForProfile((await store.resolve(options.name)).id)};break;}
  case 'knowledge-approve':result={ok:true,publication:await new KnowledgePublication({store,adapter}).approve(options.plan,options.hash,options.confirmed==='true')};break;
  case 'knowledge-apply':case 'knowledge-reconcile':result={ok:true,publication:await new KnowledgePublication({store,adapter}).apply(options.plan,options.hash,{reconcile:options.command==='knowledge-reconcile'})};break;
 case 'use':{const profile=await store.resolve(options.name);result={ok:true,profile:await store.view(await store.select(profile.id),adapter)};break;}
 case 'save':{if(!options.input)throw error('Provide --input with a nonsecret JSON config.');const data=JSON.parse(await fs.readFile(path.resolve(options.input),'utf8'));result={ok:true,profile:await store.view(await store.save(data),adapter)};break;}
 case 'serve':{
  const startupFile=path.join(runtimeHome,'state','config-server.json'),server=new ConfigServer({store,adapter,projectRoot:root});let launched;
  await store.locked(async()=>{
   const previous=await inspectService(runtimeHome);
   if(previous.state==='stale')await quarantineStartup(runtimeHome,previous.hash);
   else if(previous.state!=='absent')throw error('A live or unverified Config Builder owns this runtime. Use its launcher or installer Diagnose before starting another.','server_running',409);
   const owner=currentProcess();
   launched=await server.start();
   try{await atomic(startupFile,{schemaVersion:2,pid:process.pid,processStartedAt:owner.startedAt,executablePath:owner.executablePath,url:launched.url,startedAt:new Date().toISOString(),projectRoot:root,outputRoot});}catch(e){await server.close();throw e;}
  });
  let closing=false;const stop=async()=>{if(closing)return;closing=true;await server.close();const state=JSON.parse(await fs.readFile(startupFile,'utf8'));if(state.pid===process.pid)await fs.unlink(startupFile);};
  server.onShutdown=stop;console.log(JSON.stringify({ok:true,origin:server.origin,processId:process.pid,outputRoot,capabilities:{config:true,seeding:false}}));if(options.open)await openBrowser(launched.url);
  process.on('SIGINT',()=>stop().then(()=>process.exit(0),()=>process.exit(1)));process.on('SIGTERM',()=>stop().then(()=>process.exit(0),()=>process.exit(1)));return;
 }
  default:throw error('Supported commands: menu, profiles, use --name, save --input, history, serve --open, machine-preview --name, machine-status, machine-approve --plan --hash --confirmed true, machine-apply --plan --hash, machine-reconcile --plan --hash, people-preview --name, people-status, people-approve --plan --hash --confirmed true, people-apply --plan --hash, people-reconcile --plan --hash. Reviewed content-preview --name --input, content-status, content-approve --plan --hash --confirmed true, content-apply --plan --hash and content-reconcile --plan --hash are available. Existing Draft publication uses knowledge-preview --name --record, knowledge-status, knowledge-approve --plan --hash --confirmed true, knowledge-apply --plan --hash and knowledge-reconcile --plan --hash. Content updates, checkout/revision and bulk reseeding remain unavailable.','not_implemented');
 }
 console.log(JSON.stringify(result));
}
main().catch(async e=>{const failure={ok:false,error:e.status||e.code?e.message:'The local operation failed. No success was confirmed.',code:e.code||'local_error'};console.error(JSON.stringify(failure));process.exitCode=1;if(process.argv[2]==='serve'&&process.env.LOCALAPPDATA){try{await atomic(path.join(process.env.LOCALAPPDATA,'Scout','ServiceNowDemoSeeder','state','config-server-error.json'),{...failure,pid:process.pid,at:new Date().toISOString()});}catch{console.error('The local server failure could not be recorded. Inspect this exact process before restarting.');}}});

'use strict';
const http=require('node:http');
const fs=require('node:fs/promises');
const path=require('node:path');
const {randomBytes,randomUUID,timingSafeEqual}=require('node:crypto');
const {error,configFilename}=require('./profiles.cjs');
const {Onboarding}=require('./onboarding.cjs');
const {PeopleProvisioning}=require('./people.cjs');
const {ContentProvisioning}=require('./content.cjs');
const {KnowledgePublication}=require('./knowledge.cjs');
const {HRKnowledgePack}=require('./knowledge-pack.cjs');
function tokenMatches(actual,expected){if(typeof actual!=='string')return false;const a=Buffer.from(actual),b=Buffer.from(expected);return a.length===b.length&&timingSafeEqual(a,b);}
function exactBody(body,allowed){if(!body||typeof body!=='object'||Array.isArray(body))throw error('Expected a JSON object.');for(const field of Object.keys(body))if(!allowed.includes(field))throw error(`Unexpected input field: ${field}.`);}
async function bodyJson(req){const chunks=[];let size=0;for await(const part of req){size+=part.length;if(size>65536)throw error('Request exceeds the local input limit.','too_large',413);chunks.push(part);}try{return JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw error('Request was not valid JSON.');}}
class ConfigServer{
 constructor({store,adapter,projectRoot,token=randomBytes(32).toString('base64url')}){this.store=store;this.adapter=adapter;this.onboarding=new Onboarding({store,adapter});this.people=new PeopleProvisioning({store,adapter});this.content=new ContentProvisioning({store,adapter});this.knowledge=new KnowledgePublication({store,adapter});this.knowledgePack=new HRKnowledgePack({store,adapter});this.projectRoot=path.resolve(projectRoot);this.token=token;this.jobs=new Map();this.busy=new Set();this.server=null;this.origin=null;this.expiresAt=Date.now()+8*60*60*1000;}
 assertIdle(profileId){if(this.stopRequested)throw error('The local service is stopping.','server_stopping',409);if(this.busy.has(profileId))throw error('This config has a running connection action. Wait for it to finish.','profile_busy',409);}
 async start(port=0){await this.store.initialize();this.server=http.createServer((req,res)=>{this.handle(req,res).catch(e=>{if(!res.headersSent){this.json(res,e.status||500,{ok:false,error:e.status?e.message:'The local service encountered an error. No successful operation was confirmed.',code:e.code||'internal_error'});}else res.destroy();});});this.server.requestTimeout=35000;this.server.headersTimeout=15000;await new Promise((resolve,reject)=>{this.server.once('error',reject);this.server.listen(port,'127.0.0.1',resolve);});this.origin=`http://127.0.0.1:${this.server.address().port}`;return {url:this.origin+'/config-builder.html#session='+this.token,port:this.server.address().port};}
 async close(){for(const job of this.jobs.values())if(['running','waiting'].includes(job.status))job.controller.abort();if(this.server)await new Promise(resolve=>this.server.close(resolve));}
 json(res,status,data){res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer'});res.end(JSON.stringify(data));}
 job(profile,work){this.assertIdle(profile.id);if(this.jobs.size>=100)throw error('Local job limit reached. Restart the local service after active jobs finish.','job_limit',409);const id=randomUUID();const controller=new AbortController();const job={id,status:'running',message:'Starting local action.',result:null,controller};this.jobs.set(id,job);this.busy.add(profile.id);const timer=setTimeout(()=>controller.abort(),9*60*1000);const progress=update=>{if(controller.signal.aborted)return;if(!['running','waiting'].includes(update.status))throw error('Unsupported job progress.');job.status=update.status;job.message=String(update.message||'Local action in progress.').slice(0,1000);if(update.deviceCode&&update.verificationUrl==='https://microsoft.com/devicelogin'){job.deviceCode=update.deviceCode;job.verificationUrl=update.verificationUrl;}};Promise.resolve().then(()=>work(progress,controller.signal)).then(result=>{job.result=result;job.status=result.cancelled?'cancelled':'complete';job.message=result.message||(result.saved===false?'No credential was saved.':result.status==='blocked'?result.message:'Local action completed. No tenant records were changed.');}).catch(e=>{job.status=controller.signal.aborted?'cancelled':'failed';job.message=e.status||e.code?e.message:'Local action failed. No successful result was confirmed.';}).finally(()=>{clearTimeout(timer);this.busy.delete(profile.id);delete job.deviceCode;delete job.verificationUrl;});return id;}
 publicJob(job){const {controller,...value}=job;return value;}
 async handle(req,res){if(req.headers.host!==new URL(this.origin).host)throw error('Unexpected local Host header.','origin_rejected',403);if(req.headers.origin&&req.headers.origin!==this.origin)throw error('Cross-origin request rejected.','origin_rejected',403);const url=new URL(req.url,this.origin);if(url.origin!==this.origin)throw error('Unexpected local origin.','origin_rejected',403);const pathname=url.pathname;
 if(!pathname.startsWith('/api/')){if(req.method!=='GET')throw error('Only GET is supported here.','method_not_allowed',405);const filename=pathname==='/'?'config-builder.html':pathname.slice(1);if(!['config-builder.html','sn-demoseeder-build-plan.html','PREREQUISITES.html'].includes(filename))throw error('Static resource not available.','not_found',404);let content;try{content=await fs.readFile(path.join(this.projectRoot,filename));}catch(e){if(e.code!=='ENOENT')throw e;throw error('Static resource is not included in this installation.','not_found',404);}res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer','Content-Security-Policy':"default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; font-src 'none'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'"});res.end(content);return;}
  if(Date.now()>this.expiresAt&&!['/api/server/status','/api/server/stop'].includes(pathname))throw error('Local setup session expired. Use StopConfig, then Configure to open a fresh session.','expired',401);if(!tokenMatches(req.headers['x-demoseeder-token'],this.token))throw error('The local session token was not accepted.','unauthorized',401);if(this.stopRequested)throw error('The local service is stopping.','server_stopping',409);if(!['GET','POST'].includes(req.method))throw error('Unsupported local API method.','method_not_allowed',405);let body;if(req.method==='POST'){if((req.headers['content-type']||'').split(';')[0]!=='application/json')throw error('POST requires application/json.','content_type',415);body=await bodyJson(req);}
 let response;
  if(req.method==='GET'&&pathname==='/api/server/status')response={ok:true,projectRoot:this.projectRoot,outputRoot:this.store.outputRoot,version:require('../release.json').version,expired:Date.now()>this.expiresAt,busy:this.busy.size>0};
  else if(req.method==='POST'&&pathname==='/api/server/stop'){
   exactBody(body,['confirmed']);if(body.confirmed!==true)throw error('Confirm stopping this local Config Builder.','confirmation_required',409);
   if(this.busy.size)throw error('A local action is still running. Wait for it before stopping.','profile_busy',409);
   this.stopRequested=true;
   try{
    let locks=[];try{locks=await fs.readdir(path.join(this.store.runtimeHome,'state','pdi-locks'));}catch(e){if(e.code!=='ENOENT')throw e;}
    let registryLocked=true;try{await fs.access(this.store.lockFile);}catch(e){if(e.code!=='ENOENT')throw e;registryLocked=false;}
    if(this.busy.size||locks.length||registryLocked)throw error('Local execution is locked. Finish/reconcile its owner before stopping.','profile_busy',409);
   }catch(e){this.stopRequested=false;throw e;}
   response={ok:true,stopping:true};
  }
  else if(req.method==='GET'&&pathname==='/api/state')response={ok:true,...await this.store.state(this.adapter)};
  else if(req.method==='POST'&&pathname==='/api/packs/hr/preview'){
   exactBody(body,['profileId','expectedRevision','personId']);const profile=await this.store.get(body.profileId);
   response={ok:true,jobId:this.job(profile,async(progress,signal)=>({pack:await this.knowledgePack.preview(profile.id,body.expectedRevision,body.personId,{signal}),message:'HR pack preview inspected. Review its exact content, scoped access and blockers; no source writes were made.'}))};
  }
  else if(req.method==='POST'&&pathname==='/api/packs/hr/approve'){
   exactBody(body,['planId','planHash','confirmed']);const state=await this.knowledgePack.status(body.planId);this.assertIdle(state.plan.context.profileId);response={ok:true,pack:await this.knowledgePack.approve(body.planId,body.planHash,body.confirmed)};
  }
  else if(req.method==='POST'&&['/api/packs/hr/apply','/api/packs/hr/reconcile'].includes(pathname)){
   exactBody(body,['planId','planHash']);const state=await this.knowledgePack.status(body.planId),profile=await this.store.get(state.plan.context.profileId);
   response={ok:true,jobId:this.job(profile,async(progress,signal)=>{const reconcile=pathname.endsWith('/reconcile'),pack=await this.knowledgePack.apply(body.planId,body.planHash,{signal,reconcile});return {pack,message:reconcile?'HR pack inspected read-only. Status: '+pack.status+'. No source writes were retried.':'HR pack status: '+pack.status+'. Inspect the exact record/access receipts; an uncertain result must not be rerun.'};})};
  }
  else if(req.method==='GET'&&pathname==='/api/packs/hr/status')response={ok:true,pack:url.searchParams.has('planId')?await this.knowledgePack.status(url.searchParams.get('planId')):await this.knowledgePack.statusForProfile(url.searchParams.get('profileId'))};
 else if(req.method==='POST'&&pathname==='/api/profiles'){if(body.id)this.assertIdle(body.id);const profile=await this.store.save(body);response={ok:true,profile:await this.store.view(profile,this.adapter)};}
  else if(req.method==='POST'&&pathname==='/api/load-profile'){
   exactBody(body,['config','confirmed']);const loaded=await this.store.loadProfile(body.config,body.confirmed);
   response={ok:true,profile:await this.store.view(loaded.profile,this.adapter),loadedExisting:loaded.loadedExisting};
  }
  else if(req.method==='POST'&&pathname==='/api/save-credential'){
   exactBody(body,['profileId','expectedRevision','purpose','password']);
   if(typeof body.password!=='string'||!body.password.length||body.password.length>4096||body.password.includes('\0'))throw error('Enter a password of 1 to 4096 characters without NUL.');
   let password=body.password;delete body.password;
   try{
    if(!['admin','integration'].includes(body.purpose))throw error('Choose admin or Machine credentials.');
    if(typeof this.adapter.saveCredential!=='function')throw error('Inline password saving is unavailable. Restart the updated local setup service.','not_implemented',409);
    const profile=await this.store.get(body.profileId);
    if(body.expectedRevision!==profile.revision)throw error('Config changed before saving the password. Reload and enter it again.','stale_profile',409);
     if(body.purpose==='integration'&&profile.integrationMode==='create'&&!await this.onboarding.existingTarget(profile))throw error('Discover the existing Machine account or complete approved creation before saving its password.','provisioning_required',409);
    this.assertIdle(profile.id);let pendingPassword=password;password=null;
    const jobId=this.job(profile,async(progress,signal)=>{
     let value=pendingPassword;pendingPassword=null;
     try{return await this.store.executeLocal(profile,'credential.save',async(current,lease)=>{
      await this.store.invalidate(current,body.purpose,lease);
      const saved=await this.adapter.saveCredential(current,body.purpose,value,{signal});
      if(saved?.saved!==true)throw error('The encrypted password save was not confirmed.','credential_save_failed',500);
      return {saved:true,message:'Password saved with Windows encryption for this identity. No connection or source changes were made.'};
     });}finally{value=null;pendingPassword=null;}
    });
    response={ok:true,jobId};
   }finally{password=null;}
  }
 else if(req.method==='POST'&&pathname==='/api/select'){exactBody(body,['profileId']);this.assertIdle(body.profileId);const selected=await this.store.select(body.profileId);response={ok:true,selectedProfileId:selected.id,profile:await this.store.view(selected,this.adapter)};}
  else if(req.method==='POST'&&pathname==='/api/delete-profile'){exactBody(body,['profileId','expectedRevision','confirmed']);if(body.confirmed!==true)throw error('Explicit confirmation is required to delete the saved config.','confirmation_required',409);this.assertIdle(body.profileId);response={ok:true,...await this.store.delete(body.profileId,body.expectedRevision)};}
  else if(req.method==='POST'&&['/api/credentials','/api/test-pdi'].includes(pathname)){
   exactBody(body,['profileId','purpose']);const profile=await this.store.get(body.profileId);
   if(!['admin','integration'].includes(body.purpose))throw error('Choose admin or integration credentials.');
    if(body.purpose==='integration'&&profile.integrationMode==='create'&&!await this.onboarding.existingTarget(profile))throw error('Discover the existing Machine account or complete approved setup before testing its credentials.','provisioning_required',409);
   const jobId=this.job(profile,async(progress,signal)=>this.store.executeLocal(profile,pathname,async(current,lease)=>{
    if(pathname==='/api/credentials'){await this.store.invalidate(current,body.purpose,lease);return this.adapter.captureCredential(current,body.purpose,progress,{signal});}
    const result=await this.adapter.testPdi(current,body.purpose,{signal});await this.store.recordCheck(current,body.purpose,result,lease);return result;
   }));response={ok:true,jobId};
  }
 else if(req.method==='POST'&&pathname==='/api/onboarding/preview'){
  exactBody(body,['profileId','expectedRevision','roles']);const profile=await this.store.get(body.profileId);
  const jobId=this.job(profile,async(progress,signal)=>{progress({status:'running',message:'Reading exact admin, Machine identity schema and installed role assignments. No writes.'});const onboarding=await this.onboarding.preview(profile.id,body.expectedRevision,body.roles,{signal});return {onboarding,message:onboarding.status==='blocked'?'Onboarding preview is blocked. Review exact prerequisites; no source records changed.':onboarding.plan.payload.mode==='create'?'Exact missing-Machine creation preview prepared. Review the target, actor, fields, generated-credential handling and roles; no source changes have run.':'Exact reuse preview prepared. Review and separately approve read-only verification; no password or role changes.'};});response={ok:true,jobId};
 }
 else if(req.method==='POST'&&pathname==='/api/onboarding/approve'){
  exactBody(body,['planId','planHash','confirmed']);const state=await this.onboarding.status(body.planId);this.assertIdle(state.plan.context.profileId);response={ok:true,onboarding:await this.onboarding.approve(body.planId,body.planHash,body.confirmed)};
 }
 else if(req.method==='POST'&&['/api/onboarding/apply','/api/onboarding/reconcile'].includes(pathname)){
  exactBody(body,['planId','planHash']);const state=await this.onboarding.status(body.planId);const profile=await this.store.get(state.plan.context.profileId);
   const jobId=this.job(profile,async(progress,signal)=>{const onboarding=await this.onboarding.apply(body.planId,body.planHash,{signal,reconcile:pathname.endsWith('/reconcile')});return {onboarding,message:'Onboarding '+onboarding.status+'. '+(onboarding.plan.payload.mode==='create'?'Inspect the exact per-step creation/role journal; connector readiness is unknown.':'Read-only reuse verification; no source writes, password changes or role grants.')};});response={ok:true,jobId};
 }
 else if(req.method==='GET'&&pathname==='/api/onboarding/status')response={ok:true,onboarding:url.searchParams.has('planId')?await this.onboarding.status(url.searchParams.get('planId')):await this.onboarding.statusForProfile(url.searchParams.get('profileId'))};
  else if(req.method==='POST'&&pathname==='/api/provision-people/preview'){
   exactBody(body,['profileId','expectedRevision']);const profile=await this.store.get(body.profileId);
   const jobId=this.job(profile,async(progress,signal)=>{const people=await this.people.preview(profile.id,body.expectedRevision,{signal});return {people,message:'People preview '+people.status+'. No source writes. Review exact fields and roles before approval.'};});response={ok:true,jobId};
  }
  else if(req.method==='POST'&&pathname==='/api/provision-people/person-preview'){
   exactBody(body,['profileId','expectedRevision','person','confirmedExternalEmail']);if(body.confirmedExternalEmail!==undefined&&typeof body.confirmedExternalEmail!=='boolean')throw error('Explicit email-domain acknowledgment must be Boolean.');
   const profile=await this.store.get(body.profileId);const jobId=this.job(profile,async(progress,signal)=>{const people=await this.people.previewPerson(profile.id,body.expectedRevision,body.person,{signal,confirmedExternalEmail:body.confirmedExternalEmail===true});return {people,message:'Single-account source preview '+people.status+'. No config, Microsoft tenant or source account was changed.'};});response={ok:true,jobId};
  }
  else if(req.method==='POST'&&pathname==='/api/person-passwords/preview'){
   exactBody(body,['profileId','expectedRevision','targets']);const profile=await this.store.get(body.profileId);const jobId=this.job(profile,async(progress,signal)=>{const people=await this.people.previewPasswords(profile.id,body.expectedRevision,body.targets,{signal});return {people,message:'Exact ServiceNow password-target preview prepared without reading or storing a password.'};});response={ok:true,jobId};
  }
  else if(req.method==='POST'&&['/api/person-passwords/apply','/api/person-passwords/verify'].includes(pathname)){
   exactBody(body,['planId','planHash','password']);if(typeof body.password!=='string'||!body.password.length||body.password.length>4096||body.password.includes('\0'))throw error('Supply the password only in this authenticated request.');
   let pending=body.password;delete body.password;
   try{const state=await this.people.status(body.planId);if(state.plan.kind!=='passwords')throw error('Select an exact password-change plan.');const profile=await this.store.get(state.plan.context.profileId);
    const jobId=this.job(profile,async(progress,signal)=>{let value=pending;pending=null;try{const people=await this.people.applyPasswords(state,body.planHash,{signal,password:value,reconcile:pathname.endsWith('/verify')});return {people,message:'ServiceNow password operation '+people.status+'. Inspect accepted writes and credential verification; no password was retained.'};}finally{value=null;}});response={ok:true,jobId};
   }catch(e){pending=null;throw e;}
  }
  else if(req.method==='POST'&&pathname==='/api/provision-people/approve'){
   exactBody(body,['planId','planHash','confirmed']);const state=await this.people.status(body.planId);this.assertIdle(state.plan.context.profileId);response={ok:true,people:await this.people.approve(body.planId,body.planHash,body.confirmed)};
  }
  else if(req.method==='POST'&&['/api/provision-people/apply','/api/provision-people/reconcile'].includes(pathname)){
   exactBody(body,['planId','planHash']);const state=await this.people.status(body.planId),profile=await this.store.get(state.plan.context.profileId);
   const jobId=this.job(profile,async(progress,signal)=>{const people=await this.people.apply(body.planId,body.planHash,{signal,reconcile:pathname.endsWith('/reconcile')});return {people,message:'People provisioning '+people.status+'. Inspect the durable per-step outcome; connector readiness is not established.'};});response={ok:true,jobId};
  }
  else if(req.method==='GET'&&pathname==='/api/provision-people/status')response={ok:true,people:url.searchParams.has('planId')?await this.people.status(url.searchParams.get('planId')):await this.people.statusForProfile(url.searchParams.get('profileId'))};
  else if(req.method==='POST'&&pathname==='/api/content/preflight'){
   exactBody(body,['profileId','expectedRevision']);const profile=await this.store.get(body.profileId);if(profile.revision!==body.expectedRevision)throw error('Config changed before content preparation.','stale_profile',409);
   const input={manualPeople:profile.manualPeople||[]},context=this.store.makeContext(profile,'content.prepare',input);
   const jobId=this.job(profile,async(progress,signal)=>this.store.execute(context,input,async current=>{
    const inspected=await this.people.inspect(current,randomUUID(),[],{signal});
    if(inspected.payload.blockers.length||inspected.payload.operations.some(person=>person.kind!=='reuse'))throw error('Resolve and verify all configured people before preparing content. No source changes were run.','content_people_not_ready',409);
    const metadata={};for(const resource of ['contentDictionary','contentChoices','knowledgeBases']){const result=await this.adapter.readBootstrap(current,resource,{}, {signal});if(result.outcome!=='readable'||result.truncated||!Array.isArray(result.rows))throw error('Content schema, choices or Knowledge bases are unreadable/truncated. No content write is permitted.','content_metadata_unknown',409);metadata[resource]=result.rows;}
    return {contentPreflight:{profileId:current.id,profileRevision:current.revision,pdiUrl:current.pdiUrl,tenantInput:current.tenantInput,actor:inspected.payload.actor,people:inspected.payload.operations,metadata,sourceWrites:false,writeReadiness:'not-tested',connectorReadiness:'unknown'},message:'Content preparation metadata read. No incident or Knowledge article was created or published.'};
   }));response={ok:true,jobId};
  }
  else if(req.method==='POST'&&pathname==='/api/content/preview'){
   exactBody(body,['profileId','expectedRevision','input']);const profile=await this.store.get(body.profileId);const jobId=this.job(profile,async(progress,signal)=>{const content=await this.content.preview(profile.id,body.expectedRevision,body.input,{signal});return {content,message:'Content plan '+content.status+'. Review exact fields and references, including Knowledge publication intent.'};});response={ok:true,jobId};
  }
  else if(req.method==='POST'&&pathname==='/api/content/approve'){
   exactBody(body,['planId','planHash','confirmed']);const state=await this.content.status(body.planId);this.assertIdle(state.plan.context.profileId);response={ok:true,content:await this.content.approve(body.planId,body.planHash,body.confirmed)};
  }
  else if(req.method==='POST'&&['/api/content/apply','/api/content/reconcile'].includes(pathname)){
   exactBody(body,['planId','planHash']);const state=await this.content.status(body.planId),profile=await this.store.get(state.plan.context.profileId);const jobId=this.job(profile,async(progress,signal)=>{const content=await this.content.apply(body.planId,body.planHash,{signal,reconcile:pathname.endsWith('/reconcile')});return {content,message:'Content operation '+content.status+'. Read exact source results, including Knowledge workflow state/publication; connector retrieval is unverified.'};});response={ok:true,jobId};
  }
  else if(req.method==='GET'&&pathname==='/api/content/status')response={ok:true,content:url.searchParams.has('planId')?await this.content.status(url.searchParams.get('planId')):await this.content.statusForProfile(url.searchParams.get('profileId'))};
  else if(req.method==='POST'&&pathname==='/api/knowledge/preview'){
   exactBody(body,['profileId','expectedRevision','recordId']);const profile=await this.store.get(body.profileId);const jobId=this.job(profile,async(progress,signal)=>{const publication=await this.knowledge.preview(profile.id,body.expectedRevision,body.recordId,{signal});return {publication,message:'Knowledge publication '+publication.status+'. The installed normal Publish action and exact source baseline were inspected; no publication is inferred from a Draft.'};});response={ok:true,jobId};
  }
  else if(req.method==='POST'&&pathname==='/api/knowledge/approve'){
   exactBody(body,['planId','planHash','confirmed']);const state=await this.knowledge.status(body.planId);this.assertIdle(state.plan.context.profileId);response={ok:true,publication:await this.knowledge.approve(body.planId,body.planHash,body.confirmed)};
  }
  else if(req.method==='POST'&&['/api/knowledge/apply','/api/knowledge/reconcile'].includes(pathname)){
   exactBody(body,['planId','planHash']);const state=await this.knowledge.status(body.planId),profile=await this.store.get(state.plan.context.profileId);const jobId=this.job(profile,async(progress,signal)=>{const publication=await this.knowledge.apply(body.planId,body.planHash,{signal,reconcile:pathname.endsWith('/reconcile')});return {publication,message:'Knowledge publication '+publication.status+'. Source workflow/review/guest-access controls remain enabled; connector readiness is unknown.'};});response={ok:true,jobId};
  }
  else if(req.method==='GET'&&pathname==='/api/knowledge/status')response={ok:true,publication:url.searchParams.has('planId')?await this.knowledge.status(url.searchParams.get('planId')):await this.knowledge.statusForProfile(url.searchParams.get('profileId'))};
  else if(req.method==='GET'&&/^\/api\/jobs\/[0-9a-f-]{36}$/.test(pathname)){const job=this.jobs.get(pathname.split('/').pop());if(!job)throw error('Job not found in this local session.','not_found',404);response={ok:true,job:this.publicJob(job)};}
  else if(req.method==='POST'&&/^\/api\/jobs\/[0-9a-f-]{36}\/cancel$/.test(pathname)){
   exactBody(body,[]);const job=this.jobs.get(pathname.split('/')[3]);if(!job)throw error('Job not found in this local session.','not_found',404);
   if(['running','waiting'].includes(job.status)){job.controller.abort();job.message='Cancelling the local action. Waiting for its owned helper to stop.';}
   response={ok:true,cancellationRequested:job.controller.signal.aborted};
  }
  else if(req.method==='POST'&&['/api/manual-people','/api/manual-people/remove'].includes(pathname)){
   const removing=pathname.endsWith('/remove');exactBody(body,removing?['profileId','expectedRevision','personId']:['profileId','expectedRevision','person']);
   const profile=await this.store.get(body.profileId);this.assertIdle(profile.id);
   if(profile.revision!==body.expectedRevision)throw error('The config changed. Reload before changing its people plan.','stale_profile',409);
   const next=removing?await this.store.removeManualPerson(profile,body.personId):await this.store.saveManualPerson(profile,body.person);
   response={ok:true,profile:await this.store.view(next,this.adapter),sourceWrites:false};
  }
  else if(req.method==='GET'&&pathname==='/api/export'){const p=await this.store.get(url.searchParams.get('profileId'));const {authCacheKey,...config}=p;response={ok:true,config,fileName:configFilename(p.name)};}
 else if(req.method==='GET'&&pathname==='/api/menu')response=await this.store.menu(this.adapter);
 else if(req.method==='GET'&&pathname==='/api/history')response={ok:true,runs:await this.store.history()};
 else throw error('This operation is not available in the current build.','not_implemented',404);
 this.json(res,200,response);
  if(response.stopping){setImmediate(()=>{const stop=this.onShutdown||(()=>this.close());Promise.resolve().then(stop).catch(()=>{console.error('Local Config Builder shutdown did not finish. Inspect owned process status before restarting.');});});}
 }
}
module.exports={ConfigServer,tokenMatches};

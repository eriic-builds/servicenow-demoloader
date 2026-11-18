'use strict';
const fs=require('node:fs/promises');
const path=require('node:path');
const {randomUUID}=require('node:crypto');
const {error,atomic,readJson}=require('./profiles.cjs');
const {digest,frozen}=require('./execution.cjs');
const {PeopleProvisioning}=require('./people.cjs');
const {normalizeHtml}=require('./content.cjs');
const SYSID=/^[0-9a-f]{32}$/;
const UUID=/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const now=()=>new Date().toISOString();
const bool=value=>value===true||value==='true';
function fail(message,code='publication_invalid'){return error(message,code,409);}
function rows(value,label){if(value?.outcome!=='readable'||value.truncated||!Array.isArray(value.rows))throw fail(label+' cannot be read completely. No publication is permitted.','publication_visibility');return value.rows;}
function preserved(article,expected){
 const normalVersionAdvance=expected.workflow_state==='draft'&&['published','review'].includes(article.workflow_state)&&typeof article.version==='string'&&Boolean(article.version);
 return article.sys_id===expected.sys_id&&article.number===expected.number&&article.short_description===expected.short_description&&normalizeHtml(article.text)===normalizeHtml(expected.text)&&article.author===expected.author&&article.kb_knowledge_base===expected.kb_knowledge_base&&article.kb_category===expected.kb_category&&bool(article.active)&&article.article_id===expected.article_id&&(article.version===expected.version||normalVersionAdvance);
}
class KnowledgePublication{
 constructor({store,adapter,pollDelayMs=1500,pollAttempts=30}){this.store=store;this.adapter=adapter;this.people=new PeopleProvisioning({store,adapter});this.directory=path.join(store.runtimeHome,'state','knowledge-publication');this.pollDelayMs=pollDelayMs;this.pollAttempts=pollAttempts;}
 file(id){if(!UUID.test(id||''))throw fail('Select a valid Knowledge publication preview.');return path.join(this.directory,id+'.json');}
 async load(id){const state=await readJson(this.file(id));if(!state)throw error('Publication preview not found.','not_found',404);if(state.plan?.id!==id||digest(state.plan)!==state.planHash||!['preview','approved','attempting','confirmed','review','blocked','uncertain','failed'].includes(state.status))throw fail('Stored publication authority is corrupt.','plan_corrupt');return state;}
 async persist(state){state.updatedAt=now();await atomic(this.file(state.plan.id),state);await atomic(path.join(this.directory,'latest-'+state.plan.context.profileId+'.json'),{planId:state.plan.id});await atomic(path.join(this.store.runDir,state.plan.id,'run.json'),{schemaVersion:1,runId:state.plan.id,profileId:state.plan.context.profileId,scenario:'knowledge.publish',status:state.status,createdAt:state.plan.createdAt,updatedAt:state.updatedAt,planHash:state.planHash,context:state.plan.context,sourceWrites:state.sourceWrites,steps:state.steps,result:state.result||null});return frozen(state);}
 async article(profile,recordId,{signal}={}){if(!SYSID.test(recordId||''))throw fail('Publication requires one exact Knowledge source ID.');const found=rows(await this.adapter.readBootstrap(profile,'knowledgePublication',{recordId},{signal}),'The exact Knowledge article');if(found.length!==1||found[0].sys_id!==recordId)throw fail('The exact article is missing or ambiguous.','publication_target');const article=found[0];for(const key of ['number','short_description','text','workflow_state','sys_mod_count'])if(typeof article[key]!=='string'||!article[key])throw fail('Publication source fields are missing or unreadable.','publication_target');for(const key of ['author','kb_knowledge_base','article_id'])if(!SYSID.test(article[key]||''))throw fail('Publication reference/lineage metadata is incomplete.','publication_target');if(!bool(article.active))throw fail('An inactive article is not automatically reactivated.','publication_target');return article;}
 async authority(profile,id,article,{signal}={}){
  const checked=await this.people.inspect(profile,id,[],{signal});
  if(checked.payload.blockers.length||checked.payload.operations.some(person=>person.kind!=='reuse'))throw fail('Verify all configured people and the Machine identity before publication.','publication_people');
  const author=checked.payload.operations.find(person=>person.sourceId===article.author);if(!author)throw fail('The article author is not an exact configured person.','publication_author');const grants=checked.observations.get(author.personId)?.grants||[];if(!checked.payload.authority.roles.some(role=>['knowledge','knowledge_admin'].includes(role.name)&&grants.some(grant=>grant.role===role.sysId)))throw fail('The author no longer has the planned Knowledge role.','publication_author');
  const bases=rows(await this.adapter.readBootstrap(profile,'knowledgeBases',{}, {signal}),'Knowledge bases'),base=bases.filter(base=>base.sys_id===article.kb_knowledge_base&&bool(base.active));if(base.length!==1)throw fail('The approved Knowledge base is not uniquely active.','publication_base');
  return {people:checked.payload,base:base[0]};
 }
 async assertNoUnresolved(profile,recordId){let names;try{names=await fs.readdir(this.directory);}catch(e){if(e.code==='ENOENT')return;throw e;}for(const name of names.filter(name=>name.endsWith('.json')&&UUID.test(name.slice(0,-5)))){const previous=await this.load(name.slice(0,-5));if(previous.plan.context.pdiUrl===profile.pdiUrl&&previous.plan.payload.article.sys_id===recordId&&previous.sourceWrites&&previous.status!=='confirmed')throw fail('Inspect/reconcile the existing publication attempt; a new preview cannot repeat it.','reconciliation_required');}}
 async preview(profileId,revision,recordId,{signal}={}){
  const profile=await this.store.get(profileId);if(profile.revision!==revision)throw fail('Config changed before publication discovery.','stale_profile');
  const input={recordId};return this.store.execute(this.store.makeContext(profile,'knowledge.publish',input),input,async current=>{
   await this.assertNoUnresolved(current,recordId);const id=randomUUID(),article=await this.article(current,recordId,{signal}),authority=await this.authority(current,id,article,{signal});
   if(!['draft','published'].includes(article.workflow_state))throw fail('This article is already in a lifecycle process or is not a publishable Draft. No workflow is bypassed.','publication_state');
   const action=article.workflow_state==='draft'?await this.adapter.discoverPublication(current,article,{signal}):null;
   if(action&&(action.actor?.userName!==current.adminUser||action.actor.authMethod!=='isolated-browser-session'||action.actor.impersonating!==false||action.articleId!==recordId||action.actionName!=='publish_knowledge'))throw fail('The normal authenticated publication action is not the expected one.','publication_actor');
   const payload={article,authority,action,notificationConsequences:'Invoke the installed Publish action once using normal separate admin login. Source publication workflows, review requirements, guest-access warnings and notifications remain enabled. No author, body, base, roles, ACLs or connector settings will be changed.'};
   const plan=frozen({schemaVersion:1,id,createdAt:now(),expiresAt:new Date(Date.now()+30*60*1000).toISOString(),context:this.store.makeContext(current,'knowledge.publish',payload,action?.actor||authority.people.actor),payload});
   const state={plan,planHash:digest(plan),status:article.workflow_state==='published'&&bool(article.latest)?'confirmed':'preview',approval:null,sourceWrites:false,steps:[],result:null};if(state.status==='confirmed')state.result=this.result(current,article);return this.persist(state);
  });
 }
 result(profile,article){return {sysId:article.sys_id,number:article.number,title:article.short_description,author:article.author,knowledgeBase:article.kb_knowledge_base,state:article.workflow_state,published:article.workflow_state==='published',latest:bool(article.latest),active:bool(article.active),version:article.version,articleId:article.article_id,auditUpdatedBy:article.sys_updated_by||null,bodySha256:digest(normalizeHtml(article.text)),sourceUrl:profile.pdiUrl+'/kb_knowledge.do?sys_id='+article.sys_id,connectorReadiness:'unknown'};}
 async approve(id,hash,confirmed){if(confirmed!==true)throw fail('Exact publication scope requires user approval.','approval_required');const saved=await this.load(id);return this.store.execute(saved.plan.context,saved.plan.payload,async()=>{const state=await this.load(id);if(state.planHash!==hash||state.status!=='preview'||!state.plan.payload.action||Date.parse(state.plan.expiresAt)<=Date.now())throw fail('Publication approval is stale or no normal action was established.','stale_plan');state.approval={planHash:hash,approvedAt:now()};state.status='approved';return this.persist(state);});}
 async apply(id,hash,{signal,reconcile=false}={}){
  const saved=await this.load(id);return this.store.execute(saved.plan.context,saved.plan.payload,async profile=>{
   const state=await this.load(id),plan=state.plan;if(hash!==state.planHash||state.approval?.planHash!==hash)throw fail('An exact approved publication preview is required.','approval_required');if(state.status==='confirmed')return frozen(state);
   if((!reconcile&&state.status!=='approved')||(reconcile&&!['attempting','uncertain','review'].includes(state.status)))throw fail('Reconcile this publication rather than submitting Publish again.','reconciliation_required');if(!reconcile&&Date.parse(plan.expiresAt)<=Date.now())throw fail('Publication approval expired.','stale_plan');
   const inspect=async()=>{const article=await this.article(profile,plan.payload.article.sys_id,{signal});if(!preserved(article,plan.payload.article))throw fail('Article identity, lineage, author, base or accepted body changed. Nothing is repaired automatically.','publication_changed');return article;};
   const finish=async article=>{if(article.workflow_state==='published'&&bool(article.latest)){state.status='confirmed';state.result=this.result(profile,article);state.steps.at(-1).status='confirmed';return this.persist(state);}if(article.workflow_state==='review'){state.status='review';state.result=this.result(profile,article);state.steps.at(-1).status='submitted-for-review';return this.persist(state);}return null;};
   try{
    let article=await inspect();if(reconcile){const completed=await finish(article);if(completed)return completed;state.status='uncertain';return this.persist(state);}
    if(article.workflow_state!=='draft'||digest(article)!==digest(plan.payload.article))throw fail('The Draft baseline changed after publication preview.','publication_changed');
    const authority=await this.authority(profile,plan.id,article,{signal});if(digest(authority)!==digest(plan.payload.authority))throw fail('Publication authority, author role or base changed after preview.','publication_changed');
    const response=await this.adapter.publishKnowledge(profile,article,plan.payload.action,{signal,beforeSubmit:async view=>{const current=await inspect();if(current.workflow_state!=='draft'||digest(current)!==digest(plan.payload.article)||digest(view)!==digest(plan.payload.action))throw fail('Source baseline or UI action changed before Publish.','publication_changed');state.status='attempting';state.sourceWrites=true;state.steps.push({name:'standard-publish',action:'publish_knowledge',actor:view.actor,status:'attempting',at:now()});await this.persist(state);}});
    if(!state.steps.length)throw fail('The publication adapter did not establish its durable attempt.','publication_protocol');
    state.sourceWrites=response.formSubmitted===true;
    if(response.outcome==='blocked'&&!response.formSubmitted){state.status='blocked';state.steps.at(-1).status='blocked';state.steps.at(-1).reason=response.reason||'normal-action-blocked';return this.persist(state);}
    state.status='uncertain';state.steps.at(-1).status='uncertain';state.steps.at(-1).formSubmitted=response.formSubmitted===true;await this.persist(state);
    for(let n=0;n<this.pollAttempts;n++){article=await inspect();const done=await finish(article);if(done)return done;if(!['draft','published'].includes(article.workflow_state))throw fail('The source lifecycle returned an unexpected state.','publication_state');if(n+1<this.pollAttempts)await new Promise(resolve=>setTimeout(resolve,this.pollDelayMs));}
    return this.persist(state);
   }catch(e){if(state.steps.some(step=>['attempting','uncertain'].includes(step.status))){state.status=e.formSubmitted===false?'blocked':'uncertain';state.sourceWrites=e.formSubmitted!==false;state.steps.at(-1).status=state.status;}else state.status='failed';state.failureCode=e.code||'publication_failed';await this.persist(state);throw fail('Knowledge publication stopped ('+state.failureCode+'). Inspect or reconcile the original attempt; do not repeat Publish blindly.',state.failureCode);}
  });
 }
 async status(id){return frozen(await this.load(id));}
 async statusForProfile(profileId){await this.store.get(profileId);const latest=await readJson(path.join(this.directory,'latest-'+profileId+'.json'));return latest?this.status(latest.planId):null;}
}
module.exports={KnowledgePublication,preserved};

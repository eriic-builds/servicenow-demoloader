'use strict';
const path=require('node:path');
const {randomUUID}=require('node:crypto');
const {ContentProvisioning,inputValue,owns}=require('./content.cjs');
const {operationId}=require('./people.cjs');
const {atomic,error}=require('./profiles.cjs');
const {digest,frozen}=require('./execution.cjs');
const pack=require('../packs/hr-knowledge.json');
const SYSID=/^[0-9a-f]{32}$/;
const isTrue=value=>value===true||value==='true';
const ordered=values=>[...values].sort((a,b)=>digest(a).localeCompare(digest(b)));
const fail=(message,code='pack_invalid')=>error(message,code,409);
function rows(value,label){if(value?.outcome!=='readable'||value.truncated||!Array.isArray(value.rows))throw fail(label+' is denied, truncated or unknown. Nothing is assumed absent.','pack_lookup_unknown');return value.rows;}
function candidates(profile){return (profile.manualPeople||[]).filter(person=>person.roleProfiles.some(role=>['knowledge-author','knowledge-manager'].includes(role)));}
function choose(profile,personId){const people=candidates(profile);const matches=personId?people.filter(person=>person.id===personId):people;if(matches.length!==1)throw fail(matches.length?'Choose one Knowledge author/manager from this config before preparing the pack.':'Add or select a configured Knowledge author/manager first; the pack never grants global roles.','pack_person_required');return matches[0];}
function recordMatches(row,fields,actor,article=false){if(article)return owns(row,{fields},actor);if(!row||row.sys_id!==fields.sys_id||row.sys_created_by!==actor.userName)return false;return Object.entries(fields).every(([key,value])=>typeof value==='boolean'?([true,false,'true','false'].includes(row[key])&&isTrue(row[key])===value):row[key]===value);}
class HRKnowledgePack extends ContentProvisioning{
 constructor(options){super(options);this.directory=path.join(this.store.runtimeHome,'state','knowledge-packs');}
 async persist(state){state.updatedAt=new Date().toISOString();await atomic(this.file(state.plan.id),state);await atomic(path.join(this.directory,'latest-'+state.plan.context.profileId+'.json'),{planId:state.plan.id});await atomic(path.join(this.store.runDir,state.plan.id,'run.json'),{schemaVersion:1,runId:state.plan.id,profileId:state.plan.context.profileId,scenario:'knowledge.pack.hr',status:state.status,createdAt:state.plan.createdAt,updatedAt:state.updatedAt,planHash:state.planHash,context:state.plan.context,packId:pack.id,person:state.plan.payload.person,steps:state.steps,results:state.results,sourceWrites:state.sourceWrites,access:'Exact configured person in owned read/contribute user criteria; no role or existing-base changes. Effective sign-in/connector retrieval is not verified.'});return frozen(state);}
 async inspect(profile,input,id,steps=[],{signal}={}){
  const person=choose(profile,input.personId),inspected=await this.people.inspect({...profile,manualPeople:[person]},id,[],{signal});
  const payload={packId:pack.id,packDigest:digest(pack),actor:inspected.payload.actor,person:null,authority:null,ids:{},operations:[],blockers:[...inspected.payload.blockers],notificationConsequences:'Normal ServiceNow business rules, audit and notifications may run. Creates a dedicated inactive HR base, exact-person read/contribute criteria and category, then activates it and creates two Published articles. No global user roles, existing bases, Microsoft accounts, connectors or existing article updates.'},observations=new Map();
  const block=(code,message)=>payload.blockers.push({code,message});
  if(payload.blockers.length)return {payload,observations};
  try{
   if(input.packDigest!==digest(pack))throw fail('The canned pack changed. Prepare a new reviewed plan.','pack_changed');
   const entry=inspected.payload.operations.find(op=>op.personId===person.id),observation=inspected.observations.get(person.id);
   if(entry?.kind!=='reuse'||!observation?.row)throw fail('The selected person must already exist with exact config email/login. Provision them separately first.','pack_person_missing');
   const role=inspected.payload.authority.roles.find(role=>['knowledge','knowledge_admin'].includes(role.name)&&observation.grants.some(grant=>grant.role===role.sysId));
   if(!role)throw fail('The selected person lacks their existing planned Knowledge role. No role is granted by a pack.','pack_person_role');
   payload.person={personId:person.id,displayName:person.displayName,sysId:observation.row.sys_id,userName:observation.row.user_name,email:observation.row.email.toLowerCase(),roleName:role.name,roleId:role.sysId};
   const dictionary=[...rows(await this.adapter.readBootstrap(profile,'packDictionary',{}, {signal}),'Pack schema'),...rows(await this.adapter.readBootstrap(profile,'contentDictionary',{}, {signal}),'Article schema')];
   const choices=rows(await this.adapter.readBootstrap(profile,'contentChoices',{}, {signal}),'Article workflow choices');
   payload.authority={people:inspected.payload, dictionary:ordered(dictionary),choices:ordered(choices)};
   const idFor=key=>operationId(id,key).replaceAll('-','');payload.ids={base:idFor('base'),criteria:idFor('criteria'),category:idFor('category'),read:idFor('read'),contribute:idFor('contribute')};
   const add=(key,table,fields,method='POST')=>payload.operations.push({key,table,method,operationId:operationId(id,key==='activate'?'base':key),fields:{sys_id:idFor(key==='activate'?'base':key),...fields}});
   add('base','kb_knowledge_base',{title:pack.base.title,description:pack.base.description,owner:payload.person.sysId,active:false});
   add('criteria','user_criteria',{name:pack.criteriaName,users:payload.person.sysId,groups:'',roles:'',companies:'',locations:'',departments:'',advanced:false,script:'',match_all:false,active:true});
   for(const [key,table]of [['read','kb_uc_can_read_mtom'],['contribute','kb_uc_can_contribute_mtom']])add(key,table,{kb_knowledge_base:payload.ids.base,user_criteria:payload.ids.criteria});
   add('category','kb_category',{label:pack.category.label,value:pack.category.value,parent_id:payload.ids.base,parent_table:'kb_knowledge_base',active:true});
   add('activate','kb_knowledge_base',{active:true},'PATCH');
   const published=choices.filter(row=>row.name==='kb_knowledge'&&row.element==='workflow_state'&&row.label==='Published'&&row.language==='en'&&[false,'false'].includes(row.inactive));
   if(published.length!==1||typeof published[0].value!=='string')throw fail('A unique installed Published workflow choice is required. No state is guessed.','pack_publication_choice');
   for(const article of pack.articles){const {publish,...value}=inputValue({businessKey:pack.id,knowledge:{short_description:article.short_description,text:article.text,author:payload.person.sysId,kb_knowledge_base:payload.ids.base,publish:true}}).knowledge;add(article.key,'kb_knowledge',{...value,kb_category:payload.ids.category,workflow_state:published[0].value,active:true});}
   const references={owner:'sys_user',author:'sys_user',kb_knowledge_base:'kb_knowledge_base',user_criteria:'user_criteria',kb_category:'kb_category'};
   for(const operation of payload.operations)for(const [key,value]of Object.entries(operation.fields)){
    if(key==='sys_id')continue;const found=dictionary.filter(row=>row.name===operation.table&&row.element===key);
    if(found.length!==1||!SYSID.test(found[0].sys_id||'')||![false,'false'].includes(found[0].read_only))throw fail('A unique writable '+operation.table+'.'+key+' field is required.','pack_schema');
    const meta=found[0],types=references[key]?['reference']:key==='users'||['groups','roles','companies','locations','departments'].includes(key)?['glide_list']:key==='parent_id'?['document_id','reference','string']:key==='parent_table'?['table_name','string']:typeof value==='boolean'?['boolean']:key==='text'?['html','translated_html']:key==='script'?['script','script_plain','string']:key==='workflow_state'?['workflow','string','choice']:['string','translated_text'];
    if(!types.includes(meta.internal_type)||(references[key]&&meta.reference!==references[key])||(key==='users'&&meta.reference!=='sys_user'))throw fail('Unsupported source type/reference for '+operation.table+'.'+key+'.','pack_schema');
    if(typeof value==='string'&&value.length&&(!/^\d+$/.test(String(meta.max_length))||value.length>Number(meta.max_length)))throw fail('Pack text exceeds the installed '+key+' length.','pack_schema');
   }
   const activation=steps.find(step=>step.key==='activate'),canBeActive=activation&&['attempting','uncertain','confirmed'].includes(activation.status);
   for(const operation of payload.operations.filter(op=>op.key!=='activate')){
    const options=operation.table==='kb_knowledge'?{table:operation.table,recordId:operation.fields.sys_id,title:operation.fields.short_description,baseId:payload.ids.base}:{table:operation.table,recordId:operation.fields.sys_id,title:operation.fields.title||operation.fields.name||operation.fields.label,baseId:payload.ids.base};
    const existing=rows(await this.adapter.readBootstrap(profile,operation.table==='kb_knowledge'?'contentLookup':'packLookup',options,{signal}),'Pack '+operation.key+' lookup');
    const step=steps.find(step=>step.key===operation.key),allowed=step&&['attempting','uncertain','confirmed'].includes(step.status);
    if(existing.length>1)throw fail('Pack '+operation.key+' has conflicting source matches. Existing HR records are not adopted.','pack_collision');
    const row=existing[0]||null,fields=operation.key==='base'&&canBeActive&&row&&isTrue(row.active)?{...operation.fields,active:true}:operation.fields;
    if(row&&(!allowed||!recordMatches(row,fields,payload.actor,operation.table==='kb_knowledge')))throw fail('Pack '+operation.key+' already exists or changed outside this approved run. No duplicate or repair is created.','pack_collision');
    if(!row&&step?.status==='confirmed')throw fail('An owned pack record disappeared. Do not recreate it.','pack_owned_missing');
    observations.set(operation.key,row);
   }
   observations.set('activate',observations.get('base'));
   for(const [key,table]of [['read','kb_uc_can_read_mtom'],['contribute','kb_uc_can_contribute_mtom'],['deny-read','kb_uc_cannot_read_mtom'],['deny-contribute','kb_uc_cannot_contribute_mtom']]){
    const links=rows(await this.adapter.readBootstrap(profile,'packRelations',{table,baseId:payload.ids.base},{signal}),'HR access relationships'),expected=payload.operations.find(op=>op.key===key),observed=observations.get(key);
    if(links.length!==(observed?1:0)||links.some(row=>!expected||!recordMatches(row,expected.fields,payload.actor)))throw fail('HR access criteria changed, are denied, or include an unapproved reader/contributor. No access is broadened or repaired.','pack_access_changed');
   }
  }catch(e){if(!e.status)throw e;block(e.code,e.message);}
  return {payload,observations};
 }
 async preview(profileId,revision,personId,{signal}={}){
  const profile=await this.store.get(profileId);if(profile.revision!==revision)throw fail('Config changed before pack preparation.','stale_profile');
  const person=choose(profile,personId),input=frozen({businessKey:pack.id,personId:person.id,packDigest:digest(pack)});
  return this.store.execute(this.store.makeContext(profile,'knowledge.pack',input),input,async current=>{
   await this.people.assertNoUnresolved(current);
   const contentStates=await new ContentProvisioning({store:this.store,adapter:this.adapter}).states();if(contentStates.some(state=>state.plan.context.pdiUrl===current.pdiUrl&&state.sourceWrites&&state.status!=='confirmed'))throw fail('Reconcile an earlier content write on this PDI before loading a pack.','reconciliation_required');
   const previous=(await this.states()).filter(state=>state.plan.context.pdiUrl===current.pdiUrl);
   const unresolved=previous.filter(state=>state.sourceWrites&&state.status!=='confirmed');
   if(unresolved.length){
    const resume=unresolved[0];
    if(unresolved.length!==1||resume.status!=='partial'||resume.steps.some(step=>['attempting','uncertain'].includes(step.status))||resume.plan.context.profileId!==profileId||digest(resume.plan.input)!==digest(input))throw fail('An earlier HR pack write needs read-only reconciliation. Do not start a replacement.','reconciliation_required');
    const checked=await this.inspect(current,input,resume.plan.id,resume.steps,{signal});
    if(checked.payload.blockers.length||digest(checked.payload)!==digest(resume.plan.payload)||digest(this.store.makeContext(current,'knowledge.pack',checked.payload,checked.payload.actor))!==digest(resume.plan.context))throw fail('The partial pack context or source changed; do not renew or replace its operation.','pack_changed');
    const plan=frozen({...resume.plan,expiresAt:new Date(Date.now()+30*60*1000).toISOString()});
    return this.persist({...resume,plan,planHash:digest(plan),approval:null,status:'partial'});
   }
   const completed=previous.find(state=>state.status==='confirmed'&&state.plan.input.businessKey===pack.id);
   if(completed){if(completed.plan.context.profileId!==profileId||digest(completed.plan.input)!==digest(input))throw fail('This PDI already has this HR pack for another config/person. Do not duplicate or reassign it.','pack_key_conflict');const checked=await this.inspect(current,input,completed.plan.id,completed.steps,{signal});if(checked.payload.blockers.length||digest(checked.payload)!==digest(completed.plan.payload))throw fail('Completed HR pack changed. Inspect it instead of creating duplicates.','pack_changed');return frozen(completed);}
   const id=randomUUID(),{payload}=await this.inspect(current,input,id,[],{signal});
   if(typeof this.adapter.knowledgePackOperation!=='function')payload.blockers.push({code:'pack_writer_missing',message:'The fixed pack adapter is unavailable.'});
   const plan=frozen({schemaVersion:1,id,createdAt:new Date().toISOString(),expiresAt:new Date(Date.now()+30*60*1000).toISOString(),context:this.store.makeContext(current,'knowledge.pack',payload,payload.actor),input,payload});
   return this.persist({plan,planHash:digest(plan),status:payload.blockers.length?'blocked':'preview',approval:null,sourceWrites:false,steps:[],results:[]});
  });
 }
 async apply(id,hash,{signal,reconcile=false}={}){
  const saved=await this.load(id);
  return this.store.execute(saved.plan.context,saved.plan.payload,async profile=>{
   const state=await this.load(id),plan=state.plan;
   if(hash!==state.planHash||state.approval?.planHash!==hash||plan.payload.blockers.length)throw fail('Review and explicitly approve this exact HR pack first.','approval_required');
   if((!reconcile&&!['approved','confirmed'].includes(state.status))||(reconcile&&!['attempting','uncertain','partial','confirmed'].includes(state.status)))throw fail('Inspect/reconcile existing attempts rather than repeating writes.','reconciliation_required');
   if(!reconcile&&state.status!=='confirmed'&&Date.parse(plan.expiresAt)<=Date.now())throw fail('Pack approval expired.','stale_plan');
   const fresh=async()=>{const result=await this.inspect(profile,plan.input,id,state.steps,{signal});if(result.payload.blockers.length||digest(result.payload)!==digest(plan.payload))throw fail('Source person, actor, schema, access or content changed after pack approval.','pack_changed');return result.observations;};
   const confirmed=(operation,row)=>{if(!row)return false;if(operation.key==='activate')return isTrue(row.active)&&recordMatches(row,{...plan.payload.operations[0].fields,active:true},plan.payload.actor);return recordMatches(row,operation.key==='base'&&isTrue(row.active)?{...operation.fields,active:true}:operation.fields,plan.payload.actor,operation.table==='kb_knowledge');};
   const receipt=(operation,row)=>{state.results=state.results.filter(value=>value.key!==operation.key);state.results.push({key:operation.key,table:operation.table,sysId:row.sys_id,title:row.short_description||row.title||row.label||row.name||null,number:row.number||null,state:operation.table==='kb_knowledge'?row.workflow_state:null,sourceUrl:profile.pdiUrl+'/'+operation.table+'.do?sys_id='+row.sys_id});};
   try{
    let observations=await fresh();
    if(state.status==='confirmed')return frozen(state);
    if(reconcile){for(const operation of plan.payload.operations){const step=state.steps.find(step=>step.key===operation.key),row=observations.get(operation.key);if(step&&['attempting','uncertain'].includes(step.status)&&confirmed(operation,row)){step.status='confirmed';receipt(operation,row);}}state.status=state.steps.some(step=>['attempting','uncertain'].includes(step.status))?'uncertain':state.steps.length===plan.payload.operations.length&&state.steps.every(step=>step.status==='confirmed')?'confirmed':'partial';return this.persist(state);}
    for(const operation of plan.payload.operations){
     let step=state.steps.find(step=>step.key===operation.key);if(step?.status==='confirmed')continue;
     if(step&&['attempting','uncertain'].includes(step.status))throw fail('An uncertain HR pack write must never be repeated.','reconciliation_required');
     if(signal?.aborted)throw fail('The pack was cancelled before the next write.','pack_cancelled');
     observations=await fresh();const row=observations.get(operation.key);
     if(operation.key==='activate'?!row||isTrue(row.active):Boolean(row))throw fail('A pack target changed before its write.','pack_collision');
     if(!step){step={key:operation.key,table:operation.table,method:operation.method};state.steps.push(step);}step.status='attempting';state.status='attempting';state.sourceWrites=true;await this.persist(state);
     const result=await this.adapter.knowledgePackOperation(profile,plan.payload.actor,operation,plan.payload.authority.people.authority.bootstrap.schema.machineChoice.value,{...plan.payload.person,humanChoice:plan.payload.authority.people.authority.humanChoice,ids:plan.payload.ids},{signal});
     if(result.outcome!=='created'||!confirmed(operation,result.row)){step.status=result.outcome==='rejected'?'rejected':'uncertain';state.status=step.status==='uncertain'?'uncertain':'partial';return this.persist(state);}
     // Keep the attempt uncertain until a separate exact source read confirms it.
     observations=await fresh();if(!confirmed(operation,observations.get(operation.key)))throw fail('The pack write was not confirmed by an exact source read-back.','pack_readback');
     step.status='confirmed';receipt(operation,observations.get(operation.key));await this.persist(state);
    }
    observations=await fresh();if(plan.payload.operations.some(operation=>!confirmed(operation,observations.get(operation.key))))throw fail('Final pack records do not match the approved content/access.','pack_readback');
    state.status='confirmed';return this.persist(state);
   }catch(e){for(const step of state.steps)if(step.status==='attempting')step.status='uncertain';state.status=state.steps.some(step=>step.status==='uncertain')?'uncertain':state.sourceWrites?'partial':'failed';state.failureCode=e.code||'pack_internal';await this.persist(state);throw fail('HR pack stopped ('+state.failureCode+'). Inspect its journal; do not create a replacement.',state.failureCode);}
  });
 }
}
module.exports={HRKnowledgePack,candidates,choose,recordMatches};

'use strict';
const {setTimeout:sleep}=require('node:timers/promises');
const {IsolatedAdminBrowser,actorState}=require('./browser.cjs');
const {error}=require('./profiles.cjs');
const {digest}=require('./execution.cjs');
const {normalizeHtml}=require('./content.cjs');
const SYSID=/^[0-9a-f]{32}$/;
function fail(message,code='PUBLICATION_BROWSER'){return error(message,code,409);}
class KnowledgePublicationBrowser extends IsolatedAdminBrowser{
 constructor({article,...options}){super(options);if(!SYSID.test(article?.sys_id||'')||typeof article.short_description!=='string'||typeof article.text!=='string'||!SYSID.test(article.author||'')||!SYSID.test(article.kb_knowledge_base||''))throw fail('Publication requires an exact source article baseline.');this.article=Object.freeze({...article});this.publishArmed=false;this.publishRequested=false;this.guestCheckRequested=false;this.formResponse=null;this.formRequests=new Set();}
 permits(request){
  let url;try{url=new URL(request.url);}catch{return false;}
  if(url.origin!==this.profile.pdiUrl||url.username||url.password||Object.keys(request.headers||{}).some(key=>/^(x-http-method-override|x-http-method|x-method-override)$/i.test(key)))return false;
  if(request.method==='GET'&&url.pathname==='/kb_knowledge.do'){
   const allowed=new Set(['sys_id','sysparm_view','sysparm_record_target','sysparm_record_row','sysparm_record_list','sysparm_stack','sysparm_clear_stack','sysparm_nostack']);
   return url.searchParams.get('sys_id')===this.article.sys_id&&[...url.searchParams.keys()].every(key=>allowed.has(key));
  }
  if(request.method==='POST'&&this.actor&&this.publishArmed){
   const body=new URLSearchParams(request.postData||'');
   if(url.pathname==='/xmlhttp.do'&&!this.guestCheckRequested&&body.get('sysparm_processor')==='AJAXXMLHttpAggregator'&&body.get('sysparm_aggregation_size')==='1'&&body.get('0.sysparm_processor')==='KBAjax'&&body.get('0.sysparm_type')==='checkGuestUserHasAccess'&&body.get('0.sysparm_id')===this.article.sys_id){
    const allowed=new Set(['sysparm_processor','sysparm_scope','sysparm_want_session_messages','sysparm_aggregation_size','sysparm_ck','ni.nolog.x_referer','x_referer','0.sysparm_processor','0.sysparm_scope','0.sysparm_want_session_messages','0.sysparm_type','0.sysparm_id','0.ni.nolog.x_referer','0.x_referer']);
    if([...body.keys()].some(key=>!allowed.has(key)))return false;
    this.guestCheckRequested=true;return true;
   }
   if(url.pathname==='/xmlhttp.do'&&!this.guestCheckRequested&&body.get('sysparm_processor')==='KBAjax'&&body.get('sysparm_type')==='checkGuestUserHasAccess'&&body.get('sysparm_id')===this.article.sys_id){
    const allowed=new Set(['sysparm_processor','sysparm_type','sysparm_id','sysparm_scope','sysparm_ck','sysparm_name','sysparm_transaction_scope']);
    if([...body.keys()].some(key=>!allowed.has(key))||body.get('sysparm_name'))return false;
    this.guestCheckRequested=true;return true;
   }
   if(url.pathname==='/kb_knowledge.do'&&!this.publishRequested&&body.get('sys_uniqueValue')===this.article.sys_id&&body.get('sys_action')==='publish_knowledge'){
    const expected={'kb_knowledge.short_description':this.article.short_description,'kb_knowledge.kb_knowledge_base':this.article.kb_knowledge_base,'kb_knowledge.author':this.article.author,'kb_knowledge.workflow_state':'draft'};
    if(Object.entries(expected).some(([field,value])=>body.has(field)&&body.get(field)!==value))return false;
    if(body.has('kb_knowledge.text')&&normalizeHtml(body.get('kb_knowledge.text'))!==normalizeHtml(this.article.text))return false;
    if(body.get('sysparm_sys_id')&&body.get('sysparm_sys_id')!==this.article.sys_id)return false;
    this.publishRequested=true;this.publishArmed=false;return true;
   }
  }
  return super.permits(request);
 }
 async start(){await super.start();this.cdp.on('Network.requestWillBeSent',params=>{const url=new URL(params.request.url);if(params.request.method==='POST'&&url.origin===this.profile.pdiUrl&&url.pathname==='/kb_knowledge.do')this.formRequests.add(params.requestId);if(params.redirectResponse&&this.formRequests.has(params.requestId))this.formResponse=params.redirectResponse.status;});this.cdp.on('Network.responseReceived',params=>{if(this.formRequests.has(params.requestId))this.formResponse=params.response.status;});return this;}
 async openArticle(){
  await this.navigate('/kb_knowledge.do?sys_id='+this.article.sys_id);
  for(let n=0;n<100;n++){
   let view;try{view=await this.view();}catch(e){if(e.code!=='BROWSER_NAVIGATING')throw e;await sleep(100);continue;}
   if(view.ready==='complete'&&view.recordId){
    if(JSON.stringify(actorState(view.actor,this.profile))!==JSON.stringify(this.actor))throw fail('Publication actor changed.','PUBLICATION_ACTOR');
    if(view.table!=='kb_knowledge'||view.recordId!==this.article.sys_id||view.title!==this.article.short_description||view.base!==this.article.kb_knowledge_base||view.workflowState!=='draft'||view.modified!==false)throw fail('The publication form differs from the approved Draft.','PUBLICATION_TARGET');
    if(view.authorPresent&&view.author!==this.article.author)throw fail('The form author differs from the approved source author.','PUBLICATION_TARGET');
    if(view.textPresent&&normalizeHtml(view.text)!==normalizeHtml(this.article.text))throw fail('The form body differs from the approved source text.','PUBLICATION_TARGET');
    if(!view.publishButton||view.publishDisabled||!view.actionCode||!view.onclick)throw fail('The normal Publish UI action is unavailable.','PUBLICATION_ACTION_MISSING');
    return {actor:this.actor,actionName:'publish_knowledge',actionHash:digest([view.actionCode,view.onclick]),articleId:view.recordId,title:view.title,base:view.base,workflowState:view.workflowState};
   }
   await sleep(200);
  }
  throw fail('The exact Knowledge form did not load.','PUBLICATION_FORM_TIMEOUT');
 }
 view(){return this.evaluate(`(()=>{const f=typeof g_form!=='undefined'?g_form:null,user=window.NOW?.user,b=document.getElementById('publish_knowledge');return {ready:document.readyState,table:f?.getTableName(),recordId:f?.getUniqueValue(),title:f?.getValue('short_description'),base:f?.getValue('kb_knowledge_base'),workflowState:f?.getValue('workflow_state'),modified:typeof f?.isModified==='function'?f.isModified():typeof f?.modified==='boolean'?f.modified:null,authorPresent:Boolean(f?.getElement('author')),author:f?.getValue('author'),textPresent:Boolean(f?.getElement('text')),text:f?.getElement('text')?f.getValue('text'):null,publishButton:Boolean(b),publishDisabled:b?.disabled??true,onclick:b?.getAttribute('onclick')||null,actionCode:typeof onPublishActionClicked==='function'?onPublishActionClicked.toString():null,actor:{origin:location.origin,actorId:user?.userID||null,actorName:user?.name||null,impersonating:user?.isImpersonating??null,hasToken:typeof window.g_ck==='string'&&Boolean(window.g_ck)}};})()`);}
 async publish(expected){
  const current=await this.openArticle();if(digest(current)!==digest(expected))throw fail('The normal publication action or actor changed after preview.','PUBLICATION_CHANGED');
  this.publishArmed=true;
  try{
   const clicked=await this.evaluate(`(()=>{if(typeof g_form==='undefined')return false;const modified=typeof g_form.isModified==='function'?g_form.isModified():typeof g_form.modified==='boolean'?g_form.modified:null;if(g_form.getUniqueValue()!==${JSON.stringify(this.article.sys_id)}||g_form.getValue('workflow_state')!=='draft'||modified!==false)return false;const b=document.getElementById('publish_knowledge');if(!b||b.disabled)return false;b.click();return true;})()`);
   if(!clicked)throw fail('Publish could not be invoked on the exact unchanged Draft.','PUBLICATION_TARGET');
   const deadline=Date.now()+30000;
   while(Date.now()<deadline){this.check();if(this.publishRequested&&this.formResponse!==null)return {outcome:'submitted',actionName:'publish_knowledge',responseStatus:this.formResponse,formSubmitted:true};if(!this.publishRequested){const modal=await this.evaluate(`(()=>{const dialogs=Array.from(document.querySelectorAll('[role="dialog"],.modal.in,.glide_modal'));return dialogs.some(e=>e.getClientRects().length&&/guest|public|unauthenticated/i.test(e.innerText||''));})()`);if(modal)return {outcome:'blocked',reason:'guest-access-review-required',formSubmitted:false};}await sleep(250);}
   return {outcome:this.publishRequested?'uncertain':'blocked',reason:this.publishRequested?'form-response-unconfirmed':'normal-action-did-not-submit',formSubmitted:this.publishRequested};
  }catch(e){e.formSubmitted=this.publishRequested;throw e;}finally{this.publishArmed=false;}
 }
}
module.exports={KnowledgePublicationBrowser};

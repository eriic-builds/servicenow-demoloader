'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
const {IsolatedAdminBrowser,connectCdp}=require('../lib/browser.cjs');
const {ProfileStore}=require('../lib/profiles.cjs'),{ConfigServer}=require('../lib/server.cjs');
const {createHash}=require('node:crypto');
const spec=require('../prerequisites.json'),root=path.resolve(__dirname,'..');
const roles=['admin','itil_admin','knowledge_admin','user_admin'];
const htmlPath=path.join(root,'PREREQUISITES.html');
test('offline beginner guide matches exact supplied Machine fields and all four role names',async()=>{
 const html=await fs.readFile(htmlPath,'utf8');assert.equal(spec.machineUserName,'demo.seeder');assert.equal(spec.identityType,'Machine');assert.equal(spec.active,true);assert.equal(spec.webServiceAccessOnly,true);assert.equal(spec.lockedOut,false);assert.equal(spec.passwordNeedsReset,false);assert.deepEqual(spec.requiredSetupRoles,roles);assert.equal(spec.acknowledgementIsVerification,false);
 for(const role of roles)assert.ok(html.includes('data-required-role="'+role+'"'),role);
 for(const content of ['Set Password','Password needs reset','Web service access only','Locked out','Identity type','Available','Selected','Save','Update','Use existing account','Existing Machine account (recommended)','Machine account password','Test read access','No account is created','not a connection test','not a production or least-privilege'])assert.ok(html.includes(content),content);
 assert.equal((html.match(/<input\s+type="checkbox"\s+data-check=/g)||[]).length,8);assert.ok(!/type=["']password["']/i.test(html));assert.equal((html.match(/<figure class="reference-picture"><img\b/g)||[]).length,5);
 const imageHashes={'users-new-image':'2011a9e520ad005872a694631d2a67592f95604520bf2a22a5c38b1a0c757eee','machine-reference-image':'ff04c7957a710f2a2c036a469f23382a97edec63351b50b8908e91968fbbda92','roles-edit-image':'a58b7cc14bd77fdcdbc969931d8e55f355d874c8e99087bb393722c1c216acf4','roles-move-image':'b1bd64953f52791f636745e027bffe2fb23cf3f482b2ad8c88a61adc55ed67ec','roles-reference-image':'2c892a886ee56692b3b3c0aad5e1bd3cac3dea9f1f0decad029c6538234b8384'};
 for(const [id,expected]of Object.entries(imageHashes)){const match=html.match(new RegExp('<img id="'+id+'"[^>]*src="data:image/png;base64,([^"]+)"'));assert.ok(match,id);const bytes=Buffer.from(match[1],'base64');assert.equal(createHash('sha256').update(bytes).digest('hex'),expected,id);const chunks=[];for(let offset=8;offset<bytes.length;){const length=bytes.readUInt32BE(offset);chunks.push(bytes.toString('ascii',offset+4,offset+8));offset+=length+12;}assert.deepEqual(chunks,['IHDR','PLTE','IDAT','IEND']);}
 assert.ok(!/<(?:script|iframe)\b[^>]*\bsrc\s*=|<link\b[^>]*href\s*=|\bfetch\s*\(|XMLHttpRequest|new\s+WebSocket|localStorage|sessionStorage|document\.cookie|indexedDB|window\.open\s*\(/i.test(html));
 assert.ok(html.includes('<meta charset="UTF-8">'));assert.ok(html.includes('id="readiness-summary"'));assert.ok(html.includes('prefers-reduced-motion'));assert.ok(html.includes('@media print'));
 assert.ok(!/(?:dev(?!123456\.|12345\.|123\.)\d{6,}\.service-now\.com|(?:m365cpi|diax)\d{6,}\.onmicrosoft\.com|C:\\Users\\)/i.test(html));
 const ids=[...html.matchAll(/\bid="([^"]+)"/g)].map(match=>match[1]);assert.equal(ids.length,new Set(ids).size);for(const match of html.matchAll(/href="#([^"]+)"/g))assert.ok(ids.includes(match[1]),match[1]);
 const withoutScripts=html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi,'');for(const instruction of ['Create <code>demo.seeder</code>','Add these four roles','Test read access','Use existing account'])assert.ok(withoutScripts.includes(instruction));
});
test('guide stays succinct, illustrates exact clicks and explains API-only login and later password use',async()=>{
 const html=await fs.readFile(htmlPath,'utf8'),plain=html.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>|<[^>]+>/gi,' ');assert.ok((plain.match(/\b[\w-]+\b/g)||[]).length<=1400,'Keep the full guide, including optional help, under 1400 words.');
 const section=id=>html.match(new RegExp('<section[^>]*id="'+id+'"[^>]*>([\\s\\S]*?)</section>'))[1];
 assert.ok(section('account').includes('id="users-new-image"'));assert.ok(section('account').indexOf('id="users-new-image"')<section('account').indexOf('id="machine-reference-image"'));
 assert.ok(section('roles').indexOf('id="roles-edit-image"')<section('roles').indexOf('id="roles-move-image"'));assert.ok(section('roles').includes('right arrow &gt;'));assert.ok(section('roles').includes('Collection / Available'));assert.ok(section('roles').includes('Roles List / Selected'));
 assert.ok(section('password').includes('A person cannot log in as demo.seeder through the interactive UI.'));assert.ok(section('password').includes('headless API calls'));assert.ok(section('password').includes('password manager'));assert.ok(section('password').includes('same password in the config later'));assert.ok(section('install').includes('password you saved in step 4'));
});
test('guide uses the Config Builder light palette, typography and neutral controls',async()=>{
 const guide=await fs.readFile(htmlPath,'utf8'),config=await fs.readFile(path.join(root,'config-builder.html'),'utf8');
 const properties=text=>Object.fromEntries([...text.match(/html\[data-theme="light"\]\s*\{([\s\S]*?)\}/)[1].matchAll(/(--cp-[a-z-]+):\s*([^;]+);/g)].map(match=>[match[1],match[2].trim()]));
 const source=properties(config),target=properties(guide);for(const token of ['--cp-text','--cp-text-muted','--cp-accent','--cp-accent-hover','--cp-accent-soft','--cp-accent-fg','--cp-link','--cp-brand','--cp-input-pending','--cp-input-pending-border','--cp-template-ink','--cp-template-neutral'])assert.equal(target[token],source[token],token);
 assert.ok(guide.includes('document.documentElement.setAttribute("data-theme", "light")'));assert.ok(guide.includes('class="masthead"'));assert.ok(guide.includes('class="brand-title"'));
 const sections=[...guide.matchAll(/<section class="part" id="([^"]+)"/g)].map(match=>match[1]);
 const nav=guide.match(/<nav\b[^>]*id="guide-nav"[^>]*>([\s\S]*?)<\/nav>/)[1];
 assert.deepEqual([...nav.matchAll(/href="#([^"]+)"/g)].map(match=>match[1]),sections);
 assert.equal(nav.match(/<img class="service-mark"[^>]*src="(data:image\/png;base64,[^"]+)"/)[1],config.match(/<template id="servicenow-logo"><img[^>]*src="(data:image\/png;base64,[^"]+)"/)[1]);
});
test('README and both installer routes put prerequisites before installation without claiming remote verification',async()=>{
 const readme=await fs.readFile(path.join(root,'README.md'),'utf8'),instructions=await fs.readFile(path.join(root,'INSTALL.txt'),'utf8'),bootstrap=await fs.readFile(path.join(root,'scripts','install-launcher.cmd'),'utf8'),installer=await fs.readFile(path.join(root,'scripts','install.ps1'),'utf8');
 for(const text of [readme,instructions,bootstrap]){assert.ok(text.includes('PREREQUISITES.html'));for(const role of roles)assert.ok(text.includes(role),role);}
 const guide=await fs.readFile(htmlPath,'utf8'),messages=[...bootstrap.matchAll(/Write-Host '([^']*)'/g)].map(match=>match[1]).join('\n');
 for(const text of [readme,instructions,guide,messages])assert.doesNotMatch(text,/\b(?:SHA256|checksum|Get-FileHash)\b/i);
 assert.ok(readme.indexOf('do this before installing')<readme.indexOf('## Install:'));assert.ok(bootstrap.indexOf('Type GUIDE')<bootstrap.indexOf('Type TRUST'));assert.ok(bootstrap.includes('@@PREREQUISITES_SHA256@@'));assert.ok(bootstrap.includes("$action -eq 'Prerequisites'"));
 assert.ok(installer.includes('if(-not $PrerequisitesConfirmed)'));assert.ok(installer.includes("source='operator-acknowledgement-only';verified=$false"));assert.ok(!/Set-ExecutionPolicy|ExecutionPolicy\s+Bypass/i.test(bootstrap));
 const build=await fs.readFile(path.join(root,'scripts','build-release.ps1'),'utf8');assert.ok(build.includes('PREREQUISITES.html'));
 const manifest=require('../package-files.json');assert.ok(manifest.runtime.includes('PREREQUISITES.html'));assert.ok(manifest.runtime.includes('prerequisites.json'));assert.ok(manifest.sourceOnly.includes('README.md'));
});
test('local server serves only the allowlisted offline guide with no-store and normal CSP',async t=>{
 const temp=await fs.mkdtemp(path.join(os.tmpdir(),'sn-guide-server-'));const store=new ProfileStore({outputRoot:path.join(temp,'output'),runtimeHome:path.join(temp,'runtime')}),server=new ConfigServer({store,adapter:{},projectRoot:root});
 await server.start();t.after(async()=>{await server.close();await fs.rm(temp,{recursive:true,force:true});});const response=await fetch(server.origin+'/PREREQUISITES.html');assert.equal(response.status,200);assert.equal(response.headers.get('cache-control'),'no-store');assert.ok(response.headers.get('content-security-policy').includes("default-src 'none'"));assert.equal(await response.text(),await fs.readFile(htmlPath,'utf8'));assert.equal((await fetch(server.origin+'/prerequisites.json')).status,404);
});
test('real Edge renders pictures, the safe PDI shortcut, and the curved reference and guided modes',{skip:process.platform!=='win32'},async t=>{
 const temp=await fs.mkdtemp(path.join(os.tmpdir(),'sn-guide-browser-')),html=await fs.readFile(htmlPath,'utf8'),requests=new Map();let blocked=0;
 const browser=new IsolatedAdminBrowser({runtimeHome:temp,profile:{pdiUrl:'https://dev123.service-now.com',adminUser:'admin'},connectImpl:async url=>{
  const transport=await connectCdp(url);
  return {close:()=>transport.close(),on(method,callback){transport.on(method,params=>{if(method==='Fetch.requestPaused')requests.set(params.requestId,params.request);callback(params);});},async send(method,params={},sessionId){
   if(method==='Fetch.failRequest'){blocked++;return transport.send(method,params,sessionId);}
   if(method!=='Fetch.continueRequest')return transport.send(method,params,sessionId);
   const request=requests.get(params.requestId),location=new URL(request.url);assert.equal(location.origin,'https://dev123.service-now.com');assert.equal(request.method,'GET');const page=location.pathname==='/login.do';assert.ok(page||location.pathname.endsWith('.ico'));
   return transport.send('Fetch.fulfillRequest',{requestId:params.requestId,responseCode:page?200:204,responseHeaders:[{name:'Content-Type',value:'text/html; charset=utf-8'}],body:page?Buffer.from(html).toString('base64'):''});
  }};
 }});
 t.after(async()=>{await browser.close();await fs.rm(temp,{recursive:true,force:true,maxRetries:10,retryDelay:100});});await browser.start();
 const evaluate=async expression=>{const result=await browser.cdp.send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});assert.ok(!result.exceptionDetails,JSON.stringify(result.exceptionDetails));return result.result.value;};
 for(const theme of ['light','dark']){
  await browser.cdp.send('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:false});await browser.cdp.send('Page.navigate',{url:'https://dev123.service-now.com/login.do?scoutTheme='+theme});
  const deadline=Date.now()+10000;while(!await evaluate("document.documentElement.dataset.guideReady==='true'")){if(Date.now()>deadline)throw new Error('Prerequisite guide did not initialize.');await new Promise(resolve=>setTimeout(resolve,25));}
  const initial=await evaluate("({theme:document.documentElement.dataset.theme,checks:document.querySelectorAll('input[data-check]').length,overflow:document.documentElement.scrollWidth>innerWidth,progress:document.getElementById('guide-progress').value,field:document.getElementById('guide-pdi-url').value,link:document.getElementById('open-users-table').getAttribute('href'),fontSize:getComputedStyle(document.body).fontSize,accent:getComputedStyle(document.documentElement).getPropertyValue('--cp-accent').trim(),brand:getComputedStyle(document.documentElement).getPropertyValue('--cp-brand').trim()})");assert.equal(initial.theme,'light');assert.equal(initial.checks,8);assert.equal(initial.overflow,false);assert.equal(initial.progress,0);assert.equal(initial.field,'');assert.equal(initial.link,null);assert.equal(initial.fontSize,'15px');assert.equal(initial.accent,'#1a1a1a');assert.equal(initial.brand,'#24566a');
  const imageDimensions=await evaluate("Promise.all(Array.from(document.querySelectorAll('.reference-picture img')).map(async image=>{await image.decode();return [image.naturalWidth,image.naturalHeight]}))");assert.deepEqual(imageDimensions,[[396,128],[590,588],[739,160],[950,520],[455,161]]);
  const sourceRequests=()=>[...requests.values()].filter(request=>new URL(request.url).pathname!=='/favicon.ico').length;
  const requestCount=sourceRequests();
  for(const [value,expected]of [['https://dev123.service-now.com','https://dev123.service-now.com/sys_user_list.do'],['dev123.service-now.com','https://dev123.service-now.com/sys_user_list.do'],[' HTTPS://DEV123.SERVICE-NOW.COM/ ','https://dev123.service-now.com/sys_user_list.do'],['https://dev123.service-now.com@evil.example',null],['https://user:password@dev123.service-now.com',null],['javascript:alert(1)',null],['https://dev123.service-now.com:8443',null],['https://dev123.service-now.com/sys_user_list.do',null],['https://dev123.service-now.com?next=evil',null],['https://production.service-now.com',null],['http://dev123.service-now.com',null],['https://dev123.service-now.com.evil.example',null],['https://dev123.service-now.com/#secret',null],['',null]]){
   const state=await evaluate("(()=>{const input=document.getElementById('guide-pdi-url'),link=document.getElementById('open-users-table');input.value="+JSON.stringify(value)+";input.dispatchEvent(new Event('input',{bubbles:true}));return {href:link.getAttribute('href'),disabled:link.getAttribute('aria-disabled'),status:document.getElementById('users-link-status').textContent,target:link.target,rel:link.rel};})()");assert.equal(state.href,expected,value);assert.equal(state.disabled,expected?'false':'true');if(expected){assert.equal(state.status,expected);assert.equal(state.target,'_blank');assert.ok(state.rel.includes('noopener'));assert.ok(state.rel.includes('noreferrer'));}
  }
  assert.equal(sourceRequests(),requestCount,'Editing the PDI field must not make requests or navigate; ignore the browser-owned favicon arriving after page load.');
  const completed=await evaluate("(()=>{document.querySelectorAll('input[data-check]').forEach(x=>{x.checked=true;x.dispatchEvent(new Event('change',{bubbles:true}));});return {progress:document.getElementById('guide-progress').value,title:document.getElementById('readiness-title').textContent,text:document.getElementById('readiness-text').textContent};})()");assert.equal(completed.progress,8);assert.ok(completed.title.includes('checklist is complete'));assert.ok(completed.text.includes('not a connection test'));
  const reset=await evaluate("(()=>{const input=document.getElementById('guide-pdi-url');input.value='dev123.service-now.com';input.dispatchEvent(new Event('input',{bubbles:true}));document.getElementById('reset-checks').click();return {progress:document.getElementById('guide-progress').value,value:input.value,href:document.getElementById('open-users-table').getAttribute('href')};})()");assert.deepEqual(reset,{progress:0,value:'',href:null});
  await browser.cdp.send('Emulation.setDeviceMetricsOverride',{width:1366,height:900,deviceScaleFactor:1,mobile:false});assert.equal(await evaluate('document.documentElement.scrollWidth>innerWidth'),false);
  if(process.env.SN_GUIDE_SCREENSHOT_DIR&&theme==='light'){await fs.mkdir(process.env.SN_GUIDE_SCREENSHOT_DIR,{recursive:true});for(const id of ['account','password','roles']){await evaluate("document.getElementById("+JSON.stringify(id)+").scrollIntoView({behavior:'instant'})");const picture=await browser.cdp.send('Page.captureScreenshot',{format:'png'});await fs.writeFile(path.join(process.env.SN_GUIDE_SCREENSHOT_DIR,'prerequisite-'+id+'-concise.png'),Buffer.from(picture.data,'base64'));}}
 }
 const until=async expression=>{
  const deadline=Date.now()+5000;while(!await evaluate(expression)){if(Date.now()>deadline)assert.fail(`Timed out: ${expression}`);await new Promise(resolve=>setTimeout(resolve,25));}
 };
 const active=()=>evaluate(`({links:[...document.querySelectorAll('#guide-nav a[aria-current="location"]')].map(a=>a.hash),groups:document.querySelectorAll('.rail-group[data-active]').length,drawn:document.querySelectorAll('.rail-group[data-traced]').length})`);
 const pick=id=>evaluate(`document.querySelector('#guide-nav a[href="#${id}"]').click()`);
 await browser.cdp.send('Page.navigate',{url:'https://dev123.service-now.com/login.do?scoutTheme=light&deep=1#roles'});
 await until(`location.search.includes('deep=1') && document.querySelector('.rail-group[data-traced] a[href="#roles"][aria-current]') !== null`);
 assert.deepEqual(await active(),{links:['#roles'],groups:1,drawn:1});
 assert.equal(await evaluate(`getComputedStyle(document.getElementById('guide-rail')).position`),'sticky');
 const logoFilter=()=>evaluate(`getComputedStyle(document.querySelector('.service-mark')).filter`);
 assert.equal(await logoFilter(),'none');

 // Keyboard navigation focuses the chosen heading. Scroll tracking does not.
 await evaluate(`document.querySelector('#guide-nav a[href="#before"]').focus()`);
 await browser.cdp.send('Input.dispatchKeyEvent',{type:'rawKeyDown',key:'Enter',code:'Enter',windowsVirtualKeyCode:13});
 await browser.cdp.send('Input.dispatchKeyEvent',{type:'keyUp',key:'Enter',code:'Enter',windowsVirtualKeyCode:13});
 await until(`location.hash==='#before' && document.activeElement.id==='before-title'`);
 assert.equal(await logoFilter(),'grayscale(1)');
 await evaluate(`scrollBy(0,document.getElementById('review-title').getBoundingClientRect().top-80)`);
 await until(`document.querySelector('#guide-nav a[aria-current]').hash==='#review'`);
 assert.equal(await evaluate('document.activeElement.id'),'before-title');
 await evaluate('scrollTo(0, document.documentElement.scrollHeight)');
 await until(`document.querySelector('#guide-nav a[aria-current]').hash==='#troubleshooting'`);

 await pick('account');
 await until(`document.querySelector('.rail-group[data-traced] a[href="#account"][aria-current]') !== null`);
 const timing=await evaluate(`(()=>{const group=document.querySelector('[data-traced]'),stroke=group.querySelector('.rail-trace').getAnimations()[0],dot=group.querySelector('.rail-dot').getAnimations()[0];window.previousTrace=stroke;window.previousDot=dot;return {duration:stroke.effect.getTiming().duration,delay:dot.effect.getTiming().delay};})()`);
 assert.equal(timing.delay,timing.duration);assert.ok(timing.duration>=270&&timing.duration<=540);
 await pick('password');
 await until(`document.querySelector('.rail-group[data-traced] a[href="#password"][aria-current]') !== null`);
 assert.equal(await evaluate(`previousTrace.playState==='idle' && previousDot.playState==='idle'`),true);
 assert.deepEqual(await active(),{links:['#password'],groups:1,drawn:1});

 const aligned=`(()=>{const group=document.querySelector('[data-traced]'),current=group?.querySelector('a[aria-current]');if(!current)return false;const row=current.getBoundingClientRect(),track=group.querySelector('.rail-track').getBoundingClientRect(),y=Number(group.querySelector('.rail-dot').getAttribute('cy'));return Math.abs(row.top+row.height/2-track.top-y)<1;})()`;
 await pick('account');
 await until(`document.querySelector('.rail-group[data-traced] a[href="#account"][aria-current]') !== null`);
 assert.equal(await evaluate(aligned),true);
 await evaluate(`window.railHeight=document.querySelector('a[aria-current]').offsetHeight;document.getElementById('guide-rail').style.width='135px'`);
 await until(`document.querySelector('a[aria-current]').offsetHeight>railHeight && ${aligned}`);
 await evaluate(`document.getElementById('guide-rail').style.removeProperty('width')`);
 await browser.cdp.send('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});
 await until(`matchMedia('(prefers-reduced-motion: reduce)').matches`);
 await pick('review');
 await until(`document.querySelector('.rail-group[data-traced] a[href="#review"][aria-current]') !== null`);
 assert.equal(await evaluate(`document.querySelector('[data-traced] .rail-track').getAnimations({subtree:true}).length`),0);

 await browser.cdp.send('Emulation.setDeviceMetricsOverride',{width:1040,height:460,deviceScaleFactor:1,mobile:false});
 await until(`getComputedStyle(document.getElementById('guide-rail')).position==='static'`);
 await browser.cdp.send('Emulation.setDeviceMetricsOverride',{width:768,height:900,deviceScaleFactor:1,mobile:false});
 await until(`!document.getElementById('guide-contents').open`);
 assert.equal(await evaluate('document.documentElement.scrollWidth>innerWidth'),false);
 await evaluate(`document.querySelector('#guide-contents > summary').click()`);
 await until(`document.getElementById('guide-contents').open && ${aligned}`);

 await evaluate(`document.getElementById('guide-mode').click()`);
 const visible=()=>evaluate(`Array.from(document.querySelectorAll('.part:not([hidden])'),task=>task.id)`);
 assert.deepEqual(await visible(),['before']);
 assert.equal(await evaluate(`document.getElementById('walk-back').disabled`),true);
 await evaluate(`document.getElementById('walk-next').click()`);
 assert.deepEqual(await visible(),['pdi']);
 assert.equal(await evaluate(`document.getElementById('guide-progress').value`),0);
 await evaluate(`document.getElementById('walk-back').click()`);
 assert.deepEqual(await visible(),['before']);
 await pick('account');
 assert.deepEqual(await visible(),['account']);
 assert.equal(await evaluate(`document.activeElement.id`),'account-title');
 const copied=await evaluate(`(async()=>{const copy=document.getElementById('copy-machine-id'),status=document.getElementById('copy-status');let value;Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async text=>{value=text}}});copy.click();await Promise.resolve();return {value,text:copy.textContent,status:status.textContent};})()`);
 assert.deepEqual(copied,{value:'demo.seeder',text:'Copied',status:'Copied. Paste into User ID.'});
 await evaluate(`(async()=>{const copy=document.getElementById('copy-machine-id');navigator.clipboard.writeText=async()=>{throw new Error('denied')};copy.click();await Promise.resolve();})()`);
 assert.match(await evaluate(`document.getElementById('copy-status').textContent`),/Select and copy the User ID/);
 await evaluate(`document.querySelector('#account input[data-check]').click()`);
 await pick('install');
 assert.deepEqual(await visible(),['install']);

 await browser.cdp.send('Emulation.setEmulatedMedia',{media:'print'});
 assert.equal(await evaluate(`Array.from(document.querySelectorAll('.part')).every(task=>getComputedStyle(task).display==='block')`),true);
 assert.equal(await evaluate(`getComputedStyle(document.getElementById('walk-controls')).display`),'none');
 await browser.cdp.send('Emulation.setEmulatedMedia',{media:''});
 await evaluate(`document.getElementById('walk-next').click()`);
 assert.equal((await visible()).length,9);
 assert.equal(await evaluate(`document.getElementById('guide-progress').value`),1);
 assert.equal(await evaluate(`document.activeElement.id`),'install-title');
 await evaluate('history.back()');
 await until(`document.documentElement.dataset.guideMode==='guided'`);
 assert.deepEqual(await visible(),['install']);

 // A real emulated phone tap plays the in-flow route before leaving Contents.
 await browser.cdp.send('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'no-preference'}]});
 await browser.cdp.send('Emulation.setDeviceMetricsOverride',{width:390,height:700,deviceScaleFactor:1,mobile:true});
 await browser.cdp.send('Emulation.setTouchEmulationEnabled',{enabled:true,maxTouchPoints:1});
 await browser.cdp.send('Page.navigate',{url:'https://dev123.service-now.com/login.do?phone=1#before'});
 await until(`location.search.includes('phone=1') && document.querySelector('#guide-nav a[aria-current]')?.hash==='#before' && !document.getElementById('guide-contents').open`);
 const tap=async selector=>{
  const [x,y]=await evaluate(`(()=>{const target=document.querySelector(${JSON.stringify(selector)});target.scrollIntoView({block:'center'});const r=target.getBoundingClientRect();return [Math.round(r.left+r.width/2),Math.round(r.top+r.height/2)];})()`);
  await browser.cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x,y}]});
  await browser.cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
 };
 const open=`document.getElementById('guide-contents').open`;
 await tap('#guide-contents > summary');
 await until(`${open} && ${aligned}`);
 assert.equal(await logoFilter(),'grayscale(1)');
 assert.equal(await evaluate(`document.querySelector('.service-mark').naturalWidth`),32);
 assert.ok(await evaluate(`document.querySelector('#guide-nav a[href="#roles"]').offsetHeight>=44`));
 await tap('#guide-nav a[href="#roles"]');
 await until(`${open} && document.querySelector('.service[data-traced] a[href="#roles"][aria-current]') && document.querySelector('.service .rail-dot').getAnimations().length===1`);
 assert.equal(await logoFilter(),'none');
 assert.equal(await evaluate(aligned),true);
 await until(`!${open} && document.activeElement.id==='roles-title' && location.hash==='#roles'`);
 assert.equal(await evaluate(`document.getElementById('contents-location').textContent`),'Add the four roles');

 await tap('#guide-contents > summary');
 await until(`${open} && ${aligned}`);
 await evaluate(`(() => {for(const id of ['account','microsoft']) document.querySelector('#guide-nav a[href="#'+id+'"]').dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true,button:0,detail:1}));})()`);
 await until(`!${open} && document.activeElement.id==='microsoft-title' && location.hash==='#microsoft'`);
 assert.equal(await logoFilter(),'grayscale(1)');
 await evaluate(`scrollBy(0,document.getElementById('roles-title').getBoundingClientRect().top-18)`);
 await until(`document.querySelector('#guide-nav a[aria-current]').hash==='#roles'`);
 assert.equal(await logoFilter(),'none');
 assert.equal(await evaluate(`document.getElementById('contents-location').textContent`),'Add the four roles');
 await browser.cdp.send('Emulation.setDeviceMetricsOverride',{width:320,height:640,deviceScaleFactor:1,mobile:true});
 assert.equal(await evaluate('document.documentElement.scrollWidth>innerWidth'),false);
 assert.equal(blocked,0);assert.ok(requests.size>=2);
});

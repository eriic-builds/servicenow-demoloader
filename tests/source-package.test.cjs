'use strict';
const {test,before,after}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path'),{execFile}=require('node:child_process'),{promisify}=require('node:util');
const exec=promisify(execFile),root=path.resolve(__dirname,'..'),release=require('../release.json');let temp,source;
const ps=(file,args=[],env=process.env)=>exec('pwsh.exe',['-NoProfile','-NonInteractive','-File',file,...args],{env,windowsHide:true,timeout:60000,maxBuffer:2*1024*1024});
async function extract(zip,destination){await exec('pwsh.exe',['-NoProfile','-NonInteractive','-Command','Expand-Archive -LiteralPath $env:SN_SOURCE_ZIP -DestinationPath $env:SN_SOURCE_EXTRACT'],{env:{...process.env,SN_SOURCE_ZIP:zip,SN_SOURCE_EXTRACT:destination},windowsHide:true,timeout:30000});}
before(async()=>{temp=await fs.mkdtemp(path.join(os.tmpdir(),'sn-source-test-'));let zip=process.env.SN_DEMOSEEDER_TEST_SOURCE_ZIP;if(!zip)zip=JSON.parse((await ps(path.join(root,'scripts','build-source.ps1'),['-Destination',temp])).stdout).archive;await assert.rejects(fs.access(zip+'.sha256'),{code:'ENOENT'});const unpack=path.join(temp,'unpack');await extract(zip,unpack);source=path.join(temp,'Arbitrary Clone [folder]');await fs.rename(path.join(unpack,release.archivePrefix+'-Source-'+release.version),source);});
after(async()=>{if(temp)await fs.rm(temp,{recursive:true,force:true,maxRetries:10,retryDelay:100});});
test('GitHub source export excludes operational material and borrowed theme artwork',async()=>{
 const entries=await fs.readdir(source,{recursive:true,withFileTypes:true});for(const entry of entries){if(!entry.isFile())continue;const full=path.join(entry.parentPath,entry.name),relative=path.relative(source,full);assert.ok(!/(^|\\)(configs|runs|logs|snapshots|credentials|state)(\\|$)/i.test(relative),relative);assert.ok(!(await fs.readFile(full,'utf8')).includes(os.homedir()),relative);}
 const html=await fs.readFile(path.join(source,'config-builder.html'),'utf8');assert.ok(html.includes('data-original-illustration="true"'));assert.ok(!/<img\b[^>]*id="template-artwork"/i.test(html));assert.ok(await fs.readFile(path.join(source,'README.txt'),'utf8'));assert.ok(await fs.readFile(path.join(source,'README.md'),'utf8'));assert.ok(await fs.readFile(path.join(source,'PREREQUISITES.html'),'utf8'));assert.ok(await fs.readFile(path.join(source,'.gitignore'),'utf8'));
});
test('a renamed standalone source checkout rebuilds the identical installed payload',async()=>{
 const built=JSON.parse((await ps(path.join(source,'scripts','build-release.ps1'),['-Destination',path.join(temp,'rebuilt')])).stdout),reference=JSON.parse((await ps(path.join(root,'scripts','build-release.ps1'),['-Destination',path.join(temp,'reference')])).stdout);
 await extract(built.archive,path.join(temp,'rebuilt-unpack'));await extract(reference.archive,path.join(temp,'reference-unpack'));const name=release.archivePrefix+'-Scout-'+release.version;
 const rebuilt=JSON.parse(await fs.readFile(path.join(temp,'rebuilt-unpack',name,'package-manifest.json'),'utf8')),original=JSON.parse(await fs.readFile(path.join(temp,'reference-unpack',name,'package-manifest.json'),'utf8'));
 assert.deepEqual(Object.fromEntries(rebuilt.files.map(file=>[file.path,file.sha256])),Object.fromEntries(original.files.map(file=>[file.path,file.sha256])));
});
test('source launcher resolves its repository without a personal sibling layout',async()=>{
 const home=path.join(temp,'isolated-user');await fs.mkdir(home);const env={...process.env,HOME:home,USERPROFILE:home,LOCALAPPDATA:path.join(home,'Local')};const result=JSON.parse((await ps(path.join(source,'skill','scripts','launch.ps1'),['-Action','Paths'],env)).stdout);assert.equal(result.projectRoot,source);assert.equal(result.installed,false);assert.equal(result.runtimeHome,path.join(env.LOCALAPPDATA,'Scout','ServiceNowDemoSeeder'));
});
test('Scout local-store junction resolves the authored skill and sibling runtime consistently',async()=>{
 const personal=path.join(temp,'Personal Build [root]'),home=path.join(temp,'junction-user'),skills=path.join(personal,'_Skills');await fs.mkdir(skills,{recursive:true});await fs.cp(path.join(source,'skill'),path.join(skills,release.skillName),{recursive:true});await fs.symlink(source,path.join(personal,'SN-DemoSeeder'),'junction');await fs.mkdir(path.join(home,'.scout'),{recursive:true});await fs.symlink(skills,path.join(home,'.scout','m-skills'),'junction');
 const env={...process.env,HOME:home,USERPROFILE:home,LOCALAPPDATA:path.join(home,'Local')},launcher=path.join(home,'.scout','m-skills',release.skillName,'scripts','launch.ps1');
 const result=JSON.parse((await ps(launcher,['-Action','Menu'],env)).stdout);assert.ok(result.menu.some(item=>item.title==='Load HR knowledge pack'));assert.equal(result.profileCount,0);
});
test('a local Git clone with Windows checkout settings builds a valid installable release',async()=>{
 const git=(args)=>exec('git',args,{windowsHide:true,timeout:30000,maxBuffer:2*1024*1024});
 await git(['init','--quiet',source]);await git(['-C',source,'config','core.autocrlf','true']);
 await git(['-C',source,'add','--','.']);
 await git(['-C',source,'-c','user.name=Fixture Builder','-c','user.email=fixture@example.invalid','-c','commit.gpgsign=false','-c','core.hooksPath=NUL','commit','--quiet','-m','Fixture source export\n\nCo-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>']);
 const clone=path.join(temp,'Colleague Clone [standalone]');await git(['-c','core.autocrlf=true','clone','--quiet','--no-hardlinks','--',source,clone]);
 const built=JSON.parse((await ps(path.join(clone,'scripts','build-release.ps1'),['-Destination',path.join(temp,'clone-release'),'-ReleaseAsset'])).stdout);
 assert.equal(path.basename(built.archive),'SN-DemoLoader-Scout.zip');
 const extracted=path.join(temp,'clone-installer');await extract(built.archive,extracted);const installer=path.join(extracted,release.archivePrefix+'-Scout-'+release.version,'Install-SN-DemoLoader.ps1');
 const home=path.join(temp,'clone-user');await fs.mkdir(home);const env={...process.env,HOME:home,USERPROFILE:home,LOCALAPPDATA:path.join(home,'Local')};
 assert.equal(JSON.parse((await ps(installer,['-Confirm','-PrerequisitesConfirmed'],env)).stdout).version,release.version);
 assert.equal(JSON.parse((await ps(installer,['-Action','Verify'],env)).stdout).ok,true);
 await ps(installer,['-Action','Uninstall','-Confirm'],env);
});

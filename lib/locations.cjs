'use strict';
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {error}=require('./profiles.cjs');
const release=require('../release.json');
function contains(parent,child){const relative=path.relative(parent,child);return relative===''||(!relative.startsWith('..'+path.sep)&&relative!=='..'&&!path.isAbsolute(relative));}
function physicalPath(value){let cursor=path.resolve(value),tail=[];for(;;){try{return path.join(fs.realpathSync.native(cursor),...tail);}catch(e){if(e.code!=='ENOENT')throw e;const parent=path.dirname(cursor);if(parent===cursor)throw e;tail.unshift(path.basename(cursor));cursor=parent;}}}
function locations({projectRoot,output,runtime,env=process.env,home=env.USERPROFILE||os.homedir(),allowInstallationLock=false}={}){
 if(!path.isAbsolute(projectRoot||'')||!path.isAbsolute(home||'')||!env.LOCALAPPDATA||!path.isAbsolute(env.LOCALAPPDATA))throw error('Absolute user home and Windows LOCALAPPDATA are required.','runtime_unsafe',409);
 const root=path.resolve(projectRoot),runtimeHome=path.resolve(env.LOCALAPPDATA,'Scout','ServiceNowDemoSeeder');
 if(!allowInstallationLock&&fs.existsSync(path.join(runtimeHome,'state','installation.lock')))throw error('An installation lease exists. Run launcher Diagnose, then Recover -Confirm only for an abandoned owner; never clear a live lease or PDI journal.','installation_busy',409);
 if(runtime&&path.resolve(runtime).toLowerCase()!==runtimeHome.toLowerCase())throw error('Runtime authority must stay in LOCALAPPDATA\\Scout\\ServiceNowDemoSeeder. Alternate runtime folders would split physical-PDI locks.','runtime_unsafe',409);
 const marker=path.join(root,'install-layout.json');let installed=false,configuredOutput;
 if(fs.existsSync(marker)){
  const layout=JSON.parse(fs.readFileSync(marker,'utf8'));
  if(layout.schemaVersion!==1||layout.product!==release.product)throw error('Installed layout metadata is invalid. Reinstall the skill rather than guessing storage.','installation_invalid',409);
  installed=true;
  const receiptFile=path.join(path.dirname(root),'.sn-demoseeder-install.json');
  if(fs.existsSync(receiptFile)){const receipt=JSON.parse(fs.readFileSync(receiptFile,'utf8'));if(receipt.product!==release.product||receipt.schemaVersion!==1||!path.isAbsolute(receipt.outputRoot||''))throw error('Installation receipt is invalid.','installation_invalid',409);configuredOutput=receipt.outputRoot;}
 }
 const outputRoot=path.resolve(output||configuredOutput||(installed?path.join(home,'.copilot',release.outputFolder):path.join(path.dirname(root),'SN-DemoSeed-Output'))),skillRoot=installed?path.dirname(root):null;
 const physicalOutput=physicalPath(outputRoot);
 for(const resource of [runtimeHome,root,...(skillRoot?[skillRoot]:[])]){const physicalResource=physicalPath(resource);if(contains(physicalResource,physicalOutput)||contains(physicalOutput,physicalResource))throw error('Operational output must be separate from installed resources and protected runtime authority, including through directory links.','runtime_unsafe',409);}
 return {projectRoot:root,skillRoot,outputRoot,runtimeHome,installed,version:release.version,displayName:release.displayName,skillName:release.skillName};
}
module.exports={locations,contains};

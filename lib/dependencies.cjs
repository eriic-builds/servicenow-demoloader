'use strict';
const fs=require('node:fs');
const path=require('node:path');
const {spawnSync}=require('node:child_process');
const release=require('../release.json');
function edgeCandidates(env=process.env){return [...new Set([env['ProgramFiles(x86)'],env.ProgramFiles,env.LOCALAPPDATA].filter(Boolean).map(root=>path.join(root,'Microsoft','Edge','Application','msedge.exe')))];}
function findEdge(env=process.env){for(const candidate of edgeCandidates(env)){try{if(fs.statSync(candidate).isFile())return candidate;}catch(e){if(!['ENOENT','ENOTDIR'].includes(e.code))throw e;}}return null;}
function dependencies(env=process.env){
 const result=spawnSync('pwsh.exe',['-NoProfile','-NonInteractive','-Command','$PSVersionTable.PSVersion.ToString()'],{env,encoding:'utf8',windowsHide:true,timeout:10000,maxBuffer:16384});
 if(result.error&&result.error.code!=='ENOENT')throw result.error;
 const version=result.status===0?(result.stdout||'').trim():null,parts=(version||'').split('.').map(Number);
 const powershell={available:parts[0]>7||(parts[0]===7&&parts[1]>=2),version,minimum:release.minimumPowerShellVersion};
 const edgePath=findEdge(env),nodeMajor=Number(process.versions.node.split('.')[0]);
 return {ok:process.platform==='win32'&&nodeMajor>=release.minimumNodeMajor&&powershell.available&&Boolean(edgePath),requirements:{windows:process.platform==='win32',node:process.version,minimumNodeMajor:release.minimumNodeMajor,powershell,edgeAvailable:Boolean(edgePath),edgePath},networkRequests:false};
}
module.exports={edgeCandidates,findEdge,dependencies};

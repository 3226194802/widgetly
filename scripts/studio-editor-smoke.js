const fs = require('fs');
const path = require('path');
const port = Number(process.argv[2] || 9381);
const output = process.argv[3] || 'F:\\Widgetly-test-studio\\editors';

class C {
  constructor(url) {
    this.next=1; this.pending=new Map(); this.socket=new WebSocket(url);
    this.ready=new Promise((resolve,reject)=>{this.socket.addEventListener('open',resolve,{once:true});this.socket.addEventListener('error',reject,{once:true});});
    this.socket.addEventListener('message',(event)=>{const data=JSON.parse(event.data),slot=this.pending.get(data.id);if(!slot)return;this.pending.delete(data.id);data.error?slot.reject(new Error(data.error.message)):slot.resolve(data.result);});
  }
  async send(method,params={}){await this.ready;return new Promise((resolve,reject)=>{const id=this.next++;this.pending.set(id,{resolve,reject});this.socket.send(JSON.stringify({id,method,params}));});}
  close(){this.socket.close();}
}
const wait=(ms)=>new Promise((resolve)=>setTimeout(resolve,ms));
async function pages(){return(await(await fetch(`http://127.0.0.1:${port}/json/list`)).json()).filter((p)=>p.type==='page');}
async function waitFor(match,timeout=5000){const start=Date.now();while(Date.now()-start<timeout){const target=(await pages()).find(match);if(target)return target;await wait(80);}throw new Error('Target timeout');}
async function evalIn(c,expression){const result=await c.send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});return result.result.value;}
async function shot(c,file){const result=await c.send('Page.captureScreenshot',{format:'png',fromSurface:true,captureBeyondViewport:false});fs.writeFileSync(file,Buffer.from(result.data,'base64'));}

(async()=>{
  fs.mkdirSync(output,{recursive:true});
  const hosts=(await pages()).filter((p)=>p.url.includes('/widgets/studio/index.html')&&!p.url.includes('settings=1'));
  const results=[];
  for(const hostTarget of hosts){
    const hostUrl=new URL(hostTarget.url),wid=hostUrl.searchParams.get('wid'),inst=hostUrl.searchParams.get('inst');
    const host=new C(hostTarget.webSocketDebuggerUrl);await host.ready;await evalIn(host,'openEditor();true');
    const settingTarget=await waitFor((p)=>p.url.includes('/widgets/studio/index.html')&&p.url.includes('settings=1')&&new URL(p.url).searchParams.get('inst')===inst);
    const setting=new C(settingTarget.webSocketDebuggerUrl);await setting.ready;await wait(500);
    await evalIn(setting,`new Promise((resolve)=>{const started=Date.now();const check=()=>{const ready=document.body.classList.contains('settings-page')&&document.getElementById('content').hidden&&!document.getElementById('editor').hidden;if(ready||Date.now()-started>3000)resolve(ready);else setTimeout(check,50);};check();})`);
    const state=await evalIn(setting,`(()=>{const editor=document.getElementById('editor'),shell=editor.querySelector('.editor-shell'),body=editor.querySelector('.editor-body'),r=shell.getBoundingClientRect();return{viewport:[innerWidth,innerHeight],document:[document.documentElement.scrollWidth,document.documentElement.scrollHeight],hidden:editor.hidden,settingsMode:document.body.classList.contains('settings-page'),contentHidden:document.getElementById('content').hidden,shell:[r.x,r.y,r.width,r.height],shellFits:r.left>=-1&&r.top>=-1&&r.right<=innerWidth+1&&r.bottom<=innerHeight+1,fields:body.querySelectorAll('input,select,textarea,button').length,hasOpacityField:!!document.getElementById('editOpacity'),alarmSoundFields:['editAlarmSoundMode','editAlarmSoundRepeat','editAlarmSoundVolume'].filter((id)=>!!document.getElementById(id)).length,footerButtons:[...shell.querySelectorAll('footer button')].every((b)=>{const x=b.getBoundingClientRect();return x.width>0&&x.height>0&&x.right<=innerWidth+1&&x.bottom<=innerHeight+1;})}})()`);
    await shot(setting,path.join(output,wid+'-settings-page.png'));
    await evalIn(setting,"document.getElementById('editorCancel').click();true");
    await wait(220);setting.close();host.close();results.push({wid,...state});
  }
  results.sort((a,b)=>a.wid.localeCompare(b.wid));results.forEach((r)=>console.log('SETTINGS_SMOKE|'+JSON.stringify(r)));console.log('SETTINGS_COUNT|'+results.length);
  const alarm=results.find((item)=>item.wid==='alarmClock');
  if(results.some((item)=>!item.settingsMode||!item.contentHidden||!item.shellFits||!item.footerButtons||item.hasOpacityField)||!alarm||alarm.alarmSoundFields!==3)throw new Error('studio settings regression');
})().catch((error)=>{console.error(error.stack||error);process.exitCode=1;});

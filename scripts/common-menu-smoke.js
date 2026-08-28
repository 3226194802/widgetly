const fs = require('fs');

const port = Number(process.argv[2] || 9381);
const output = process.argv[3] || 'F:\\Widgetly-test-studio\\common-menu.png';
class Cdp {
  constructor(url){this.next=1;this.pending=new Map();this.socket=new WebSocket(url);this.ready=new Promise((r,j)=>{this.socket.onopen=r;this.socket.onerror=j;});this.socket.onmessage=(event)=>{const data=JSON.parse(event.data);const pending=this.pending.get(data.id);if(!pending)return;this.pending.delete(data.id);data.error?pending.reject(new Error(data.error.message)):pending.resolve(data.result);};}
  async send(method,params={}){await this.ready;return new Promise((resolve,reject)=>{const id=this.next++;this.pending.set(id,{resolve,reject});this.socket.send(JSON.stringify({id,method,params}));});}
  async eval(expression){const result=await this.send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});return result.result.value;}
  close(){this.socket.close();}
}
async function list(){return (await fetch(`http://127.0.0.1:${port}/json/list`)).json();}
async function waitFor(match,timeout=4000){const started=Date.now();while(Date.now()-started<timeout){const target=(await list()).find(match);if(target)return target;await new Promise(r=>setTimeout(r,100));}throw new Error('Target timeout');}

(async()=>{
  const studioTarget=await waitFor((target)=>target.url.includes('wid=stickyNote'));
  const studio=new Cdp(studioTarget.webSocketDebuggerUrl);await studio.ready;
  const prevented=await studio.eval(`(()=>{const event=new MouseEvent('contextmenu',{bubbles:true,cancelable:true,button:2,clientX:80,clientY:80});document.getElementById('card').dispatchEvent(event);return event.defaultPrevented})()`);
  const menuTarget=await waitFor((target)=>target.url.includes('/widgets/common/menu.html'));
  const menu=new Cdp(menuTarget.webSocketDebuggerUrl);await menu.ready;await new Promise(r=>setTimeout(r,200));
  const state=await menu.eval(`({text:document.body.innerText,size:[innerWidth,innerHeight],items:document.querySelectorAll('.item').length,sliders:document.querySelectorAll('input[type=range]').length,background:getComputedStyle(document.body).backgroundColor})`);
  const shot=await menu.send('Page.captureScreenshot',{format:'png',fromSurface:true});fs.writeFileSync(output,Buffer.from(shot.data,'base64'));
  await menu.eval(`(()=>{const input=document.querySelector('input[type=range]');input.value='63';input.dispatchEvent(new Event('input',{bubbles:true}));input.dispatchEvent(new Event('change',{bubbles:true}));return true;})()`);
  await new Promise(r=>setTimeout(r,320));
  const applied=await studio.eval(`({opacity:cfg.bgOpacity,css:document.getElementById('card').style.getPropertyValue('--bg-alpha'),internalEditorHidden:document.getElementById('editor').hidden})`);
  await menu.eval(`document.querySelector('.item').click();true`);
  const settingsTarget=await waitFor((target)=>target.url.includes('/widgets/studio/index.html')&&target.url.includes('inst=test-sticky')&&target.url.includes('settings=1'));
  const settings=new Cdp(settingsTarget.webSocketDebuggerUrl);await settings.ready;await new Promise(r=>setTimeout(r,600));
  const settingsPage=await settings.eval(`({separate:document.body.classList.contains('settings-page'),visible:!document.getElementById('editor').hidden,size:[innerWidth,innerHeight],title:document.getElementById('editorTitle').textContent,hasOpacityField:!!document.getElementById('editOpacity')})`);
  await settings.eval(`document.getElementById('editorSave').click();true`);await new Promise(r=>setTimeout(r,300));
  console.log('COMMON_MENU|'+JSON.stringify({prevented,state,settingsPage,applied,output}));
  if(!prevented||state.sliders!==1||!state.text.includes('背景透明度')||!settingsPage.separate||!settingsPage.visible||settingsPage.hasOpacityField||Math.abs(applied.opacity-.37)>.001||applied.css!=='0.37')throw new Error('common menu regression');
  settings.close();menu.close();studio.close();
})().catch((error)=>{console.error(error.stack||error);process.exitCode=1;});

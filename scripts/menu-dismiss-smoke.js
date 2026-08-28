const port=Number(process.argv[2]||9387);
class C{constructor(url){this.n=1;this.p=new Map();this.w=new WebSocket(url);this.r=new Promise((r,j)=>{this.w.onopen=r;this.w.onerror=j});this.w.onmessage=e=>{const d=JSON.parse(e.data),p=this.p.get(d.id);if(!p)return;this.p.delete(d.id);d.error?p.j(new Error(d.error.message)):p.r(d.result)}}async s(method,params={}){await this.r;return new Promise((resolve,reject)=>{const id=this.n++;this.p.set(id,{r:resolve,j:reject});this.w.send(JSON.stringify({id,method,params}))})}async e(expression){const x=await this.s('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});return x.result.value}close(){this.w.close()}}
const wait=ms=>new Promise(r=>setTimeout(r,ms));const pages=async()=>(await(await fetch(`http://127.0.0.1:${port}/json/list`)).json()).filter(x=>x.type==='page');
async function waitFor(match,timeout=5000){const start=Date.now();while(Date.now()-start<timeout){const found=(await pages()).find(match);if(found)return found;await wait(80)}throw new Error('target timeout')}
(async()=>{
  const hostTarget=await waitFor(t=>/wid=(stickyNote|flipClock)/.test(t.url)&&!t.url.includes('settings=1'));
  const host=new C(hostTarget.webSocketDebuggerUrl);await host.r;
  await host.e(`document.getElementById('card').dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,button:2}));true`);
  const menuTarget=await waitFor(t=>t.url.includes('/widgets/common/menu.html'));const menu=new C(menuTarget.webSocketDebuggerUrl);await menu.r;await wait(180);
  const opened=await menu.e(`({visible:!document.hidden,items:document.querySelectorAll('.item').length})`);
  await host.e(`require('electron').ipcRenderer.send('activate');true`);await wait(350);
  const closed=!(await pages()).some(t=>t.url.includes('/widgets/common/menu.html'));
  console.log('MENU_DISMISS|'+JSON.stringify({opened,closed}));
  if(!opened.visible||opened.items<5||!closed)throw new Error('menu did not close on blur');
  menu.close();host.close();
})().catch(e=>{console.error(e.stack||e);process.exitCode=1});

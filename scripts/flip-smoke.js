const fs=require('fs');
const port=Number(process.argv[2]||9387),output=process.argv[3]||'F:\\Widgetly-test-studio\\flip-final.png';
class C{constructor(url){this.n=1;this.p=new Map();this.w=new WebSocket(url);this.r=new Promise((r,j)=>{this.w.onopen=r;this.w.onerror=j});this.w.onmessage=e=>{const d=JSON.parse(e.data),p=this.p.get(d.id);if(!p)return;this.p.delete(d.id);d.error?p.j(new Error(d.error.message)):p.r(d.result)}}async s(method,params={}){await this.r;return new Promise((resolve,reject)=>{const id=this.n++;this.p.set(id,{r:resolve,j:reject});this.w.send(JSON.stringify({id,method,params}))})}async e(expression){const x=await this.s('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(x.exceptionDetails)throw new Error(x.result&&x.result.description||x.exceptionDetails.text);return x.result.value}close(){this.w.close()}}
const wait=ms=>new Promise(r=>setTimeout(r,ms));
(async()=>{
  const pages=await(await fetch(`http://127.0.0.1:${port}/json/list`)).json(),target=pages.find(t=>t.url.includes('wid=flipClock')&&!t.url.includes('inst=preview'));
  if(!target)throw new Error('flipClock target missing');const c=new C(target.webSocketDebuggerUrl);await c.r;
  const inst=await c.e(`new URLSearchParams(location.search).get('inst')`);await c.e(`require('electron').ipcRenderer.send('resize:${inst}',{width:280,height:148});true`);await wait(300);
  const state=await c.e(`(()=>{cfg.showSeconds=true;const before=new Date(Date.now()-1000);let hour=before.getHours();if(cfg.hour12)hour=hour%12||12;lastFlip=[pad(hour),pad(before.getMinutes()),pad(before.getSeconds())].join(':');paintClock();const groups=[...document.querySelectorAll('.flip-group')],seconds=groups[2],animated=seconds&&seconds.querySelector('.flip');return{viewport:[innerWidth,innerHeight],groups:groups.length,digits:document.querySelectorAll('.flip-digit').length,secondsVisible:!!seconds&&getComputedStyle(seconds).display!=='none'&&seconds.getBoundingClientRect().right<=innerWidth+1,staticFlips:groups.slice(0,2).reduce((n,g)=>n+g.querySelectorAll('.flip').length,0),secondFlips:seconds?seconds.querySelectorAll('.flip').length:0,animation:animated?getComputedStyle(animated,'::before').animationName:'',time:groups.map(g=>g.innerText).join(':')}})()`);
  const shot=await c.s('Page.captureScreenshot',{format:'png',fromSurface:true,captureBeyondViewport:false});fs.writeFileSync(output,Buffer.from(shot.data,'base64'));
  console.log('FLIP_SMOKE|'+JSON.stringify({...state,output}));
  if(state.viewport[0]!==280||state.groups!==3||state.digits!==6||!state.secondsVisible||state.staticFlips!==0||state.secondFlips<1||state.animation!=='flipSecond')throw new Error('flip clock assertion failed');
  c.close();
})().catch(e=>{console.error(e.stack||e);process.exitCode=1});

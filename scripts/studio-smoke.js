const fs = require('fs');
const path = require('path');

const port = Number(process.argv[2] || 9381);
const output = process.argv[3] || 'F:\\Widgetly-test-studio\\screens';
const smallSizes = {
  plannerCalendar:[520,360], quadrantTasks:[280,280], miniCalendarGlass:[240,250], flipClock:[190,104],
  cycleCountdown:[210,150], desktopFolder:[250,250], analogClock:[130,130], digitalClockGlass:[180,92],
  stickyNote:[230,190], lineWeather:[280,230], desktopSchedule:[250,200], markdownNote:[250,260],
  desktopCounter:[240,150], classSchedule:[240,280], progressTracker:[270,210], simplePomodoro:[230,160],
  clockCalendar:[270,400], durationTimer:[260,160], alarmClock:[280,170],
};
const defaultSizes = {
  plannerCalendar:[720,500], quadrantTasks:[370,370], miniCalendarGlass:[310,330], flipClock:[280,148],
  cycleCountdown:[280,210], desktopFolder:[330,440], analogClock:[220,220], digitalClockGlass:[280,148],
  stickyNote:[310,300], lineWeather:[360,310], desktopSchedule:[340,300], markdownNote:[330,420],
  desktopCounter:[320,210], classSchedule:[310,390], progressTracker:[360,300], simplePomodoro:[300,205],
  clockCalendar:[330,560], durationTimer:[360,220], alarmClock:[360,220],
};

class Cdp {
  constructor(url) {
    this.next = 1; this.pending = new Map(); this.socket = new WebSocket(url);
    this.ready = new Promise((resolve,reject)=>{this.socket.addEventListener('open',resolve,{once:true});this.socket.addEventListener('error',reject,{once:true});});
    this.socket.addEventListener('message',(event)=>{const data=JSON.parse(event.data);if(!data.id)return;const slot=this.pending.get(data.id);if(!slot)return;this.pending.delete(data.id);if(data.error)slot.reject(new Error(data.error.message));else slot.resolve(data.result);});
  }
  async send(method,params={}) { await this.ready; return new Promise((resolve,reject)=>{const id=this.next++;this.pending.set(id,{resolve,reject});this.socket.send(JSON.stringify({id,method,params}));}); }
  close(){this.socket.close();}
}

async function targets(){const response=await fetch(`http://127.0.0.1:${port}/json/list`);return response.json();}
async function evaluate(cdp,expression){const result=await cdp.send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});return result.result.value;}
async function screenshot(cdp,file){const result=await cdp.send('Page.captureScreenshot',{format:'png',fromSurface:true,captureBeyondViewport:false});fs.writeFileSync(file,Buffer.from(result.data,'base64'));}

(async()=>{
  fs.mkdirSync(output,{recursive:true});
  const pages=(await targets()).filter((target)=>target.type==='page'&&target.url.includes('/widgets/studio/index.html'));
  const results=[];
  for(const page of pages){
    const cdp=new Cdp(page.webSocketDebuggerUrl);await cdp.ready;
    let meta=await evaluate(cdp,`(()=>{const p=new URLSearchParams(location.search);return{wid:p.get('wid'),inst:p.get('inst')}})()`);
    const wid=meta.wid; if(!wid){cdp.close();continue;}
    const normal=defaultSizes[wid];
    if(normal){await evaluate(cdp,`require('electron').ipcRenderer.send('resize:${meta.inst}',{width:${normal[0]},height:${normal[1]}});true`);await new Promise(r=>setTimeout(r,250));}
    await evaluate(cdp,'location.reload();true'); await new Promise(r=>setTimeout(r,450));
    const initial=await evaluate(cdp,`(()=>{const p=new URLSearchParams(location.search);const card=document.getElementById('card').getBoundingClientRect();return{wid:p.get('wid'),inst:p.get('inst'),viewport:[innerWidth,innerHeight],document:[document.documentElement.scrollWidth,document.documentElement.scrollHeight],card:[card.x,card.y,card.width,card.height],transparent:getComputedStyle(document.body).backgroundColor,editorHidden:document.getElementById('editor').hidden,lunar:typeof LUNAR_API==='object'?LUNAR_API.lunarText(2026,8,25):typeof LUNAR_API,errors:window.__widgetlyErrors||[]}})()`);
    await screenshot(cdp,path.join(output,wid+'-default.png'));
    const small=smallSizes[wid];
    if(small){await evaluate(cdp,`require('electron').ipcRenderer.send('resize:${initial.inst}',{width:${small[0]},height:${small[1]}});true`);await new Promise(r=>setTimeout(r,350));}
    const compact=await evaluate(cdp,`(()=>{const all=[...document.querySelectorAll('#content *')].filter(e=>{const s=getComputedStyle(e);return s.display!=='none'&&s.visibility!=='hidden'});const bad=all.filter(e=>{const r=e.getBoundingClientRect();return r.right>innerWidth+2||r.bottom>innerHeight+2||r.left<-2||r.top<-2}).slice(0,8).map(e=>({tag:e.tagName,cls:e.className,rect:[e.getBoundingClientRect().x,e.getBoundingClientRect().y,e.getBoundingClientRect().width,e.getBoundingClientRect().height]}));return{viewport:[innerWidth,innerHeight],document:[document.documentElement.scrollWidth,document.documentElement.scrollHeight],bad,contentOverflow:[document.getElementById('content').scrollWidth,document.getElementById('content').scrollHeight]}})()`);
    await screenshot(cdp,path.join(output,wid+'-compact.png'));
    results.push({wid,initial,compact});cdp.close();
  }
  results.sort((a,b)=>a.wid.localeCompare(b.wid));
  for(const result of results)process.stdout.write('STUDIO_SMOKE|'+JSON.stringify(result)+'\n');
  process.stdout.write('STUDIO_COUNT|'+results.length+'\n');
})().catch((error)=>{console.error(error.stack||error);process.exitCode=1;});

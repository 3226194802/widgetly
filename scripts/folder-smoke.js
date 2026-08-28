const fs=require('fs');
const port=Number(process.argv[2]||9386),output=process.argv[3]||'F:\\Widgetly-test-source-030-final\\folder-sort.png';
class C{constructor(url){this.n=1;this.p=new Map();this.w=new WebSocket(url);this.r=new Promise((r,j)=>{this.w.onopen=r;this.w.onerror=j});this.w.onmessage=e=>{const d=JSON.parse(e.data),p=this.p.get(d.id);if(!p)return;this.p.delete(d.id);d.error?p.j(new Error(d.error.message)):p.r(d.result)}}async s(method,params={}){await this.r;return new Promise((resolve,reject)=>{const id=this.n++;this.p.set(id,{r:resolve,j:reject});this.w.send(JSON.stringify({id,method,params}))})}async e(expression){const x=await this.s('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(x.exceptionDetails)throw new Error(x.exceptionDetails.text);return x.result.value}close(){this.w.close()}}
const wait=ms=>new Promise(r=>setTimeout(r,ms));
(async()=>{
  const pages=await(await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const target=pages.find(t=>t.url.includes('wid=desktopFolder')&&!t.url.includes('inst=preview'));
  if(!target)throw new Error('desktopFolder target missing');
  const c=new C(target.webSocketDebuggerUrl);await c.r;
  await c.e(`require('electron').ipcRenderer.send('resize:test-folder-final',{width:330,height:440});folderCurrent='';loadFolder();true`);await wait(450);
  const root=await c.e(`({folder:folderData.folder,relative:folderData.relative,items:folderData.items.map(x=>x.name),icons:document.querySelectorAll('.file-icon svg').length,sortButton:!!document.querySelector('[data-action="folder-sort-toggle"]')})`);
  await c.e(`(()=>{const index=visibleFolderItems.findIndex(x=>x.name==='子文件夹');document.querySelector('.file-row[data-index="'+index+'"]').click();return true})()`);await wait(400);
  const entered=await c.e(`({relative:folderData.relative,canGoBack:folderData.canGoBack,items:folderData.items.map(x=>x.name)})`);
  await c.e(`document.querySelector('[data-action="folder-back"]').click();true`);await wait(350);
  await c.e(`document.querySelector('[data-action="folder-sort-toggle"]').click();true`);await wait(120);
  const sortMenu=await c.e(`({visible:!!document.querySelector('.folder-sort-popover'),options:document.querySelectorAll('.folder-sort-popover button').length,labels:[...document.querySelectorAll('.folder-sort-popover button span')].map(x=>x.textContent)})`);
  const shot=await c.s('Page.captureScreenshot',{format:'png',fromSurface:true,captureBeyondViewport:false});fs.writeFileSync(output,Buffer.from(shot.data,'base64'));
  await c.e(`document.querySelector('.folder-count').dispatchEvent(new PointerEvent('pointerdown',{bubbles:true}));true`);await wait(80);
  const dismissed=await c.e(`!document.querySelector('.folder-sort-popover')&&!folderSortOpen`);
  await c.e(`document.querySelector('[data-action="folder-sort-toggle"]').click();document.querySelector('[data-value="date-desc"]').click();true`);await wait(180);
  await c.e(`document.querySelector('[data-action="folder-create"]').click();document.getElementById('folderNameInput').value='Widgetly测试创建2';document.querySelector('[data-action="folder-create-submit"]').click();true`);await wait(450);
  const created=await c.e(`folderData.items.some(x=>x.name==='Widgetly测试创建2')`);
  await c.e(`(()=>{const index=visibleFolderItems.findIndex(x=>x.name==='Widgetly测试创建2');document.querySelector('[data-action="file-more"][data-index="'+index+'"]').click();document.querySelector('[data-action="file-rename"]').click();document.getElementById('folderNameInput').value='Widgetly测试已重命名2';document.querySelector('[data-action="file-rename-submit"]').click();return true})()`);await wait(450);
  const renamed=await c.e(`folderData.items.some(x=>x.name==='Widgetly测试已重命名2')`);
  const result={root,entered,sortMenu,dismissed,sortSaved:await c.e(`cfg.folderSort`),created,renamed,viewport:await c.e(`[innerWidth,innerHeight]`),output};
  if(!entered.items.includes('子文件.txt')||!sortMenu.visible||sortMenu.options!==6||!dismissed||!created||!renamed)throw new Error('folder interaction assertion failed: '+JSON.stringify(result));
  console.log('FOLDER_SMOKE|'+JSON.stringify(result));c.close();
})().catch(e=>{console.error(e.stack||e);process.exitCode=1});

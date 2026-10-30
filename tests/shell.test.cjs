'use strict';

// Exercise the actual renderer in Electron, with only its main-process bridge
// replaced. No DOM library, external pages, or user's browser profile is used.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

if (process.versions.electron && process.env.TURBO_SHELL_FIXTURE === '1') {
  const { app, BrowserWindow } = require('electron');
  const fixture = process.env.TURBO_SHELL_FIXTURE_DIRECTORY;
  if (!fixture || !path.isAbsolute(fixture)) throw new Error('An isolated renderer test directory is required.');
  app.setPath('userData', path.join(fixture, 'profile'));
  app.enableSandbox();
  const initial = {
    tabs: [
      { id:'alpha', title:'Alpha', url:'https://example.test/alpha', loading:false, private:false, muted:false, zoom:1 },
      { id:'beta', title:'Beta', url:'turbo://newtab', loading:false, private:false, muted:true, zoom:1 }
    ],
    activeId:'alpha', bookmarks:[], history:[], downloads:[],
    settings:{theme:'dark',searchEngine:'duckduckgo',restoreSession:true},
    versions:{app:'0.3.0',chromium:'145.0.0',electron:'45.1.0'}, overlayOpen:false
  };
  const preload = path.join(fixture, 'fixture-preload.cjs');
  fs.writeFileSync(preload, `
    const {contextBridge}=require('electron');
    let state=${JSON.stringify(initial)};let listener;const calls=[];
    contextBridge.exposeInMainWorld('turbo',{
      command:async(action,payload={})=>{
        calls.push({action,payload});
        if(action==='set-overlay')state={...state,overlayOpen:payload.open};
        if(action==='mute-tab')state={...state,tabs:state.tabs.map(tab=>tab.id===payload.id?{...tab,muted:payload.muted}:tab)};
        return state;
      },onState:callback=>{listener=callback;},onShortcut:()=>{}
    });
    contextBridge.exposeInMainWorld('__fixture',{
      update:next=>{state=next;listener?.(state);},state:()=>state,calls:()=>calls
    });
  `);
  app.whenReady().then(async () => {
    let win;
    try {
      win=new BrowserWindow({show:false,width:1280,height:800,webPreferences:{preload,contextIsolation:true,nodeIntegration:false,sandbox:true}});
      let networkRequests=0;
      win.webContents.session.webRequest.onBeforeRequest((details,callback)=>{
        const external=/^https?:/.test(details.url);if(external)networkRequests++;
        callback({cancel:external});
      });
      await win.loadFile(path.join(__dirname,'..','desktop','shell.html'));
      const run=source=>win.webContents.executeJavaScript(source);
      for(let i=0;i<50;i++){
        if(await run('document.querySelectorAll(".tab").length===2'))break;
        await new Promise(resolve=>setTimeout(resolve,10));
      }
      assert.equal(await run('document.querySelectorAll(".tab").length'),2);
      assert.equal(await run(`(()=>{
        window.__alpha=document.querySelector('.tab');window.__alpha.focus();
        const next=window.__fixture.state();next.downloads=[{id:'download',received:20,total:100,state:'progressing'}];
        window.__fixture.update(next);
        return document.querySelector('.tab')===window.__alpha&&document.activeElement===window.__alpha;
      })()`),true,'download updates preserve tab nodes and keyboard focus');
      assert.equal(await run(`(()=>{
        const next=window.__fixture.state();next.tabs[0].loading=true;next.tabs[0].title='Loading Alpha';window.__fixture.update(next);
        return document.querySelector('.tab')===window.__alpha&&window.__alpha.querySelector('.tab-title').textContent==='Loading Alpha';
      })()`),true,'tab state changes update the existing node');
      const privacy=await run(`(()=>{
        const next=window.__fixture.state();Object.assign(next.tabs[0],{private:true,privateMode:'tor',networkStatus:'connecting',loading:false,favicon:'https://example.test/favicon.png'});window.__fixture.update(next);
        const chrome=document.querySelector('.chrome').getBoundingClientRect();const notice=document.getElementById('private-notice').getBoundingClientRect();
        return {badge:document.getElementById('private-label').textContent,iconCount:window.__alpha.querySelectorAll('img').length,chromeBottom:chrome.bottom,noticeTop:notice.top,noticeBottom:notice.bottom};
      })()`);
      assert.equal(privacy.badge,'TOR CONNECTING');assert.equal(privacy.iconCount,0);
      assert.equal(privacy.chromeBottom,106);assert.ok(privacy.noticeTop>=0&&privacy.noticeBottom<=44,'privacy notice stays within tabbar above native page');
      assert.equal(await run(`(()=>{const next=window.__fixture.state();next.tabs[0].networkStatus='connected';window.__fixture.update(next);return document.getElementById('private-label').textContent;})()`),'TOR ROUTED');
      assert.equal(await run(`(()=>{const next=window.__fixture.state();next.tabs[0].networkStatus='error';window.__fixture.update(next);return document.getElementById('private-label').textContent;})()`),'TOR UNAVAILABLE');
      assert.equal(await run(`(()=>{const next=window.__fixture.state();next.tabs[0].privateMode='device';next.tabs[0].networkStatus=null;window.__fixture.update(next);return !document.getElementById('private-notice').hidden&&document.getElementById('private-notice-detail').textContent.includes('network still see traffic');})()`),true);
      const calls=await run(`(async()=>{
        const next=window.__fixture.state();next.tabs.reverse();window.__fixture.update(next);
        document.querySelector('.tab').dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true}));
        document.querySelector('.tab .tab-mute').click();
        await new Promise(resolve=>setTimeout(resolve,10));return window.__fixture.calls();
      })()`);
      assert.ok(calls.some(call=>call.action==='tab-menu'&&call.payload.id==='beta'),'context menu keeps clicked tab ID after reorder');
      assert.ok(calls.some(call=>call.action==='mute-tab'&&call.payload.id==='beta'&&call.payload.muted===false),'unmute keeps clicked tab ID');
      const panel=await run(`(async()=>{document.getElementById('menu-button').click();await new Promise(resolve=>setTimeout(resolve,20));return {visible:!document.getElementById('overlay').hidden,title:document.getElementById('panel-title').textContent,zooms:document.querySelectorAll('.zoom-control button').length};})()`);
      assert.equal(panel.visible,true,'opening settings is not undone by an earlier stop-find response');
      assert.equal(panel.title,'Settings');assert.equal(panel.zooms,3);
      win.setContentSize(900,650);
      const narrowGeometry=await run('({chrome:document.querySelector(".chrome").getBoundingClientRect().bottom,notice:document.getElementById("private-notice").getBoundingClientRect().bottom,toolbar:document.querySelector(".toolbar").getBoundingClientRect().bottom})');
      assert.equal(narrowGeometry.chrome,106);assert.equal(narrowGeometry.toolbar,106);assert.ok(narrowGeometry.notice<=44);
      assert.equal(networkRequests,0,'renderer never fetches a private or arbitrary favicon URL');
      console.log('Renderer checks passed: tab identity/focus, private/Tor status gates, chrome geometry, target IDs, settings zoom, no remote favicon requests.');
      win.destroy();app.exit(0);
    } catch(error) {
      console.error(error.stack||error);win?.destroy();app.exit(1);
    }
  });
} else {
  const test=require('node:test');
  const {spawn}=require('node:child_process');
  test('Renderer preserves tab nodes and displays truthful private/Tor states',{timeout:30000},async t=>{
    const executable=require('electron');
    const fixture=fs.mkdtempSync(path.join(os.tmpdir(),'turbobrowser-shell-test-'));
    t.after(()=>{
      const resolved=path.resolve(fixture);
      if(path.dirname(resolved)===path.resolve(os.tmpdir())&&path.basename(resolved).startsWith('turbobrowser-shell-test-')) fs.rmSync(resolved,{recursive:true,force:true,maxRetries:3,retryDelay:100});
    });
    const env={...process.env,TURBO_SHELL_FIXTURE:'1',TURBO_SHELL_FIXTURE_DIRECTORY:fixture};delete env.ELECTRON_RUN_AS_NODE;
    const result=await new Promise((resolve,reject)=>{
      const child=spawn(executable,[__filename],{env,windowsHide:true,stdio:['ignore','pipe','pipe']});
      let output='';child.stdout.on('data',chunk=>output+=chunk);child.stderr.on('data',chunk=>output+=chunk);
      child.once('error',reject);child.once('exit',code=>resolve({code,output}));
    });
    assert.equal(result.code,0,result.output);assert.match(result.output,/Renderer checks passed/);
  });
}

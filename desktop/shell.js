'use strict';
const $ = (id) => document.getElementById(id);
const api = window.turbo;
let state = {tabs: [], bookmarks: [], history: [], downloads: [], settings: {searchEngine:'duckduckgo',theme:'dark'}};
let panel = null;
let toastTimer;
let panelSnapshot = '';
let tabsSnapshot = '';
let bookmarksSnapshot = '';
const shownStorageErrors = new Set();
const tabNodes = new Map();
const shortcuts = [
  ['Wikipedia','https://wikipedia.org','W'], ['YouTube','https://youtube.com','▶'],
  ['GitHub','https://github.com','⌘'], ['Reddit','https://reddit.com','r'],
  ['DuckDuckGo','https://duckduckgo.com','D'],
];
function el(tag, cls, text) { const node=document.createElement(tag); if(cls) node.className=cls; if(text!==undefined) node.textContent=text; return node; }
function notify(message) { $('toast').textContent=message; $('toast').hidden=false; clearTimeout(toastTimer); toastTimer=setTimeout(()=>$('toast').hidden=true,3200); }
async function command(action,payload) { try { const result=await api.command(action,payload); if(result?.tabs) render(result); return result; } catch(error) { notify(error.message||'That action could not be completed.'); } }
const active = () => state.tabs.find(tab=>tab.id===state.activeId);
const hostname = (value) => { try {return new URL(value).hostname.replace(/^www\./,'');} catch{return value;} };
const bind = (id,action,payload) => $(id).addEventListener('click',()=>command(action,payload));

function renderTabs() {
  const snapshot=JSON.stringify([state.activeId,state.tabs.map(item=>[item.id,item.title,item.url,item.loading,item.private,item.favicon,item.muted,item.suspended,item.privateMode,item.networkStatus])]);
  if(snapshot===tabsSnapshot) return;
  tabsSnapshot=snapshot;
  const container=$('tabs');
  const ids=new Set(state.tabs.map(item=>item.id));
  for(const [id,entry] of tabNodes) if(!ids.has(id)) {entry.node.remove();tabNodes.delete(id);}
  state.tabs.forEach((item,index)=>{
    let entry=tabNodes.get(item.id);
    if(!entry) {
      const id=item.id;
      const node=el('div','tab');node.setAttribute('role','tab');
      const symbol=el('span','tab-symbol');symbol.setAttribute('aria-hidden','true');
      const title=el('span','tab-title');
      const mute=el('button','tab-mute','🔇');mute.title='Unmute tab';mute.setAttribute('aria-label','Unmute tab');
      mute.addEventListener('click',event=>{event.stopPropagation();command('mute-tab',{id,muted:false});});
      const close=el('button','tab-close','×');
      close.addEventListener('click',event=>{event.stopPropagation();command('close-tab',{id});});
      node.append(symbol,title,mute,close);
      node.addEventListener('click',()=>command('switch-tab',{id}));
      node.addEventListener('auxclick',event=>{if(event.button===1){event.preventDefault();command('close-tab',{id});}});
      node.addEventListener('contextmenu',event=>{event.preventDefault();command('tab-menu',{id});});
      node.addEventListener('keydown',event=>{
        if(event.target!==node) return;
        if(event.key==='Enter'||event.key===' '){event.preventDefault();command('switch-tab',{id});}
        if(event.key==='ArrowRight'||event.key==='ArrowLeft'){
          event.preventDefault();const current=state.tabs.findIndex(tab=>tab.id===id);
          const next=state.tabs[(current+(event.key==='ArrowRight'?1:-1)+state.tabs.length)%state.tabs.length];
          if(next) command('switch-tab',{id:next.id}).then(()=>tabNodes.get(next.id)?.node.focus());
        }
        if(event.key==='ContextMenu'||(event.shiftKey&&event.key==='F10')){event.preventDefault();command('tab-menu',{id});}
      });
      entry={node,symbol,title,mute,close,snapshot:''};tabNodes.set(id,entry);
    }
    const selected=item.id===state.activeId;
    const itemSnapshot=JSON.stringify([item.title,item.url,item.loading,item.private,item.favicon,item.muted,item.suspended,item.privateMode,item.networkStatus,selected]);
    if(entry.snapshot!==itemSnapshot) {
      entry.snapshot=itemSnapshot;
      entry.node.className='tab'+(item.loading?' is-loading':'')+(item.private?' is-private':'')+(item.privateMode==='tor'?' is-tor':'')+(item.suspended?' is-suspended':'');
      entry.node.setAttribute('aria-selected',String(selected));entry.node.tabIndex=selected?0:-1;
      const privacyTitle=item.privateMode==='tor'?(item.networkStatus==='connected'?'Tor routed · Your network can still see Tor in use':item.networkStatus==='error'?'Tor unavailable · Page traffic blocked':'Tor connecting · Waiting before browsing'):item.private?'Device private · Your network can still see traffic':'';
      entry.node.title=(item.title||'New tab')+'\n'+item.url+(privacyTitle?'\n'+privacyTitle:'')+(item.muted?'\nMuted':'');
      entry.title.textContent=item.title||'New tab';entry.mute.hidden=!item.muted;
      entry.close.setAttribute('aria-label','Close '+(item.title||'tab'));
      const favicon=!item.private&&!item.loading&&/^data:image\/(png|jpeg|gif|webp);base64,/i.test(item.favicon||'')?item.favicon:null;
      if(favicon) {
        if(entry.symbol.firstChild?.tagName!=='IMG'||entry.symbol.firstChild.getAttribute('src')!==favicon) {
          const image=el('img','tab-favicon');image.alt='';image.src=favicon;image.decoding='async';
          image.addEventListener('error',()=>{if(image.isConnected)entry.symbol.textContent='✦';},{once:true});
          entry.symbol.replaceChildren(image);
        }
      } else entry.symbol.textContent=item.privateMode==='tor'?'◎':item.private?'◈':item.loading?'◌':item.suspended?'○':'✦';
    }
    if(container.children[index]!==entry.node) container.insertBefore(entry.node,container.children[index]||null);
  });
}

function render(next) {
  state=next;
  if(panel && state.overlayOpen===false) { panel=null; $('overlay').hidden=true; }
  const tab=active();
  const tor=tab?.privateMode==='tor';
  const torReady=tor&&tab.networkStatus==='connected';
  const torError=tor&&tab.networkStatus==='error';
  document.documentElement.dataset.theme=state.settings.theme;
  document.title=(tab?.title||'New tab')+' — TurboBrowser';
  renderTabs();
  if(document.activeElement!==$('address')) $('address').value=tab?.url==='turbo://newtab'?'':tab?.url||'';
  $('back').disabled=!tab?.canGoBack; $('forward').disabled=!tab?.canGoForward;
  $('reload').textContent=tab?.loading?'×':'↻'; $('reload').setAttribute('aria-label',tab?.loading?'Stop loading':'Reload');
  $('load-progress').hidden=!tab?.loading;
  const saved=state.bookmarks.some(item=>item.url===tab?.url);
  $('bookmark').textContent=saved?'★':'☆'; $('bookmark').classList.toggle('saved',saved);
  $('bookmark').disabled=!tab||tab.url==='turbo://newtab'||!!tab.error;
  $('bookmark').setAttribute('aria-label',saved?'Remove bookmark':'Bookmark this page');
  const secure=tab?.url?.startsWith('https:');
  $('site-info').textContent=tab?.private?'◈':secure?'◇':tab?.url==='turbo://newtab'?'✦':'ⓘ';
  $('site-info').title=secure?'Connection uses HTTPS':tab?.url==='turbo://newtab'?'Local browser page':'Connection is not encrypted with HTTPS';
  $('private-label').hidden=!tab?.private;
  $('private-notice').hidden=!tab?.private;
  document.documentElement.classList.toggle('device-private',!!tab?.private);
  document.documentElement.classList.toggle('tor-private',tor);
  const privacyLabel=tor?(torReady?'Tor routed':torError?'Tor unavailable':'Tor connecting'):'Device private';
  const privacyDetail=tor?(torReady?'Network can see Tor in use':torError?'Page traffic blocked':'Waiting before browsing'):'Websites & network still see traffic';
  const privacyExplanation=tor?'Tor routes this tab’s destination requests once connected. Your local network can still see Tor in use. Tor may be slower; this is not the full Tor Browser and does not provide its anonymity guarantees.':'Temporary session. History stays off this device; websites, your internet provider, and your network can still see activity.';
  $('private-label').textContent=privacyLabel.toUpperCase();$('private-label').title=privacyExplanation;
  $('private-notice-title').textContent=privacyLabel;$('private-notice-detail').textContent=privacyDetail;$('private-notice').title=privacyExplanation;
  $('newtab').hidden=!!panel||tab?.url!=='turbo://newtab'||!!tab?.error;
  $('error-page').hidden=!!panel||!tab?.error;
  $('error-message').textContent=tab?.error||'';
  const privateView=JSON.stringify([!!tab?.private,tor,tab?.networkStatus]);
  if($('welcome').dataset.private!==privateView) {
    $('welcome').dataset.private=privateView;
    const welcome=tor?(torReady?'Browse through Tor':torError?'Tor isn’t ready':'Connecting to Tor'):tab?.private?'Private on this device':'Where to next';
    $('welcome').replaceChildren(document.createTextNode(welcome),el('span','',tab?.private?'.':'?'));
    $('intro').textContent=tor?(torReady?'This tab routes destination requests through Tor. Your network can still see Tor in use. It may be slower and is not the full Tor Browser.':torError?'A Tor connection could not be established. This tab blocks page traffic instead of falling back to a direct connection.':'Waiting for a Tor connection before sending this tab’s page requests. Your local network can still see Tor in use.'):(tab?.private?'This temporary session skips saved history. Websites, your internet provider, and your network can still see activity.':'One address. A whole world to explore.');
    $('greeting').textContent=tor?'TOR PRIVATE · '+privacyLabel.toUpperCase():tab?.private?'DEVICE PRIVATE · TEMPORARY SESSION':'A LITTLE CURIOSITY GOES A LONG WAY';
  }
  $('engine').value=state.settings.searchEngine;
  $('engine-version').textContent='CHROMIUM '+(state.versions?.chromium?.split('.')[0]||'POWERED');
  $('app-version').textContent=state.versions?.app||'0.3.0';
  $('maximize').textContent=state.isMaximized?'❐':'□';
  $('maximize').setAttribute('aria-label',state.isMaximized?'Restore window':'Maximize');
  const nextBookmarks=JSON.stringify(state.bookmarks.slice(0,6));
  if(nextBookmarks!==bookmarksSnapshot) {
    bookmarksSnapshot=nextBookmarks;
    const bookmarks=state.bookmarks.slice(0,6).map(item=>{const button=el('button','bookmark-chip','☆  '+(item.title||hostname(item.url)));button.title=item.url;button.addEventListener('click',()=>navigate(item.url));return button;});
    if(!bookmarks.length) {const hint=el('p','bookmark-hint','Good finds belong here. Press ');hint.append(el('kbd','','Ctrl D'),document.createTextNode(' to save a page.'));bookmarks.push(hint);}
    $('home-bookmarks').replaceChildren(...bookmarks);
  }
  if(state.findResult) $('find-count').textContent=state.findResult.matches?state.findResult.activeMatchOrdinal+'/'+state.findResult.matches:'0 matches';
  if(panel) {const snapshot=JSON.stringify([panel,state[panel],state.settings,state.storageError,tab?.id,tab?.url,tab?.zoom,tab?.privateMode,tab?.networkStatus]);if(snapshot!==panelSnapshot){panelSnapshot=snapshot;renderPanel();}}
  if(state.storageError && !shownStorageErrors.has(state.storageError)) {shownStorageErrors.add(state.storageError);notify(state.storageError);}
}

async function navigate(value) {
  if(!value?.trim()) return;
  await closePanel(); await closeFind(); await command('navigate',{value});
  $('address').blur(); $('search').value='';
}
function focusAddress() { $('address').focus(); $('address').select(); }
async function openPanel(name) {
  await closeFind(); panel=name; panelSnapshot=''; $('overlay').hidden=false;
  await command('set-overlay',{open:true}); renderPanel();
  $('close-panel').focus();
}
async function closePanel() {
  if(!panel) return;
  panel=null; $('overlay').hidden=true; await command('set-overlay',{open:false});
}
const panelDescriptions = {
  bookmarks:['YOUR COLLECTION','Good pages. Kept close.'],
  history:['RECENTLY EXPLORED','Your recent pages, stored on this device. Private tabs stay out of this list.'],
  downloads:['SAVED TO YOUR DEVICE','Files downloaded through TurboBrowser. Show a completed file in its folder.'],
  settings:['MAKE IT YOURS','A few thoughtful controls for a browser that feels like you.']
};
function renderPanel() {
  if(!panel) return;
  $('panel-title').textContent=panel[0].toUpperCase()+panel.slice(1);
  $('panel-eyebrow').textContent=panelDescriptions[panel][0]; $('panel-description').textContent=panelDescriptions[panel][1];
  document.querySelectorAll('[data-panel]').forEach(button=>button.classList.toggle('active',button.dataset.panel===panel));
  const filter=$('panel-search'); filter.hidden=panel==='settings';
  filter.placeholder='Filter your '+panel; const query=filter.value.toLowerCase();
  const content=$('panel-content'); content.replaceChildren();
  if(panel==='settings') { renderSettings(content);return; }
  const records=(state[panel]||[]).filter(item=>JSON.stringify(item).toLowerCase().includes(query));
  if(!records.length) {
    const empty=el('div','empty-state'); empty.append(el('strong','',query?'Nothing matches that search.':{bookmarks:'Your next great find goes here.',history:'A fresh start.',downloads:'No downloads yet.'}[panel]),el('span','',query?'Try a different word.':{bookmarks:'Visit a page and press Ctrl+D to bookmark it.',history:'Pages you visit will appear here.',downloads:'Download a file from a website to see its progress here.'}[panel]));
    content.append(empty);
  }
  for(const item of records) {
    const row=el('div','list-row'); row.append(el('span','row-icon',panel==='downloads'?'↓':panel==='history'?'↶':'☆'));
    const title=panel==='downloads'?item.filename:item.title||hostname(item.url);
    const link=el(panel==='downloads'?'div':'button','row-link');link.append(el('strong','',title));
    let detail=item.url;
    if(panel==='history') detail=hostname(item.url)+' · '+new Date(item.visitedAt).toLocaleString([],{dateStyle:'medium',timeStyle:'short'});
    if(panel==='downloads') detail=item.state==='progressing'?formatBytes(item.received)+' / '+formatBytes(item.total):item.state==='completed'?'Completed · '+formatBytes(item.total):item.state;
    link.append(el('small','',detail)); if(panel!=='downloads') link.addEventListener('click',()=>navigate(item.url)); row.append(link);
    if(panel==='bookmarks'){const remove=el('button','row-action','Remove');remove.setAttribute('aria-label','Remove '+title);remove.addEventListener('click',()=>command('remove-bookmark',{url:item.url}));row.append(remove);}
    if(panel==='downloads'&&item.state==='completed'){const show=el('button','row-action','Show in folder ↗');show.addEventListener('click',()=>command('open-download',{id:item.id}));row.append(show);}
    content.append(row);
  }
  if((panel==='history'||panel==='downloads')&&state[panel]?.length){const clear=el('button','section-action',panel==='history'?'Clear browsing history':'Clear completed download list');clear.addEventListener('click',()=>{command(panel==='history'?'clear-history':'clear-downloads');notify(panel==='history'?'Browsing history cleared.':'Completed downloads removed from the list.');});content.append(clear);}
}
function formatBytes(value){if(!value) return '0 B';const unit=Math.min(3,Math.floor(Math.log(value)/Math.log(1024)));return (value/1024**unit).toFixed(unit?1:0)+' '+['B','KB','MB','GB'][unit];}
function renderSettings(content) {
  if(state.storageError) { const warning=el('p','profile-warning',state.storageError);warning.setAttribute('role','status');content.append(warning); }
  const page=active();
  const pageTools=el('div','page-tools');
  const pageLabel=el('div','page-tools-label');pageLabel.append(el('strong','','Current page'),el('small','',page?.url==='turbo://newtab'?'New tab':hostname(page?.url||'')));
  const zoom=el('div','zoom-control');zoom.setAttribute('role','group');zoom.setAttribute('aria-label','Page zoom');
  const zoomOut=el('button','','−');zoomOut.title='Zoom out (Ctrl+−)';zoomOut.setAttribute('aria-label','Zoom out');zoomOut.addEventListener('click',()=>command('zoom-out'));
  const zoomLevel=el('button','zoom-level',Math.round((Number(page?.zoom)||1)*100)+'%');zoomLevel.title='Reset zoom (Ctrl+0)';zoomLevel.setAttribute('aria-label','Reset page zoom to 100 percent');zoomLevel.addEventListener('click',()=>command('zoom-reset'));
  const zoomIn=el('button','','+');zoomIn.title='Zoom in (Ctrl++)';zoomIn.setAttribute('aria-label','Zoom in');zoomIn.addEventListener('click',()=>command('zoom-in'));
  for(const button of [zoomOut,zoomLevel,zoomIn]) button.disabled=!page||page.url==='turbo://newtab'||!!page.error;
  zoom.append(zoomOut,zoomLevel,zoomIn);
  const findPage=el('button','page-tool','Find in page');findPage.disabled=!page||page.url==='turbo://newtab'||!!page.error;findPage.addEventListener('click',async()=>{await closePanel();openFind();});
  pageTools.append(pageLabel,zoom,findPage);content.append(pageTools);
  const setting=(name,description,control)=>{const row=el('div','setting-row');const text=el('div');const label=el('label','',name);label.htmlFor=control.id;text.append(label,el('p','',description));row.append(text,control);content.append(row);};
  const theme=el('select');theme.id='theme-setting'; for(const [value,title] of [['dark','Forest dark'],['light','Daylight']]){const option=el('option','',title);option.value=value;theme.append(option);}theme.value=state.settings.theme;theme.addEventListener('change',()=>command('settings',{theme:theme.value}));setting('Appearance','Set the tone for your browser.',theme);
  const engine=$('engine').cloneNode(true);engine.id='engine-setting';engine.value=state.settings.searchEngine;engine.addEventListener('change',()=>command('settings',{searchEngine:engine.value}));setting('Search engine','Used when you type a search in the address bar.',engine);
  const restore=el('input');restore.type='checkbox';restore.id='restore-setting';restore.checked=!!state.settings.restoreSession;restore.addEventListener('change',()=>command('settings',{restoreSession:restore.checked}));setting('Pick up where you left off','Restore regular tab addresses when you reopen TurboBrowser. Background tabs load when you select them. Private tabs are never restored.',restore);
  const privateButton=el('button','setting-button','Open device-private tab');privateButton.id='private-setting';privateButton.addEventListener('click',async()=>{await closePanel();await command('new-tab',{private:true});focusAddress();});setting('Device-private browsing','Temporary session with no saved history. It does not hide your IP address or traffic from websites, your internet provider, or your network.',privateButton);
  const torButton=el('button','setting-button tor-setting','Open Tor private tab');torButton.id='tor-setting';torButton.addEventListener('click',async()=>{await closePanel();await command('new-tab',{private:true,tor:true});focusAddress();});setting('Tor private tabs','Route destination requests through Tor after it connects. Your network can see Tor in use; browsing may be slower. This is not the full Tor Browser and does not provide its anonymity guarantees.',torButton);
  const about=el('div','about-card'); about.append(el('strong','','TurboBrowser '+(state.versions?.app||'0.3.0')),el('p','','Chromium '+(state.versions?.chromium||'')+' · Electron '+(state.versions?.electron||'')),el('p','','Pages render in this app’s own Chromium tabs. Bookmarks, history, and settings are stored on your device. Device-private tabs use a temporary session; they do not make you anonymous to websites or your network.'),el('p','','This build is unsigned and has no automatic updates. Websites request permission before using supported camera, microphone, location, or notification features. Some DRM video and sign-in services may be unavailable.'));
  const source=el('button','section-action','View source on GitHub ↗');source.addEventListener('click',()=>navigate('https://github.com/TurboTwitch0/turbo-browser-native'));about.append(source);content.append(about);
}
function openFind(){if(active()?.url==='turbo://newtab'||active()?.error) return;$('findbar').hidden=false;$('find-input').focus();$('find-input').select();}
async function closeFind(){const wasOpen=!$('findbar').hidden;$('findbar').hidden=true;if(wasOpen)await command('stop-find');}
function find(forward=true){const text=$('find-input').value;if(text) command('find',{text,forward});else command('stop-find');}

for(const [name,url,initial] of shortcuts){const button=el('button','quicklink');button.append(el('span','site-initial',initial),el('span','',name));button.addEventListener('click',()=>navigate(url));$('quicklinks').append(button);}
$('address-form').addEventListener('submit',event=>{event.preventDefault();navigate($('address').value);});
$('search-form').addEventListener('submit',event=>{event.preventDefault();navigate($('search').value);});
$('address').addEventListener('focus',()=>{$('address').select();});
$('engine').addEventListener('change',()=>command('settings',{searchEngine:$('engine').value}));
bind('new-tab','new-tab');bind('back','back');bind('forward','forward');bind('home','home');bind('bookmark','bookmark');
bind('minimize','minimize');bind('maximize','maximize');bind('close-window','close-window');bind('retry','reload');bind('error-home','home');
$('reload').addEventListener('click',()=>command(active()?.loading?'stop':'reload'));
for(const [id,name] of [['downloads-button','downloads'],['bookmarks-button','bookmarks'],['all-bookmarks','bookmarks'],['menu-button','settings'],['settings-button','settings']]) $(id).addEventListener('click',()=>{if(panel===name) closePanel();else openPanel(name);});
document.querySelectorAll('[data-panel]').forEach(button=>button.addEventListener('click',()=>{$('panel-search').value='';openPanel(button.dataset.panel);}));
$('private-tab').addEventListener('click',async()=>{await closePanel();await command('new-tab',{private:true});focusAddress();});
$('tor-private-tab').addEventListener('click',async()=>{await closePanel();await command('new-tab',{private:true,tor:true});focusAddress();});
$('close-panel').addEventListener('click',closePanel);$('panel-search').addEventListener('input',renderPanel);
$('find-input').addEventListener('input',()=>find());$('find-input').addEventListener('keydown',event=>{if(event.key==='Enter'){event.preventDefault();find(!event.shiftKey);}});
$('find-next').addEventListener('click',()=>find());$('find-previous').addEventListener('click',()=>find(false));$('find-close').addEventListener('click',closeFind);
document.addEventListener('keydown',event=>{if(event.key==='Escape'){closePanel();closeFind();$('address').blur();}});
api.onState(render);
api.onShortcut(action=>{if(action==='focus-address') focusAddress();if(action==='find') openFind();if(action==='history') openPanel('history');if(action==='downloads') openPanel('downloads');if(action==='toggle-bookmarks') panel==='bookmarks'?closePanel():openPanel('bookmarks');if(action==='escape'){closePanel();closeFind();$('address').blur();}});
command('get-state');
function updateClock(){$('clock').textContent=new Date().toLocaleDateString([],{weekday:'short',month:'short',day:'numeric'}).toUpperCase()+'  /  '+new Date().toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'});}
updateClock();setInterval(updateClock,30000);

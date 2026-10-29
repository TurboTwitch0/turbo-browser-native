'use strict';
const $ = (id) => document.getElementById(id);
const api = window.turbo;
let state = {tabs: [], bookmarks: [], history: [], downloads: [], settings: {searchEngine:'duckduckgo',theme:'dark'}};
let panel = null;
let toastTimer;
let panelSnapshot = '';
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

function render(next) {
  state=next;
  if(panel && state.overlayOpen===false) { panel=null; $('overlay').hidden=true; }
  const tab=active();
  document.documentElement.dataset.theme=state.settings.theme;
  document.title=(tab?.title||'New tab')+' — Turbo Browser';
  const fragment=document.createDocumentFragment();
  for(const item of state.tabs) {
    const node=el('div','tab'+(item.loading?' is-loading':''));
    node.setAttribute('role','tab'); node.setAttribute('aria-selected',String(item.id===state.activeId));
    node.setAttribute('tabindex',item.id===state.activeId?'0':'-1'); node.title=item.title+'\n'+item.url;
    node.append(el('span','tab-symbol',item.private?'◈':item.loading?'◌':'✦'),el('span','tab-title',item.title||'New tab'));
    const close=el('button','tab-close','×'); close.setAttribute('aria-label','Close '+(item.title||'tab'));
    close.addEventListener('click',event=>{event.stopPropagation();command('close-tab',{id:item.id});});
    node.append(close); node.addEventListener('click',()=>command('switch-tab',{id:item.id}));
    node.addEventListener('auxclick',event=>{if(event.button===1) command('close-tab',{id:item.id});});
    node.addEventListener('keydown',event=>{if(event.key==='Enter'||event.key===' '){event.preventDefault();command('switch-tab',{id:item.id});}if(event.key==='ArrowRight'||event.key==='ArrowLeft'){event.preventDefault();const index=state.tabs.indexOf(item);command('switch-tab',{id:state.tabs[(index+(event.key==='ArrowRight'?1:-1)+state.tabs.length)%state.tabs.length].id});}});
    fragment.append(node);
  }
  // Keep the address caret and selected tab focus intact during loading events.
  const focusedTab=document.activeElement?.getAttribute('role')==='tab';
  $('tabs').replaceChildren(fragment); if(focusedTab) $('tabs').querySelector('[aria-selected=true]')?.focus();
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
  $('newtab').hidden=!!panel||tab?.url!=='turbo://newtab'||!!tab?.error;
  $('error-page').hidden=!!panel||!tab?.error;
  $('error-message').textContent=tab?.error||'';
  $('welcome').replaceChildren(document.createTextNode(tab?.private?'A little more private':'Where to next'),el('span','',tab?.private?'.':'?'));
  $('intro').textContent=tab?.private?'This tab keeps history off your device. Your network can still see traffic.':'One address. A whole world to explore.';
  $('greeting').textContent=tab?.private?'PRIVATE TAB · SEPARATE TEMPORARY SESSION':'A LITTLE CURIOSITY GOES A LONG WAY';
  $('engine').value=state.settings.searchEngine;
  $('engine-version').textContent='CHROMIUM '+(state.versions?.chromium?.split('.')[0]||'POWERED');
  $('maximize').textContent=state.isMaximized?'❐':'□';
  $('maximize').setAttribute('aria-label',state.isMaximized?'Restore window':'Maximize');
  const bookmarks=state.bookmarks.slice(0,6).map(item=>{const button=el('button','bookmark-chip','☆  '+(item.title||hostname(item.url)));button.title=item.url;button.addEventListener('click',()=>navigate(item.url));return button;});
  if(!bookmarks.length) {const hint=el('p','bookmark-hint','Good finds belong here. Press ');hint.append(el('kbd','','Ctrl D'),document.createTextNode(' to save a page.'));bookmarks.push(hint);}
  $('home-bookmarks').replaceChildren(...bookmarks);
  if(state.findResult) $('find-count').textContent=state.findResult.matches?state.findResult.activeMatchOrdinal+'/'+state.findResult.matches:'0 matches';
  if(panel) {const snapshot=JSON.stringify([panel,state[panel],state.settings]);if(snapshot!==panelSnapshot){panelSnapshot=snapshot;renderPanel();}}
  if(state.storageError) notify('Your changes could not be saved: '+state.storageError);
}

async function navigate(value) {
  if(!value?.trim()) return;
  await closePanel(); closeFind(); await command('navigate',{value});
  $('address').blur(); $('search').value='';
}
function focusAddress() { $('address').focus(); $('address').select(); }
async function openPanel(name) {
  closeFind(); panel=name; panelSnapshot=''; $('overlay').hidden=false;
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
  downloads:['SAVED TO YOUR DEVICE','Files downloaded through Turbo Browser. Show a completed file in its folder.'],
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
  const setting=(name,description,control)=>{const row=el('div','setting-row');const text=el('div');const label=el('label','',name);label.htmlFor=control.id;text.append(label,el('p','',description));row.append(text,control);content.append(row);};
  const theme=el('select');theme.id='theme-setting'; for(const [value,title] of [['dark','Forest dark'],['light','Daylight']]){const option=el('option','',title);option.value=value;theme.append(option);}theme.value=state.settings.theme;theme.addEventListener('change',()=>command('settings',{theme:theme.value}));setting('Appearance','Set the tone for your browser.',theme);
  const engine=$('engine').cloneNode(true);engine.id='engine-setting';engine.value=state.settings.searchEngine;engine.addEventListener('change',()=>command('settings',{searchEngine:engine.value}));setting('Search engine','Used when you type a search in the address bar.',engine);
  const restore=el('input');restore.type='checkbox';restore.id='restore-setting';restore.checked=!!state.settings.restoreSession;restore.addEventListener('change',()=>command('settings',{restoreSession:restore.checked}));setting('Pick up where you left off','Restore regular tab addresses when you reopen Turbo Browser. Private tabs are never restored.',restore);
  const about=el('div','about-card'); about.append(el('strong','','Turbo Browser 0.1.0'),el('p','','Chromium '+(state.versions?.chromium||'')+' · Electron '+(state.versions?.electron||'')),el('p','','Pages render in this app’s own Chromium tabs. Bookmarks, history, and settings are stored on your device. Private tabs use a temporary session; they do not make you anonymous to websites or your network.'),el('p','','This first release is unsigned and has no automatic updates. Websites request permission before using supported camera, microphone, location, or notification features. Some DRM video and sign-in services may be unavailable.'));
  const source=el('button','section-action','View source on GitHub ↗');source.addEventListener('click',()=>navigate('https://github.com/TurboTwitch0/turbo-browser-native'));about.append(source);content.append(about);
}
function openFind(){if(active()?.url==='turbo://newtab'||active()?.error) return;$('findbar').hidden=false;$('find-input').focus();$('find-input').select();}
function closeFind(){$('findbar').hidden=true;command('stop-find');}
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
$('close-panel').addEventListener('click',closePanel);$('panel-search').addEventListener('input',renderPanel);
$('find-input').addEventListener('input',()=>find());$('find-input').addEventListener('keydown',event=>{if(event.key==='Enter'){event.preventDefault();find(!event.shiftKey);}});
$('find-next').addEventListener('click',()=>find());$('find-previous').addEventListener('click',()=>find(false));$('find-close').addEventListener('click',closeFind);
document.addEventListener('keydown',event=>{if(event.key==='Escape'){closePanel();closeFind();$('address').blur();}});
api.onState(render);
api.onShortcut(action=>{if(action==='focus-address') focusAddress();if(action==='find') openFind();if(action==='history') openPanel('history');if(action==='downloads') openPanel('downloads');if(action==='toggle-bookmarks') panel==='bookmarks'?closePanel():openPanel('bookmarks');if(action==='escape'){closePanel();closeFind();$('address').blur();}});
command('get-state');
function updateClock(){$('clock').textContent=new Date().toLocaleDateString([],{weekday:'short',month:'short',day:'numeric'}).toUpperCase()+'  /  '+new Date().toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'});}
updateClock();setInterval(updateClock,30000);

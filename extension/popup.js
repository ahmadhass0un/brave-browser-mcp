'use strict';
const $ = id => document.getElementById(id);
const dot = $('dot');
const label = $('status-label');
const transportEl = $('status-transport');
const errorEl = $('error');
const verEl = $('ver');
const serverUrlEl = $('server-url');
const tabsEl = $('tabs');
const tabCountEl = $('tab-count');
const addrEl = $('addr');
const outEl = $('tool-out');
const browserInfoEl = $('browser-info');

verEl.textContent = 'v' + chrome.runtime.getManifest().version;

function setStatus(s) {
  const map = { connected:'Connected', waiting:'Waiting for MCP server…', reconnecting:'Reconnecting…', disconnected:'Disconnected' };
  const st = s.status === 'waiting' ? 'waiting' : (s.status || 'disconnected');
  dot.className = 'dot ' + (st === 'waiting' ? 'reconnecting' : st);
  label.textContent = map[st] || 'Waiting for MCP server…';
  transportEl.textContent = s.status==='connected' ? (s.transport||'') : (s.serverUrl ? s.serverUrl : '');
  // only show real errors, not transient waiting
  const showErr = s.error && st !== 'waiting';
  errorEl.textContent = showErr ? s.error : '';
  errorEl.style.display = showErr ? 'block' : 'none';
  serverUrlEl.textContent = s.serverUrl || '';
  serverUrlEl.title = s.serverUrl ? 'MCP server ' + s.serverUrl + ' — start with: node index.js' : '';
}

async function refreshStatus(){
  try{
    const res = await chrome.runtime.sendMessage({type:'getStatus'});
    if(res && res.ok!==false) setStatus(res);
    else setStatus({status:'waiting', error:'', serverUrl:'ws://127.0.0.1:9224'});
  }catch(e){
    setStatus({status:'waiting', error:'', serverUrl:'ws://127.0.0.1:9224'});
  }
}
async function refreshTabs(){
  try{
    let tabs = await chrome.tabs.query({});
    const filterEl = document.getElementById('popup-filter');
    const q = filterEl ? filterEl.value.trim().toLowerCase() : '';
    if(q) tabs = tabs.filter(t=> (t.title||'').toLowerCase().includes(q) || (t.url||'').toLowerCase().includes(q));
    if(addrEl){
      const active = tabs.find(t=>t.active);
      if(active) addrEl.value = active.url || '';
    }
    tabCountEl.textContent = `(${tabs.length})`;
    tabsEl.innerHTML = '';
    for(const t of tabs){
      const div = document.createElement('div');
      div.className = 'tab' + (t.active?' active':'');
      const fav = t.favIconUrl || '';
      const img = document.createElement('img');
      img.src = fav || 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><rect width="16" height="16" rx="3" fill="%233c4043"/></svg>';
      img.onerror = ()=> img.style.display='none';
      const title = document.createElement('div');
      title.className='title';
      title.textContent = t.title || t.url || 'Untitled';
      title.title = `${t.title}\n${t.url}`;
      const close = document.createElement('button');
      close.className='close'; close.textContent='×'; close.title='Close';
      close.onclick = e=>{ e.stopPropagation(); chrome.tabs.remove(t.id, refreshTabs); };
      div.append(img,title,close);
      div.onclick = ()=> chrome.tabs.update(t.id,{active:true}).then(()=> chrome.windows.update(t.windowId,{focused:true})).then(refreshTabs);
      tabsEl.appendChild(div);
    }
    if(!tabs.length) tabsEl.innerHTML='<div class="notice">No tabs</div>';
  }catch(e){
    tabsEl.innerHTML=`<div class="notice">Error: ${String(e).slice(0,120)}</div>`;
  }
}
function renderBrowserInfo(){
  const ua=navigator.userAgent;
  let name='Chromium';
  if(/Edg\//.test(ua)) name='Edge';
  else if(/OPR\//.test(ua)) name='Opera';
  else if(navigator.brave && navigator.brave.isBrave) name='Brave';
  else if(/Chrome\//.test(ua)) name='Chrome';
  const ver=(ua.match(/(?:Chrome|Edg|OPR)\/([\d.]+)/)||[])[1]||'unknown';
  const rows=[
    ['Browser', `${name} ${ver.split('.')[0]}`],
    ['Extension', `v${chrome.runtime.getManifest().version}`],
    ['Platform', navigator.userAgentData?.platform || navigator.platform],
  ];
  browserInfoEl.innerHTML = rows.map(([k,v])=>`<dt>${k}</dt><dd>${String(v)}</dd>`).join('');
}

async function navigate(url){
  if(!url) return;
  let to=url.trim();
  if(!/^https?:\/\//i.test(to) && !/^chrome:\/\//.test(to)) to='https://'+to;
  const [tab] = await chrome.tabs.query({active:true, currentWindow:true});
  if(tab) await chrome.tabs.update(tab.id,{url:to});
  else await chrome.tabs.create({url:to});
  setTimeout(refreshTabs, 800);
}

function showOut(text, isError=false){
  outEl.textContent = String(text).slice(0,1200);
  outEl.style.display='block';
  outEl.style.color = isError ? 'var(--err)' : 'var(--fg)';
}

// navigate removed — use browser address bar
if($('go') && addrEl){
  $('go').onclick = ()=> navigate(addrEl.value);
  addrEl.addEventListener('keydown', e=>{ if(e.key==='Enter') navigate(addrEl.value); });
}
if($('back')){
  $('back').onclick = async ()=>{
    const [tab]=await chrome.tabs.query({active:true, currentWindow:true});
    if(tab) { try{ await chrome.scripting.executeScript({target:{tabId:tab.id}, func:()=> history.back()}); }catch{}}
  };
}
if($('forward')){
  $('forward').onclick = async ()=>{
    const [tab]=await chrome.tabs.query({active:true, currentWindow:true});
    if(tab) { try{ await chrome.scripting.executeScript({target:{tabId:tab.id}, func:()=> history.forward()}); }catch{}}
  };
}
if($('reload')){
  $('reload').onclick = async ()=>{
    const [tab]=await chrome.tabs.query({active:true, currentWindow:true});
    if(tab) chrome.tabs.reload(tab.id);
  };
}
$('newtab').onclick = ()=> chrome.tabs.create({url:'chrome://newtab/'});
$('shot').onclick = async ()=>{
  showOut('Capturing…');
  const [tab]=await chrome.tabs.query({active:true, currentWindow:true});
  if(!tab) return showOut('No active tab',true);
  try{
    const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId,{format:'png'});
    showOut(`Screenshot captured (${Math.round(dataUrl.length/1024)} KB) — check data/screenshots`);
    // also try debugger for full page via background? fallback to captureVisibleTab is enough for popup
  }catch(e){ showOut(String(e),true); }
};
$('pdf').onclick = async ()=>{
  showOut('PDF via MCP server — use dashboard');
};
$('read').onclick = async ()=>{
  showOut('Reading…');
  const [tab]=await chrome.tabs.query({active:true, currentWindow:true});
  if(!tab) return;
  try{
    const res = await chrome.scripting.executeScript({target:{tabId:tab.id}, func:()=> document.body.innerText.slice(0,300)});
    showOut(res?.[0]?.result || '— no text —');
  }catch(e){ showOut(String(e),true); }
};
$('inspect').onclick = async ()=>{
  showOut('Inspecting…');
  const [tab]=await chrome.tabs.query({active:true, currentWindow:true});
  if(!tab) return showOut('No active tab', true);
  const url=tab.url||'';
  if(!/^https?:/.test(url)){
    showOut(`Cannot inspect ${url.slice(0,40)} — extension pages & chrome:// are blocked.\n\nOpen a https:// page first, then:\n• Popup → Inspect (here) or\n• Dashboard → Browser → pick tab → Quick actions`, true);
    return;
  }
  try{
    const res = await chrome.scripting.executeScript({target:{tabId:tab.id}, func:()=>{
      const q=[...document.querySelectorAll('a,button,input, [role="button"], [aria-label]')];
      const out=[];
      for(const e of q){
        if(out.length>=10) break;
        const r=e.getBoundingClientRect();
        if(r.width===0 && r.height===0) continue;
        const s=getComputedStyle(e);
        if(s.display==='none' || s.visibility==='hidden' || s.opacity==='0') continue;
        let label=(e.getAttribute('aria-label')||e.getAttribute('title')||e.innerText||e.value||e.placeholder||'').trim().replace(/\s+/g,' ').slice(0,40);
        if(!label) continue;
        out.push(`${e.tagName.toLowerCase()}${e.id?'#'+e.id:''} → “${label}”`);
      }
      if(out.length) return out.join('\n');
      // fallback: show page title + hint
      return `No labeled buttons/links found on ${location.hostname}\nTitle: "${document.title.slice(0,50)}"\nTry: Dashboard → Browser → pick this tab → Quick actions → List elements`;
    }});
    const txt=res?.[0]?.result;
    showOut(txt && txt.trim() ? txt : `No content — ${tab.url.slice(0,50)}`);
  }catch(e){
    const msg=String(e.message||e);
    if(/Cannot access contents/.test(msg) || /chrome:\/\//.test(msg)){
      showOut(`Blocked: ${url.slice(0,50)}\nUse a https:// tab`, true);
    } else showOut(msg, true);
  }
};
$('open-dashboard').onclick = async e=>{
  e.preventDefault();
  try{ await chrome.runtime.sendMessage({type:'openDashboard'});}catch{
    chrome.tabs.create({url: chrome.runtime.getURL('dashboard.html')});
  }
};
serverUrlEl.onclick = ()=>{
  if(serverUrlEl.textContent) navigator.clipboard.writeText(serverUrlEl.textContent).then(()=>{ const o=serverUrlEl.textContent; serverUrlEl.textContent='Copied!'; setTimeout(()=> serverUrlEl.textContent=o,900); });
};

// popup filter
const popupFilterEl = document.getElementById('popup-filter');
if(popupFilterEl) popupFilterEl.addEventListener('input', refreshTabs);

// init
refreshStatus();
refreshTabs();
renderBrowserInfo();
chrome.storage.onChanged.addListener(()=> refreshStatus());
setInterval(refreshStatus, 3000);
setInterval(refreshTabs, 4000);
chrome.tabs.onUpdated.addListener(refreshTabs);
chrome.tabs.onRemoved.addListener(refreshTabs);
chrome.tabs.onCreated.addListener(refreshTabs);
chrome.tabs.onActivated.addListener(refreshTabs);

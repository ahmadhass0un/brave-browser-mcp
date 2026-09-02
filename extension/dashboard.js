'use strict';
const $ = id => document.getElementById(id);
const ver = $('nav-ver');
ver.textContent = 'v' + chrome.runtime.getManifest().version;

const pages = [...document.querySelectorAll('.page')];
const navBtns = [...document.querySelectorAll('.nav-links button')];
function showPage(name){
  pages.forEach(p=> p.classList.toggle('active', p.id==='page-'+name));
  navBtns.forEach(b=> b.classList.toggle('active', b.dataset.page===name));
  if(name==='browser'){ refreshBrowser(); refreshQATabs(); }
  if(name==='captures') {} // gallery stays
}
navBtns.forEach(b=> b.onclick=()=> showPage(b.dataset.page));
document.querySelectorAll('[data-page-jump]').forEach(b=> b.onclick=()=> showPage(b.dataset.pageJump));

// ----- status -----
async function getStatus(){
  try{ return await chrome.runtime.sendMessage({type:'getStatus'});}catch{ return {status:'waiting', error:''}; }
}
async function refreshStatus(){
  const s = await getStatus();
  const map={connected:'Connected', waiting:'Waiting for MCP server…', reconnecting:'Reconnecting…', disconnected:'Disconnected'};
  const dot=$('ov-dot'), dot2=$('foot-dot');
  const label=$('ov-status'), footLabel=$('foot-label');
  const trans=$('ov-transport'), footTrans=$('foot-transport');
  const err=$('ov-error');
  const raw = s.status||'waiting';
  const cls = raw==='waiting' ? 'reconnecting' : raw;
  const txt = map[raw] || 'Waiting for MCP server…';
  dot.className='dot '+cls; dot2.className='dot '+cls;
  label.textContent = txt;
  footLabel.textContent = txt;
  trans.textContent = s.status==='connected' ? (s.transport||'') : (s.serverUrl||'');
  footTrans.textContent = s.status==='connected' ? (s.transport ? `· ${s.transport}` : '') : '';
  err.textContent = (s.error && raw!=='waiting') ? s.error : '';
  $('ov-url').textContent = s.serverUrl||'—';
  // health extra via tabs? try to get uptime etc via r
  try{
    const r = await chrome.runtime.sendMessage({type:'getBrowserState'});
    if(r && r.state){
      $('ov-browser').innerHTML = `<dt>Windows</dt><dd>${r.state.windows?.length||0}</dd><dt>Tabs</dt><dd>${r.state.tabs?.length||0}</dd><dt>Active</dt><dd>${r.state.activeTabId||'—'}</dd>`;
    }
  }catch{}
  // bookmarks/history counts via storage? use simple
  try{
    const br = await chrome.runtime.sendMessage({type:'getStatus'});
    $('ov-bm').textContent = br.bookmarks ?? '—';
    $('ov-hist').textContent = br.historyEntries ?? '—';
  }catch{}
  // also update footer url quickly
  if(s.serverUrl) $('set-url').value = s.serverUrl;
}
async function renderOverviewCur(){
  try{
    const [tab]=await chrome.tabs.query({active:true, currentWindow:true});
    if(!tab) return $('ov-cur').textContent='No active tab';
    $('ov-cur').innerHTML = `<div style="display:flex;gap:10px;align-items:center"><img src="${tab.favIconUrl||''}" style="width:20px;height:20px;border-radius:4px;background:var(--border)" onerror="this.style.display='none'"><div style="min-width:0"><div style="font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${tab.title||'—'}</div><div style="font-size:11px;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${tab.url}</div></div><span class="badge">${tab.status||''}</span></div>`;
  }catch{}
}
function renderBrowserInfo(){
  const ua=navigator.userAgent;
  let name='Chromium'; if(/Edg\//.test(ua)) name='Edge'; else if(/OPR\//.test(ua)) name='Opera'; else if(navigator.brave && navigator.brave.isBrave) name='Brave'; else if(/Chrome\//.test(ua)) name='Chrome';
  const ver=(ua.match(/(?:Chrome|Edg|OPR)\/([\d.]+)/)||[])[1]||'unknown';
  const rows=[['Browser',`${name} ${ver.split('.')[0]}`],['Full',ver],['Extension',`v${chrome.runtime.getManifest().version}`],['Platform',navigator.userAgentData?.platform||navigator.platform]];
  const html=rows.map(([k,v])=>`<dt>${k}</dt><dd>${String(v)}</dd>`).join('');
  const el=$('set-browser'); if(el) el.innerHTML=html;
  const ov=$('ov-browser'); if(ov && !ov.innerHTML) ov.innerHTML=html;
}
// reconnect removed — auto-waiting (was ov-reconnect)

// ----- browser -----
async function refreshBrowser(){
  const filter=$('browser-filter').value.trim().toLowerCase();
  try{
    const tabs=await chrome.tabs.query({});
    const wins=await chrome.windows.getAll({populate:true});
    $('browser-meta').textContent = `${wins.length} window(s) · ${tabs.length} tab(s)`;
    let filtered = tabs;
    if(filter) filtered = tabs.filter(t=> (t.title||'').toLowerCase().includes(filter) || (t.url||'').toLowerCase().includes(filter));
    const list=$('browser-tabs');
    if(!filtered.length) list.innerHTML='<div class="notice">No tabs match filter</div>';
    else list.innerHTML = filtered.map(t=>`
      <div class="tab-row ${t.active?'active':''}" data-tab="${t.id}">
        <img src="${t.favIconUrl||''}" onerror="this.style.display='none'">
        <div class="t"><div class="title">${escapeHtml(t.title||'Untitled')}</div><div class="url">${escapeHtml(t.url||'')}</div></div>
        <button class="btn btn-sm" data-act="switch" data-id="${t.id}">Switch</button>
        <button class="btn btn-sm" data-act="close" data-id="${t.id}">Close</button>
      </div>`).join('');
    list.querySelectorAll('button[data-act="switch"]').forEach(b=> b.onclick=e=>{
      e.stopPropagation(); chrome.tabs.update(parseInt(b.dataset.id),{active:true}).then(()=> chrome.windows.update(tabs.find(x=>x.id==parseInt(b.dataset.id))?.windowId,{focused:true})).then(refreshBrowser);
    });
    list.querySelectorAll('button[data-act="close"]').forEach(b=> b.onclick=e=>{
      e.stopPropagation(); chrome.tabs.remove(parseInt(b.dataset.id)).then(refreshBrowser);
    });
    list.querySelectorAll('.tab-row').forEach(row=>{
      row.onclick=()=> chrome.tabs.update(parseInt(row.dataset.tab),{active:true}).then(refreshBrowser);
    });
    const winsEl=$('browser-wins');
    winsEl.innerHTML = wins.map(w=> `<div style="padding:6px 0;border-bottom:1px solid var(--border)"><strong>Window ${w.id}</strong> ${w.focused?'<span class=badge>focused</span>':''} — ${w.tabs.length} tabs — ${w.width}×${w.height} <button class="btn btn-sm" data-win="${w.id}">Focus</button></div>`).join('');
    winsEl.querySelectorAll('button[data-win]').forEach(b=> b.onclick=()=> chrome.windows.update(parseInt(b.dataset.win),{focused:true}));
  }catch(e){
    $('browser-tabs').innerHTML=`<div class="notice">Error: ${escapeHtml(String(e))}</div>`;
  }
}
$('browser-filter').addEventListener('input', refreshBrowser);
$('browser-refresh').onclick=refreshBrowser;

// navigate removed — use browser address bar (was nav-go/back/forward/reload)

// ----- tools -----
const TOOLS=[
  'connect_brave','disconnect','navigate','navigate_history','click','type','focus_element','press_key','scroll','get_page_info','get_page_content','read_page','list_elements','inspect_dom','screenshot','pdf_export','execute_js','inject_script','send_to_injected','wait_for','wait_for_load','tabs','windows','detect_captcha','wait_for_captcha','video_control','search','search_tabs','network_start','network_stop','network_list','network_request','cookies','bookmark_add','bookmark_delete','bookmark_search','bookmark_list','history_search','hover','computer','health'
];
const toolSel=$('tool-name');
if(toolSel){ TOOLS.forEach(n=>{ const o=document.createElement('option'); o.value=n; o.textContent=n; toolSel.appendChild(o);}); }
async function refreshToolTabs(){
  const sel=$('tool-tab');
  if(!sel) return;
  const tabs=await chrome.tabs.query({});
  sel.innerHTML='<option value="">(active tab)</option>'+tabs.map(t=> `<option value="${t.id}">${t.id}: ${(t.title||t.url).slice(0,40)}</option>`).join('');
}
refreshToolTabs();
$('tool-run')?.addEventListener('click', async()=>{
  const name=toolSel.value;
  const argsText=$('tool-args').value.trim();
  let args={};
  if(argsText){ try{ args=JSON.parse(argsText); }catch(e){ $('tool-out').style.display='block'; $('tool-out').textContent='Invalid JSON: '+e.message; return; } }
  const tabId=$('tool-tab').value ? parseInt($('tool-tab').value) : null;
  if(tabId) args.tabId = tabId;
  // we can't directly call MCP server from dashboard; instead we show the equivalent chrome.* call or do direct DOM
  // For now, do direct execution for known tools
  $('tool-out').style.display='block'; $('tool-out').textContent='Running '+name+'…';
  try{
    let result='—';
    if(name==='get_page_content'){
      const [t]=await chrome.tabs.query({active:true, currentWindow:true});
      const r=await chrome.scripting.executeScript({target:{tabId: t.id}, func:(sel)=> (sel?document.querySelector(sel):document.body)?.innerText.slice(0,2000) || '', args:[args.selector||null]});
      result=r?.[0]?.result||'';
    }else if(name==='list_elements'){
      const [t]=await chrome.tabs.query({active:true, currentWindow:true});
      const r=await chrome.scripting.executeScript({target:{tabId: t.id}, func:()=> [...document.querySelectorAll('a,button,input')].slice(0,10).map(e=> e.tagName+':'+(e.innerText||e.value||'').slice(0,40)).join('\n')});
      result=r?.[0]?.result||'';
    }else if(name==='inspect_dom'){
      const [t]=await chrome.tabs.query({active:true, currentWindow:true});
      const r=await chrome.scripting.executeScript({target:{tabId:t.id}, func:(sel)=>{ const e=document.querySelector(sel); return e? `${e.tagName} ${e.className} "${(e.innerText||'').slice(0,100)}"`:'not found'; }, args:[args.selector||'body']});
      result=r?.[0]?.result||'';
    }else if(name==='detect_captcha'){
      const [t]=await chrome.tabs.query({active:true, currentWindow:true});
      const r=await chrome.scripting.executeScript({target:{tabId:t.id}, func:()=> document.documentElement.outerHTML.slice(0,400)});
      result = /recaptcha|hcaptcha|turnstile/i.test(r?.[0]?.result||'') ? 'CAPTCHA detected' : 'No CAPTCHA';
    }else if(name==='execute_js'){
      const [t]=await chrome.tabs.query({active:true, currentWindow:true});
      const code=args.code||args.selector||'document.title';
      const r=await chrome.scripting.executeScript({target:{tabId:t.id}, world:'MAIN', func:(src)=>{ try{ return new Function('return ('+src+')')() }catch(e){ return 'Error: '+e.message } }, args:[code]});
      result=String(r?.[0]?.result ?? '');
    }else{
      result='Use MCP server for full tool. This dashboard runs direct chrome.* preview. For '+name+' with args '+JSON.stringify(args);
    }
    $('tool-out').textContent = result || '(empty)';
  }catch(e){ $('tool-out').textContent=String(e); }
});
$('tool-clear')?.addEventListener('click',()=>{ $('tool-args').value=''; $('tool-out').style.display='none'; });
$('tool-name')?.addEventListener('change',()=>{
  const presets={
    get_page_content:'{"selector":"body"}',
    list_elements:'{"kind":"all","limit":10}',
    inspect_dom:'{"selector":"h1"}',
    read_page:'{"filter":"interactive","max_refs":20}',
    wait_for:'{"selector":"body","timeout":3000}',
    execute_js:'{"code":"document.title","confirm":true}',
    screenshot:'{}',
    cookies:'{"action":"get"}'
  };
  const v=presets[toolSel.value];
  if(v) $('tool-args').value=v;
});
$('dom-exists')?.addEventListener('click', async()=>{
  const sel=$('dom-sel').value.trim(); if(!sel) return;
  const [t]=await chrome.tabs.query({active:true, currentWindow:true});
  const r=await chrome.scripting.executeScript({target:{tabId:t.id}, func:(s)=> !!document.querySelector(s), args:[sel]});
  $('dom-out').style.display='block'; $('dom-out').textContent = `exists(${sel}) → ${r?.[0]?.result}`;
});
$('dom-inspect')?.addEventListener('click', async()=>{
  const sel=$('dom-sel').value.trim()||'body';
  const [t]=await chrome.tabs.query({active:true, currentWindow:true});
  const r=await chrome.scripting.executeScript({target:{tabId:t.id}, func:(s)=>{ const e=document.querySelector(s); return e? JSON.stringify({tag:e.tagName, id:e.id, cls:e.className, text:(e.innerText||'').slice(0,120)},null,2):'not found'; }, args:[sel]});
  $('dom-out').style.display='block'; $('dom-out').textContent=r?.[0]?.result||'';
});
$('dom-text')?.addEventListener('click', async()=>{
  const sel=$('dom-sel').value.trim()||'body';
  const [t]=await chrome.tabs.query({active:true, currentWindow:true});
  const r=await chrome.scripting.executeScript({target:{tabId:t.id}, func:(s)=> (document.querySelector(s)?.innerText||'').slice(0,500), args:[sel]});
  $('dom-out').style.display='block'; $('dom-out').textContent=r?.[0]?.result||'(empty)';
});

// ----- captures -----
$('cap-shot').onclick=async()=>{
  const [t]=await chrome.tabs.query({active:true, currentWindow:true});
  if(!t) return;
  try{
    const url=await chrome.tabs.captureVisibleTab(t.windowId,{format:'png'});
    $('cap-preview').style.display='block'; $('cap-img').src=url;
    $('cap-meta').textContent=`${Math.round(url.length/1024)} KB — ${t.title}`;
    // add to gallery
    const img=document.createElement('img'); img.src=url; img.title=new Date().toLocaleString();
    const g=$('cap-gallery'); if(g.querySelector('.notice')) g.innerHTML=''; g.prepend(img);
  }catch(e){ $('cap-meta').textContent=String(e); $('cap-preview').style.display='block'; }
};
$('cap-full').onclick=async()=>{
  const [t]=await chrome.tabs.query({active:true, currentWindow:true});
  if(!t) return;
  // full page via debugger would need background; just do captureVisible for now
  $('cap-shot').click();
};
$('cap-pdf2').onclick=async()=>{
  const [tab]=await chrome.tabs.query({active:true, currentWindow:true});
  if(!tab){ $('cap-meta').textContent='No active tab'; $('cap-preview').style.display='block'; return; }
  const meta=$('cap-meta'); const preview=$('cap-preview');
  preview.style.display='block'; meta.textContent='Generating PDF…';
  let attached=false;
  try{
    await new Promise((res,rej)=> chrome.debugger.attach({tabId: tab.id}, '1.3', ()=> chrome.runtime.lastError ? rej(new Error(chrome.runtime.lastError.message)) : res()));
    attached=true;
    const result = await new Promise((res,rej)=> chrome.debugger.sendCommand({tabId: tab.id}, 'Page.printToPDF', {printBackground:true, paperWidth:8.27, paperHeight:11.69}, r=> chrome.runtime.lastError ? rej(new Error(chrome.runtime.lastError.message)) : res(r)));
    await new Promise(r=> chrome.debugger.detach({tabId: tab.id}, ()=> r()));
    attached=false;
    const b64 = result.data || '';
    const bytes = b64 ? atob(b64).length : 0;
    const url = 'data:application/pdf;base64,'+b64;
    const a=document.createElement('a'); a.href=url; a.download=`page-${Date.now()}.pdf`; document.body.appendChild(a); a.click(); a.remove();
    meta.textContent=`PDF ${Math.round(bytes/1024)} KB — downloaded (also opened)`;
    // add to gallery
    const g=$('cap-gallery'); if(g.querySelector('.notice')) g.innerHTML='';
    const div=document.createElement('div'); div.style.cssText='padding:10px;border:1px solid var(--border);border-radius:8px;text-align:center;background:var(--card)';
    div.innerHTML=`<div style="font-size:24px">📄</div><div style="font-size:12px;color:var(--muted)">${Math.round(bytes/1024)} KB — ${new Date().toLocaleTimeString()}</div><a href="${url}" target="_blank" style="font-size:12px">Open PDF</a>`;
    g.prepend(div);
    // also open in new tab for preview
    try{ window.open(url,'_blank'); }catch{}
  }catch(e){
    meta.textContent='PDF failed: '+String(e.message||e);
    if(attached) try{ chrome.debugger.detach({tabId: tab.id}, ()=>{}); }catch{}
  }
};

// ----- settings (merged from options) -----
async function loadSettings(){
  try{
    const r=await chrome.runtime.sendMessage({type:'getSettings'});
    if(r && r.ok) $('set-url').value=r.serverUrl||'ws://127.0.0.1:9224';
    else {
      const s=await chrome.storage.local.get({settings:null, wsUrl:null});
      const bg=s.settings||{};
      $('set-url').value=bg.serverUrl||s.wsUrl||'ws://127.0.0.1:9224';
    }
  }catch{}
}
$('set-save').onclick=async()=>{
  const url=$('set-url').value.trim();
  await chrome.runtime.sendMessage({type:'updateSettings', serverUrl:url}).catch(()=>{});
  try{ await chrome.storage.local.set({wsUrl:url, settings:{serverUrl:url}}); }catch{}
  $('set-note').textContent='Saved'; setTimeout(()=> $('set-note').textContent='',1500);
  refreshStatus();
};

// ----- logs -----
const logEl=$('log-out');
function log(msg){
  const t=new Date().toLocaleTimeString();
  logEl.textContent += `[${t}] ${msg}\n`;
  logEl.scrollTop=logEl.scrollHeight;
}
chrome.tabs.onUpdated.addListener((id,info,tab)=> log(`tabs.onUpdated ${id} ${info.status||''} ${tab.url||''}`.trim()));
chrome.tabs.onActivated.addListener(o=> log(`tabs.onActivated ${JSON.stringify(o)}`));
chrome.windows.onFocusChanged.addListener(id=> log(`windows.onFocusChanged ${id}`));
$('log-clear').onclick=()=> logEl.textContent='';
$('log-copy').onclick=()=> navigator.clipboard.writeText(logEl.textContent);
log('dashboard ready — v'+chrome.runtime.getManifest().version);

// ----- quick actions on selected browser tab (Browser page) -----
async function refreshQATabs(){
  const sel=$('qa-tab');
  if(!sel) return;
  const tabs=await chrome.tabs.query({});
  const browsable=tabs.filter(t=> t.url && /^https?:/.test(t.url));
  if(!browsable.length){ sel.innerHTML='<option value="">(no browsable tabs — open an HTTP page)</option>'; return; }
  sel.innerHTML=browsable.map(t=> `<option value="${t.id}">${t.id}: ${(t.title||t.url).slice(0,45)}</option>`).join('');
}
function qaTabId(){
  const sel=$('qa-tab');
  const v=sel?parseInt(sel.value,10):NaN;
  return Number.isFinite(v)?v:null;
}
async function qaRun(fn){
  const out=$('qa-out2');
  if(!out) return;
  out.style.display='block'; out.textContent='Running…';
  const tabId=qaTabId();
  if(!tabId){ out.textContent='Pick a browser tab above (https://)'; return; }
  try{
    const r=await fn(tabId);
    out.textContent = r || '(empty)';
  }catch(e){ out.textContent=String(e.message||e); }
}
$('qa-shot2').onclick=()=> qaRun(async (tabId)=>{
  const tab=await chrome.tabs.get(tabId);
  const url=await chrome.tabs.captureVisibleTab(tab.windowId,{format:'png'});
  // show in captures preview as well
  const img=$('cap-img'); if(img){ $('cap-preview').style.display='block'; img.src=url; $('cap-meta').textContent=`${Math.round(url.length/1024)} KB — tab ${tabId}`; }
  const g=$('cap-gallery'); if(g){ if(g.querySelector('.notice')) g.innerHTML=''; const im=document.createElement('img'); im.src=url; im.title=new Date().toLocaleString(); g.prepend(im); }
  return `Screenshot ${Math.round(url.length/1024)} KB — tab ${tabId} ${tab.url}`;
});
$('qa-pdf2').onclick=()=> qaRun(async (tabId)=>{
  let attached=false;
  try{
    await new Promise((res,rej)=> chrome.debugger.attach({tabId}, '1.3', ()=> chrome.runtime.lastError?rej(new Error(chrome.runtime.lastError.message)):res()));
    attached=true;
    const result=await new Promise((res,rej)=> chrome.debugger.sendCommand({tabId}, 'Page.printToPDF', {printBackground:true, paperWidth:8.27, paperHeight:11.69}, r=> chrome.runtime.lastError?rej(new Error(chrome.runtime.lastError.message)):res(r)));
    await new Promise(r=> chrome.debugger.detach({tabId}, ()=>r())); attached=false;
    const b64=result.data||''; const bytes=b64?atob(b64).length:0;
    const url='data:application/pdf;base64,'+b64;
    const a=document.createElement('a'); a.href=url; a.download=`page-${tabId}-${Date.now()}.pdf`; document.body.appendChild(a); a.click(); a.remove();
    try{ window.open(url,'_blank'); }catch{}
    return `PDF ${Math.round(bytes/1024)} KB — tab ${tabId} downloaded`;
  }catch(e){ if(attached) try{ chrome.debugger.detach({tabId},()=>{});}catch{} throw e; }
});
$('qa-read2').onclick=()=> qaRun(async (tabId)=>{
  const r=await chrome.scripting.executeScript({target:{tabId}, func:()=> document.body.innerText.slice(0,800)});
  return r?.[0]?.result||'(empty)';
});
$('qa-list2').onclick=()=> qaRun(async (tabId)=>{
  const r=await chrome.scripting.executeScript({target:{tabId}, func:()=> [...document.querySelectorAll('a,button,input')].slice(0,20).map(e=> `${e.tagName.toLowerCase()}${e.id?'#'+e.id:''} "${(e.innerText||e.value||'').slice(0,35)}"`).join('\n')});
  return r?.[0]?.result||'(none)';
});
$('ov-newtab').onclick=()=> chrome.tabs.create({url:'chrome://newtab/'});

// utils
function escapeHtml(s){ return String(s).replace(/[&<>"']/g,c=> ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }

// init
refreshStatus(); renderOverviewCur(); renderBrowserInfo(); refreshBrowser(); refreshQATabs();
chrome.storage.onChanged.addListener(refreshStatus);
setInterval(refreshStatus,4000);
setInterval(renderOverviewCur,3000);
setInterval(refreshBrowser,5000);
setInterval(refreshQATabs,5000);
chrome.tabs.onCreated.addListener(refreshQATabs);
chrome.tabs.onRemoved.addListener(refreshQATabs);
chrome.tabs.onUpdated.addListener(refreshQATabs);

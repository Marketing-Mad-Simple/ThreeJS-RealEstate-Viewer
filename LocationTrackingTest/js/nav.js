// ── nav.js — search, stall list, destination navigation ──────────────────
'use strict';

window.destStall = null;

// ── Search ────────────────────────────────────────────────────────────────
const searchInput   = document.getElementById('searchInput');
const searchResults = document.getElementById('searchResults');
const clearBtn      = document.getElementById('clearSearch');
const destBar       = document.getElementById('destBar');

function distToAvatar(stall){
  return Math.sqrt((stall.x-aX)**2+(stall.z-aZ)**2);
}

function renderResults(items){
  searchResults.innerHTML='';
  if(!items.length){ searchResults.style.display='none'; return; }
  items.slice(0,12).forEach(stall=>{
    const d=distToAvatar(stall);
    const el=document.createElement('div');
    el.className='search-item';
    el.innerHTML=`
      <span class="si-id">${stall.id}</span>
      <span class="si-name">${stall.company||'—'}</span>
      <span class="si-dist">${d<0.5?'nearby':(d*5).toFixed(0)+'m away'}</span>`;
    el.addEventListener('click',()=>setDestination(stall));
    searchResults.appendChild(el);
  });
  searchResults.style.display='block';
}

searchInput.addEventListener('input',()=>{
  const q=searchInput.value.trim().toLowerCase();
  clearBtn.style.display=q?'block':'none';
  if(!q){ searchResults.style.display='none'; return; }
  const hits=window.STALL_DATA.filter(s=>
    s.id.toLowerCase().includes(q) ||
    (s.company||'').toLowerCase().includes(q)
  ).sort((a,b)=>distToAvatar(a)-distToAvatar(b));
  renderResults(hits);
});

clearBtn.addEventListener('click',()=>{
  searchInput.value='';
  clearBtn.style.display='none';
  searchResults.style.display='none';
  searchInput.focus();
});

// Close results when tapping outside
document.addEventListener('click',e=>{
  if(!e.target.closest('#searchWrap')&&!e.target.closest('#searchResults')){
    searchResults.style.display='none';
  }
});

// ── Destination ───────────────────────────────────────────────────────────
function setDestination(stall){
  window.destStall=stall;
  searchInput.value='';
  searchResults.style.display='none';
  clearBtn.style.display='none';

  // Show dest bar
  destBar.style.display='flex';
  document.body.classList.add('has-dest');
  document.getElementById('destName').textContent=`${stall.id} — ${stall.company||''}`;
  updateDestDist();

  // Force-show label for destination
  if(window.highlightStall) window.highlightStall(stall.id);

  // Compute and draw path
  if(window.computePath) window.computePath(stall);

  // Close nav panel if open
  document.getElementById('navPanel').classList.remove('open');
}

function clearDestination(){
  window.destStall=null;
  destBar.style.display='none';
  document.body.classList.remove('has-dest');
  if(window.highlightStall) window.highlightStall(null);
  if(window.clearPath) window.clearPath();
}

document.getElementById('destClear').addEventListener('click', clearDestination);

function updateDestDist(){
  if(!window.destStall) return;
  const d=distToAvatar(window.destStall);
  document.getElementById('destDist').textContent=
    d<0.08?'🎯 You\'re here!':`~${(d*5).toFixed(0)} m away`;
}
// Hook into animate loop
const _origUpdateCamera=window.updateCamera;

// Called each frame from scene.js animate()
window.onFrameTick=function(){
  updateDestDist();
};

// ── Nav panel (stall list) ─────────────────────────────────────────────────
const navPanel  = document.getElementById('navPanel');
const navToggle = document.getElementById('navToggleBtn');
const navContent= document.getElementById('navContent');

navToggle.addEventListener('click',()=>{
  const open=navPanel.classList.toggle('open');
  if(open) renderNavList();
});
document.getElementById('navPanelClose').addEventListener('click',()=>{
  navPanel.classList.remove('open');
});

function renderNavList(){
  if(!window.STALL_DATA){navContent.innerHTML='<p style="color:#666;font-size:13px">Loading…</p>';return;}
  const sorted=[...window.STALL_DATA]
    .filter(s=>s.company&&s.company!=='EMPTY'&&s.company!=='RESERVED'&&s.company!=='RESERV'&&s.company!=='BOOKED')
    .sort((a,b)=>distToAvatar(a)-distToAvatar(b));
  navContent.innerHTML='<p style="color:#888;font-size:11px;margin-bottom:10px">Tap a stall to navigate</p>';
  sorted.forEach(stall=>{
    const d=distToAvatar(stall);
    const btn=document.createElement('button');
    btn.className='nav-stall-btn';
    btn.innerHTML=`
      <span class="ns-id">${stall.id}</span>
      <span class="ns-name">${stall.company}</span>
      <span class="ns-dist">${d<0.08?'here':(d*5).toFixed(0)+'m'}</span>`;
    btn.addEventListener('click',()=>setDestination(stall));
    navContent.appendChild(btn);
  });
}

window.setDestination=setDestination;

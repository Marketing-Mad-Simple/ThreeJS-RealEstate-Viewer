/**
 * MMS Experience — AI Chat Assistant (Plot Viewer)
 *
 * Semantic FAQ search powered by Transformers.js (open-source, Apache 2.0).
 * Model: Xenova/all-MiniLM-L6-v2 — ~22 MB, cached after first download.
 * No backend. No API key. Runs entirely in the browser.
 */

import { pipeline, env } from 'https://cdn.jsdelivr.net/npm/@xenova/transformers@2.17.2/dist/transformers.min.js';

env.allowLocalModels = false;
env.useBrowserCache  = true;

/* ── Config ─────────────────────────────────────────────── */
const MODEL_ID    = 'Xenova/all-MiniLM-L6-v2';
const CONF_ANSWER = 0.48;
const CONF_MAYBE  = 0.36;

/* ── State ──────────────────────────────────────────────── */
let embedder      = null;
let faqItems      = [];
let faqEmbeddings = [];
let plotData      = {};
let modelReady    = false;
let chatOpen      = false;
let ttsEnabled    = true;
let isBusy        = false;

/* ── Utility ─────────────────────────────────────────────── */
function cosineSim(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na  += a[i] * a[i];
    nb  += b[i] * b[i];
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) + 1e-10);
}

function esc(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/* ── Data ───────────────────────────────────────────────── */
async function loadData() {
  const [faqJson, plotJson] = await Promise.all([
    fetch('./data/faq.json').then(r => r.json()),
    fetch('./data/plots.json').then(r => r.json()),
  ]);
  faqItems = faqJson.faqs;
  plotData  = plotJson;
}

/* ── Model init ─────────────────────────────────────────── */
async function initModel() {
  setModelBar('loading', 'Loading AI model…');
  try {
    embedder = await pipeline('feature-extraction', MODEL_ID, {
      progress_callback: ({ status, progress }) => {
        if (status === 'progress' && progress != null) {
          setModelBar('loading', `Loading AI… ${Math.round(progress)}%`);
        }
      },
    });

    for (const faq of faqItems) {
      const out = await embedder(faq.question, { pooling: 'mean', normalize: true });
      faqEmbeddings.push(new Float32Array(out.data));
    }

    modelReady = true;
    setModelBar('ready');
  } catch (err) {
    console.warn('[chat] Model init failed:', err);
    setModelBar('error', 'AI model unavailable — using keyword matching');
    modelReady = true;
  }
}

/* ── Fallback keyword scoring ───────────────────────────── */
function keywordScore(query, candidate) {
  const qWords = new Set(query.toLowerCase().split(/\W+/).filter(w => w.length > 2));
  const cWords = candidate.toLowerCase().split(/\W+/);
  let hits = 0;
  for (const w of cWords) if (qWords.has(w)) hits++;
  return hits / Math.max(qWords.size, 1);
}

/* ── Plot data helpers ──────────────────────────────────── */
function plotsByStatus(status) {
  return Object.entries(plotData).filter(([, p]) => p.status === status);
}

function plotsByType(type) {
  return Object.entries(plotData).filter(([, p]) =>
    p.type.toLowerCase() === type.toLowerCase()
  );
}

function plotsByFacing(facing) {
  return Object.entries(plotData).filter(([, p]) =>
    p.facing.toLowerCase().includes(facing.toLowerCase())
  );
}

function counts() {
  const c = { available: 0, reserved: 0, sold: 0 };
  Object.values(plotData).forEach(p => c[p.status]++);
  return c;
}

/* ── Live availability answer ───────────────────────────── */
function buildAvailability(filterType = null, filterFacing = null) {
  let list = plotsByStatus('available');

  if (filterType) {
    list = list.filter(([, p]) => p.type.toLowerCase() === filterType.toLowerCase());
  }
  if (filterFacing) {
    list = list.filter(([, p]) => p.facing.toLowerCase().includes(filterFacing.toLowerCase()));
  }

  if (!list.length) {
    const qualifier = [filterType, filterFacing].filter(Boolean).join(' ');
    return `No ${qualifier} plots are currently available. Please enquire to be notified if one opens up or check back soon.`;
  }

  const label = [filterType, filterFacing, 'plot'].filter(Boolean).join(' ');
  if (list.length <= 6) {
    const items = list.map(([id, p]) =>
      `<strong>Plot ${id}</strong> (${p.type} · ${p.area} · ${p.facing} · ${p.price})`
    ).join('<br>');
    return `${list.length} ${label}${list.length !== 1 ? 's' : ''} available:<br>${items}<br><br>Tap any green plot in the viewer for full details and to enquire.`;
  }

  const c = counts();
  return `<strong>${list.length} ${label}${list.length !== 1 ? 's' : ''}</strong> available out of ${Object.keys(plotData).length} total. Use the filter buttons at the bottom of the viewer to highlight them, or tap any green plot for details and pricing.`;
}

/* ── Greeting with live stats ───────────────────────────── */
function buildGreeting() {
  const c = counts();
  return `Hello! ✦ I'm your AI guide for <strong>MMS Experience</strong>. There are currently <strong>${c.available} available plots</strong> across Small, Medium, and Large sizes. Ask me about pricing, plot types, infrastructure, or the booking process!`;
}

/* ── Answer engine ──────────────────────────────────────── */
async function getAnswer(query) {
  const q = query.trim().toLowerCase();

  /* Hard-coded greetings */
  if (/^(hi+|hello|hey|namaste|good\s*(morning|evening|afternoon)|howdy)\b/.test(q)) {
    return buildGreeting();
  }
  if (/\b(thank(s| you)?|thx)\b/.test(q)) {
    return "You're welcome! Feel free to ask anything else about MMS Experience.";
  }
  if (/\b(bye|goodbye|see\s*you|ciao)\b/.test(q)) {
    return "Thank you for your interest in MMS Experience! We look forward to welcoming you. Have a wonderful day!";
  }

  /* Live plot counts */
  if (/\bhow many\b/.test(q) && /\b(plot|available|total)\b/.test(q)) {
    const c = counts();
    return `Out of <strong>${Object.keys(plotData).length} total plots</strong>: <strong>${c.available} available</strong> · ${c.reserved} reserved · ${c.sold} sold. Tap the 'Available' filter in the viewer to highlight open plots.`;
  }

  /* Type + availability filters */
  const typeMatch   = q.match(/\b(small|medium|large)\b/);
  const facingMatch = q.match(/\b(north|east|south|west)\b/);
  const availIntent = /\b(available|open|free|for sale|can i buy)\b/.test(q);

  if (availIntent || (typeMatch && /\b(plot|land|site)\b/.test(q))) {
    return buildAvailability(
      typeMatch   ? typeMatch[1]   : null,
      facingMatch ? facingMatch[1] : null,
    );
  }

  /* Pure facing query without availability intent */
  if (facingMatch && /\b(plot|facing|direction|vastu)\b/.test(q)) {
    const facing = facingMatch[1];
    const avail  = plotsByStatus('available').filter(([, p]) =>
      p.facing.toLowerCase().includes(facing)
    );
    if (!avail.length) {
      return `No ${facing}-facing plots are currently available. Enquire to join the waitlist.`;
    }
    return `<strong>${avail.length} ${facing}-facing plot${avail.length !== 1 ? 's' : ''}</strong> available. Sizes: ${[...new Set(avail.map(([, p]) => p.type))].join(', ')}. Tap any green plot in the viewer to check facing and enquire.`;
  }

  /* Semantic search or keyword fallback */
  let bestScore = -1, bestIdx = 0;

  if (embedder) {
    const out  = await embedder(query, { pooling: 'mean', normalize: true });
    const qVec = new Float32Array(out.data);
    for (let i = 0; i < faqEmbeddings.length; i++) {
      const s = cosineSim(qVec, faqEmbeddings[i]);
      if (s > bestScore) { bestScore = s; bestIdx = i; }
    }
  } else {
    for (let i = 0; i < faqItems.length; i++) {
      const s = keywordScore(query, faqItems[i].question + ' ' + faqItems[i].answer);
      if (s > bestScore) { bestScore = s; bestIdx = i; }
    }
    bestScore = Math.min(bestScore * 1.5, 1);
  }

  if (bestScore < CONF_MAYBE) {
    return "I don't have specific details on that. For the most accurate answer, tap 'Enquire Now' on any available plot and our sales team will respond promptly!";
  }

  const answer = faqItems[bestIdx].answer;
  return bestScore < CONF_ANSWER ? `Based on what I know — ${answer}` : answer;
}

/* ── TTS ─────────────────────────────────────────────────── */
function pickVoice() {
  const voices = window.speechSynthesis?.getVoices() ?? [];
  return (
    voices.find(v => v.lang.startsWith('en') && /female|woman|samantha|karen|zira|aria|jenny|sonia/i.test(v.name)) ||
    voices.find(v => v.lang.startsWith('en')) ||
    null
  );
}

function speak(text) {
  if (!ttsEnabled || !window.speechSynthesis) return;
  window.speechSynthesis.cancel();
  const plain = text.replace(/<[^>]+>/g, ' ').replace(/[₹✦]/g, '').replace(/\s+/g, ' ').trim();
  const utt   = new SpeechSynthesisUtterance(plain);
  utt.rate  = 1.05;
  utt.pitch = 1.0;
  const trySpeak = () => {
    const v = pickVoice();
    if (v) utt.voice = v;
    window.speechSynthesis.speak(utt);
  };
  if (window.speechSynthesis.getVoices().length > 0) {
    trySpeak();
  } else {
    window.speechSynthesis.addEventListener('voiceschanged', trySpeak, { once: true });
  }
}

/* ── UI helpers ──────────────────────────────────────────── */
const el = id => document.getElementById(id);

function scrollBottom() {
  const msgs = el('chat-messages');
  if (msgs) msgs.scrollTop = msgs.scrollHeight;
}

function setModelBar(state, text = '') {
  const bar = el('chat-model-bar');
  if (!bar) return;
  if (state === 'ready') { bar.style.display = 'none'; return; }
  bar.style.display = 'flex';
  bar.className = 'chat-model-bar' + (state === 'error' ? ' cmb--error' : '');
  bar.querySelector('.cmb-text').textContent = text;
}

function addMessage(role, html, animate = true) {
  const wrap = el('chat-messages');
  const div  = document.createElement('div');
  div.className = `cmsg cmsg--${role}${animate ? ' cmsg--in' : ''}`;
  div.innerHTML = `<div class="cmsg-bubble"><div class="cmsg-text">${html}</div></div>`;
  wrap.appendChild(div);
  scrollBottom();
}

function showTyping() {
  const wrap = el('chat-messages');
  const div  = document.createElement('div');
  div.id        = 'chat-typing';
  div.className = 'cmsg cmsg--assistant cmsg--in';
  div.innerHTML = `<div class="cmsg-bubble"><div class="chat-dots"><span></span><span></span><span></span></div></div>`;
  wrap.appendChild(div);
  scrollBottom();
}

function hideTyping() { el('chat-typing')?.remove(); }
function removeSuggestions() { el('chat-suggestions')?.remove(); }

/* ── Open / close ─────────────────────────────────────────── */
function openChat() {
  chatOpen = true;
  el('chat-panel').classList.add('open');
  el('chat-fab').setAttribute('aria-expanded', 'true');
  el('chat-fab').classList.add('active');
  setTimeout(() => el('chat-input')?.focus(), 80);
  scrollBottom();
  const canvas = document.getElementById('canvas');
  if (canvas) canvas.style.pointerEvents = 'none';
}

function closeChat() {
  chatOpen = false;
  el('chat-panel').classList.remove('open');
  el('chat-fab').setAttribute('aria-expanded', 'false');
  el('chat-fab').classList.remove('active');
  window.speechSynthesis?.cancel();
  const canvas = document.getElementById('canvas');
  if (canvas) canvas.style.pointerEvents = '';
}

/* ── Send ─────────────────────────────────────────────────── */
async function handleSend() {
  if (isBusy) return;
  const input = el('chat-input');
  const text  = input.value.trim();
  if (!text) return;

  input.value = '';
  removeSuggestions();
  addMessage('user', esc(text));
  isBusy = true;

  showTyping();
  const answer = await getAnswer(text);
  hideTyping();
  addMessage('assistant', answer);
  speak(answer);
  isBusy = false;
}

/* ── Build DOM ───────────────────────────────────────────── */
function createUI() {
  /* FAB */
  const fab = document.createElement('button');
  fab.id = 'chat-fab';
  fab.setAttribute('aria-label', 'Open AI assistant');
  fab.setAttribute('aria-expanded', 'false');
  fab.setAttribute('aria-controls', 'chat-panel');
  fab.innerHTML = `
    <span class="fab-icon fab-icon--open">
      <svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24"
           fill="none" stroke="currentColor" stroke-width="2"
           stroke-linecap="round" stroke-linejoin="round">
        <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
      </svg>
    </span>
    <span class="fab-icon fab-icon--close">
      <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24"
           fill="none" stroke="currentColor" stroke-width="2.5"
           stroke-linecap="round" stroke-linejoin="round">
        <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
      </svg>
    </span>`;
  document.body.appendChild(fab);

  /* Panel */
  const panel = document.createElement('div');
  panel.id = 'chat-panel';
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-label', 'AI Chat Assistant');
  panel.innerHTML = `
    <div class="chat-handle"></div>

    <div class="chat-header">
      <div class="chat-header-left">
        <div class="chat-avatar">✦</div>
        <div>
          <div class="chat-title">AI Assistant</div>
          <div class="chat-subtitle">MMS Experience Guide</div>
        </div>
      </div>
      <div class="chat-header-right">
        <button id="chat-tts-btn" class="chat-icon-btn" aria-label="Toggle voice" title="Toggle voice">
          <svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24"
               fill="none" stroke="currentColor" stroke-width="2"
               stroke-linecap="round" stroke-linejoin="round">
            <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/>
            <path d="M19.07 4.93a10 10 0 0 1 0 14.14"/>
            <path d="M15.54 8.46a5 5 0 0 1 0 7.07"/>
          </svg>
        </button>
        <button id="chat-close-btn" class="chat-icon-btn" aria-label="Close chat">
          <svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24"
               fill="none" stroke="currentColor" stroke-width="2.5"
               stroke-linecap="round" stroke-linejoin="round">
            <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
          </svg>
        </button>
      </div>
    </div>

    <div id="chat-model-bar" class="chat-model-bar" style="display:none">
      <div class="cmb-spinner"></div>
      <span class="cmb-text">Loading AI model…</span>
    </div>

    <div id="chat-messages" class="chat-messages">
      <div class="cmsg cmsg--assistant">
        <div class="cmsg-bubble">
          <div class="cmsg-text">Hello! ✦ I&rsquo;m your AI guide for <strong>MMS Experience</strong>. Ask me about available plots, pricing, infrastructure, or the booking process.</div>
        </div>
      </div>
      <div id="chat-suggestions" class="chat-suggestions">
        <button class="chat-chip">Which plots are available?</button>
        <button class="chat-chip">What are the prices?</button>
        <button class="chat-chip">Show large plots</button>
        <button class="chat-chip">How do I book a plot?</button>
      </div>
    </div>

    <div class="chat-input-row">
      <input id="chat-input"
             type="text"
             placeholder="Ask about MMS Experience…"
             autocomplete="off"
             autocorrect="off"
             autocapitalize="sentences"
             enterkeyhint="send" />
      <button id="chat-send-btn" class="chat-send-btn" aria-label="Send message">
        <svg xmlns="http://www.w3.org/2000/svg" width="17" height="17" viewBox="0 0 24 24"
             fill="none" stroke="currentColor" stroke-width="2.5"
             stroke-linecap="round" stroke-linejoin="round">
          <line x1="22" y1="2" x2="11" y2="13"/>
          <polygon points="22 2 15 22 11 13 2 9 22 2"/>
        </svg>
      </button>
    </div>`;
  document.body.appendChild(panel);

  /* Events */
  fab.addEventListener('click', () => chatOpen ? closeChat() : openChat());
  el('chat-close-btn').addEventListener('click', closeChat);
  el('chat-send-btn').addEventListener('click', handleSend);

  el('chat-input').addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend(); }
  });

  el('chat-tts-btn').classList.add('active');

  el('chat-tts-btn').addEventListener('click', () => {
    ttsEnabled = !ttsEnabled;
    el('chat-tts-btn').classList.toggle('active', ttsEnabled);
    if (!ttsEnabled) window.speechSynthesis?.cancel();
  });

  panel.addEventListener('click', e => {
    const chip = e.target.closest('.chat-chip');
    if (!chip) return;
    el('chat-input').value = chip.textContent;
    handleSend();
  });

  /* Swipe down to close on mobile */
  let touchY0 = 0;
  panel.querySelector('.chat-handle').addEventListener('touchstart', e => {
    touchY0 = e.touches[0].clientY;
  }, { passive: true });
  panel.querySelector('.chat-handle').addEventListener('touchend', e => {
    if (e.changedTouches[0].clientY - touchY0 > 48) closeChat();
  }, { passive: true });

  /* Nudge panel when virtual keyboard opens */
  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', () => {
      if (!chatOpen) return;
      const kbH = window.innerHeight - window.visualViewport.height - window.visualViewport.offsetTop;
      panel.style.bottom = kbH > 50 ? `${kbH}px` : '';
    });
  }
}

/* ── Boot ─────────────────────────────────────────────────── */
async function init() {
  await loadData();
  createUI();
  initModel(); // runs in background
}

init();

/**
 * MMS Experience — AI Chat Assistant
 *
 * Semantic FAQ search powered by Transformers.js (open-source, Apache 2.0).
 * Model: Xenova/all-MiniLM-L6-v2 — ~22 MB, cached after first download.
 * No backend. No API key. Works entirely in the browser.
 */

import { pipeline, env } from 'https://cdn.jsdelivr.net/npm/@xenova/transformers@2.17.2/dist/transformers.min.js';

env.allowLocalModels  = false;
env.useBrowserCache   = true;

/* ── Config ────────────────────────────────────────────────── */
const MODEL_ID      = 'Xenova/all-MiniLM-L6-v2';
const EMB_DIM       = 384;
const CONF_ANSWER   = 0.48;   // show a direct answer
const CONF_MAYBE    = 0.36;   // show with "based on what I know"

/* ── State ─────────────────────────────────────────────────── */
let embedder      = null;
let faqItems      = [];
let faqEmbeddings = [];   // parallel array of Float32Array[384]
let flatsData     = {};
let modelReady    = false;
let chatOpen      = false;
let ttsEnabled    = true;
let isBusy        = false;

/* ── Utility ───────────────────────────────────────────────── */
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

/* ── Data ──────────────────────────────────────────────────── */
async function loadData() {
  const [faqJson, flatsJson] = await Promise.all([
    fetch('./data/faq.json').then(r => r.json()),
    fetch('./data/flats.json').then(r => r.json()),
  ]);
  faqItems  = faqJson.faqs;
  flatsData = flatsJson;
}

/* ── Model initialisation ──────────────────────────────────── */
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

    // Pre-compute embeddings for every FAQ question
    for (const faq of faqItems) {
      const out = await embedder(faq.question, { pooling: 'mean', normalize: true });
      faqEmbeddings.push(new Float32Array(out.data));
    }

    modelReady = true;
    setModelBar('ready');
  } catch (err) {
    console.warn('[chat] Model init failed:', err);
    setModelBar('error', 'AI model unavailable — using keyword matching');
    initFallback();
  }
}

/* ── Fallback: simple keyword scoring ─────────────────────── */
function keywordScore(query, candidate) {
  const qWords = new Set(query.toLowerCase().split(/\W+/).filter(w => w.length > 2));
  const cWords = candidate.toLowerCase().split(/\W+/);
  let hits = 0;
  for (const w of cWords) if (qWords.has(w)) hits++;
  return hits / Math.max(qWords.size, 1);
}

function initFallback() {
  modelReady = true; // flag as ready, but embedder stays null
}

/* ── Answer engine ─────────────────────────────────────────── */
async function getAnswer(query) {
  const q = query.trim().toLowerCase();

  /* ── Hard-coded intents ── */
  if (/^(hi+|hello|hey|namaste|good\s*(morning|evening|afternoon)|howdy)\b/.test(q)) {
    return buildGreeting();
  }
  if (/\b(thank(s| you)?|thx)\b/.test(q)) {
    return "You're welcome! Feel free to ask anything else about MMS Residences.";
  }
  if (/\b(bye|goodbye|see\s*you|ciao)\b/.test(q)) {
    return "Thank you for your interest in MMS Residences! We look forward to welcoming you. Have a wonderful day!";
  }

  /* ── Live availability (always fresh from data) ── */
  if (/\b(available|availability)\b/.test(q) && /\b(flat|unit|apartment|bhk|property)\b/.test(q)) {
    return buildAvailability();
  }

  /* ── Semantic search or keyword fallback ── */
  let bestScore = -1, bestIdx = 0;

  if (embedder) {
    const out   = await embedder(query, { pooling: 'mean', normalize: true });
    const qVec  = new Float32Array(out.data);
    for (let i = 0; i < faqEmbeddings.length; i++) {
      const s = cosineSim(qVec, faqEmbeddings[i]);
      if (s > bestScore) { bestScore = s; bestIdx = i; }
    }
  } else {
    for (let i = 0; i < faqItems.length; i++) {
      const s = keywordScore(query, faqItems[i].question + ' ' + faqItems[i].answer);
      if (s > bestScore) { bestScore = s; bestIdx = i; }
    }
    bestScore = Math.min(bestScore * 1.5, 1); // normalise into a comparable range
  }

  if (bestScore < CONF_MAYBE) {
    return "I don't have specific details on that. For the most accurate answer, tap 'Enquire Now' on any available flat and our sales team will get back to you promptly!";
  }

  const answer = faqItems[bestIdx].answer;
  if (bestScore < CONF_ANSWER) {
    return `Based on what I know — ${answer}`;
  }
  return answer;
}

function buildGreeting() {
  const avail = Object.values(flatsData).filter(f => f.status === 'available').length;
  return `Hello! 👋 I'm your AI guide for MMS Residences. We currently have <strong>${avail} available unit${avail !== 1 ? 's' : ''}</strong>. Ask me anything about flats, pricing, amenities, or the booking process!`;
}

function buildAvailability() {
  const avail = Object.values(flatsData).filter(f => f.status === 'available');
  if (!avail.length) {
    return 'All units in this phase are currently reserved or sold. Please enquire to join the waitlist for upcoming phases.';
  }
  const list = avail.map(f => `<strong>${f.label}</strong> (${f.type} · ${f.area} · ${f.price})`).join('<br>');
  return `${avail.length} unit${avail.length > 1 ? 's are' : ' is'} currently available:<br>${list}<br><br>Tap any highlighted flat in the viewer for full details and to enquire.`;
}

/* ── TTS ───────────────────────────────────────────────────── */
function pickFemaleVoice() {
  const voices = window.speechSynthesis.getVoices();
  // Prefer an English female voice; fall back to any female, then any English
  return (
    voices.find(v => v.lang.startsWith('en') && /female|woman|girl|zira|samantha|karen|moira|fiona|victoria|susan|kate|lisa|emma|aria|jenny|sonia/i.test(v.name)) ||
    voices.find(v => /female|woman|girl/i.test(v.name)) ||
    voices.find(v => v.lang.startsWith('en')) ||
    null
  );
}

function speak(text) {
  if (!ttsEnabled || !window.speechSynthesis) return;
  window.speechSynthesis.cancel();
  const plain = text.replace(/<[^>]+>/g, ' ').replace(/[₹]/g, 'rupees ').replace(/\s+/g, ' ').trim();
  const utt   = new SpeechSynthesisUtterance(plain);
  utt.rate  = 1.05;
  utt.pitch = 1.0;

  // Voices may not be loaded yet on first call — wait for them if needed
  const trySpeak = () => {
    const voice = pickFemaleVoice();
    if (voice) utt.voice = voice;
    window.speechSynthesis.speak(utt);
  };

  if (window.speechSynthesis.getVoices().length > 0) {
    trySpeak();
  } else {
    window.speechSynthesis.addEventListener('voiceschanged', trySpeak, { once: true });
  }
}

/* ── UI helpers ────────────────────────────────────────────── */
function el(id) { return document.getElementById(id); }

function scrollBottom() {
  const msgs = el('chat-messages');
  if (msgs) msgs.scrollTop = msgs.scrollHeight;
}

function setModelBar(state, text = '') {
  const bar = el('chat-model-bar');
  if (!bar) return;
  if (state === 'ready') {
    bar.style.display = 'none';
    return;
  }
  bar.style.display = 'flex';
  bar.className      = 'chat-model-bar' + (state === 'error' ? ' cmb--error' : '');
  bar.querySelector('.cmb-text').textContent = text;
}

function addMessage(role, html, animate = true) {
  const wrap = el('chat-messages');
  const div  = document.createElement('div');
  div.className = `cmsg cmsg--${role}${animate ? ' cmsg--in' : ''}`;
  div.innerHTML = `<div class="cmsg-bubble"><div class="cmsg-text">${html}</div></div>`;
  wrap.appendChild(div);
  scrollBottom();
  return div;
}

function showTyping() {
  const wrap = el('chat-messages');
  const div  = document.createElement('div');
  div.id         = 'chat-typing';
  div.className  = 'cmsg cmsg--assistant cmsg--in';
  div.innerHTML  = `<div class="cmsg-bubble"><div class="chat-dots"><span></span><span></span><span></span></div></div>`;
  wrap.appendChild(div);
  scrollBottom();
}

function hideTyping() { el('chat-typing')?.remove(); }

function removeSuggestions() { el('chat-suggestions')?.remove(); }

/* ── Open / close panel ────────────────────────────────────── */
function openChat() {
  chatOpen = true;
  el('chat-panel').classList.add('open');
  el('chat-fab').setAttribute('aria-expanded', 'true');
  el('chat-fab').classList.add('active');
  // Give browser time to paint before focusing (prevents iOS scroll jump)
  setTimeout(() => el('chat-input')?.focus(), 80);
  scrollBottom();
  // Prevent 3D canvas from capturing touch while panel is open
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

/* ── Send message ──────────────────────────────────────────── */
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

/* ── Create DOM ────────────────────────────────────────────── */
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
          <div class="chat-subtitle">MMS Residences Guide</div>
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
          <div class="cmsg-text">Hello! I&rsquo;m your AI guide for <strong>MMS Residences</strong>. Ask me anything about available units, pricing, amenities, or the booking process.</div>
        </div>
      </div>
      <div id="chat-suggestions" class="chat-suggestions">
        <button class="chat-chip">Which flats are available?</button>
        <button class="chat-chip">What are the prices?</button>
        <button class="chat-chip">How do I book a flat?</button>
        <button class="chat-chip">What amenities are included?</button>
      </div>
    </div>

    <div class="chat-input-row">
      <input id="chat-input"
             type="text"
             placeholder="Ask about MMS Residences…"
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

  // Reflect default-on state
  el('chat-tts-btn').classList.add('active');

  el('chat-tts-btn').addEventListener('click', () => {
    ttsEnabled = !ttsEnabled;
    el('chat-tts-btn').classList.toggle('active', ttsEnabled);
    if (!ttsEnabled) window.speechSynthesis?.cancel();
  });

  // Suggestion chips
  panel.addEventListener('click', e => {
    const chip = e.target.closest('.chat-chip');
    if (!chip) return;
    el('chat-input').value = chip.textContent;
    handleSend();
  });

  // Swipe down on handle to close (mobile)
  let touchY0 = 0;
  panel.querySelector('.chat-handle').addEventListener('touchstart', e => {
    touchY0 = e.touches[0].clientY;
  }, { passive: true });
  panel.querySelector('.chat-handle').addEventListener('touchend', e => {
    if (e.changedTouches[0].clientY - touchY0 > 48) closeChat();
  }, { passive: true });

  // Mobile virtual keyboard: nudge panel so input stays visible
  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', () => {
      if (!chatOpen) return;
      const keyboardH = window.innerHeight - window.visualViewport.height - window.visualViewport.offsetTop;
      panel.style.bottom = keyboardH > 50 ? `${keyboardH}px` : '';
    });
  }
}

/* ── Boot ──────────────────────────────────────────────────── */
async function init() {
  await loadData();
  createUI();
  // Model loads in the background so the UI is immediately responsive
  initModel();
}

init();

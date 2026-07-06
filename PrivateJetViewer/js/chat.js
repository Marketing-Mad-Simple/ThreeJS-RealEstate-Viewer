/* ─────────────────────────────────────────────────────────────────
   AETHER — AI Chat Assistant  ·  chat.js
   Semantic Q&A matcher — no API key, runs entirely in-browser.
   TTS via Web Speech API (free, built into all modern browsers).
   ───────────────────────────────────────────────────────────────── */

const STOP_WORDS = new Set([
  'a','an','the','is','are','was','were','be','been','being',
  'have','has','had','do','does','did','will','would','could','should',
  'may','might','shall','can','need','ought','it','its','this','that',
  'these','those','i','you','he','she','we','they','me','him','her','us','them',
  'my','your','his','our','their','mine','yours','ours','theirs',
  'in','on','at','to','for','of','and','or','but','if','then',
  'what','how','why','when','where','who','which','whose','whom',
  'there','here','about','also','just','very','too','so','as',
  'not','no','yes','ok','please','tell','give','show','want','know',
  'get','make','go','come','see','think','look','find','like','use',
  'well','now','than','more','some','any','all','both','each',
  'few','most','other','into','through','during','before','after',
  'above','below','between','with','without','from','up','down',
  'out','off','over','under','again','further','once',
]);

/* ── Normalise & tokenise ── */
function tokenise(text) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s'-]/g, ' ')
    .split(/[\s]+/)
    .map(t => t.replace(/^['-]+|['-]+$/g, ''))
    .filter(t => t.length > 1 && !STOP_WORDS.has(t));
}

/* ── Simple suffix stemmer (English) ── */
function stem(word) {
  return word
    .replace(/ing$/, '').replace(/tion$/, '').replace(/tions$/, '')
    .replace(/ness$/, '').replace(/ment$/, '').replace(/ments$/, '')
    .replace(/ies$/, 'y').replace(/ied$/, 'y')
    .replace(/ed$/, '').replace(/er$/, '').replace(/est$/, '')
    .replace(/s$/, '');
}

function bag(text) {
  return tokenise(text).map(stem);
}

/* ── Overlap F1 score between two bags ── */
function overlap(queryBag, refBag) {
  if (!queryBag.length || !refBag.length) return 0;
  const qSet = new Set(queryBag);
  const rSet = new Set(refBag);
  let hits = 0;
  for (const t of qSet) if (rSet.has(t)) hits++;
  const precision = hits / qSet.size;
  const recall    = hits / rSet.size;
  if (!precision && !recall) return 0;
  return 2 * precision * recall / (precision + recall);
}

/* ── Tag bonus ── */
function tagBonus(queryRaw, tags) {
  const q = queryRaw.toLowerCase();
  let bonus = 0;
  for (const tag of tags) if (q.includes(tag)) bonus += 0.2;
  return Math.min(bonus, 0.5);
}

/* ── Find best matching Q&A entry ── */
function findAnswer(query, qaData) {
  const qBag = bag(query);
  let best = null;
  let bestScore = 0;

  for (const entry of qaData) {
    let entryScore = 0;
    for (const q of entry.questions) {
      const s = overlap(qBag, bag(q));
      if (s > entryScore) entryScore = s;
    }
    const answerScore = overlap(qBag, bag(entry.answer)) * 0.4;
    entryScore = Math.max(entryScore, answerScore);
    entryScore += tagBonus(query, entry.tags);

    if (entryScore > bestScore) {
      bestScore = entryScore;
      best = entry;
    }
  }

  return bestScore >= 0.12 ? { entry: best, score: bestScore } : null;
}

/* ── Fallback responses ── */
const FALLBACKS = [
  "I don't have specific information on that, but I'd be happy to connect you with an Aether specialist. Click 'Request a Quote' and our team will respond within 24 hours.",
  "That's a great question — one that deserves a personal conversation with our aviation consultants. Use the 'Request a Quote' button and we'll be in touch shortly.",
  "I'm not certain about the details of that, but our team can provide comprehensive answers. Would you like me to suggest some questions I can help with?",
];
let fallbackIdx = 0;
function fallback() {
  return FALLBACKS[fallbackIdx++ % FALLBACKS.length];
}

/* ── Format timestamp ── */
function formatTime(date) {
  return date.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
}

/* ── Strip HTML tags from text for TTS ── */
function stripHtml(html) {
  return html
    .replace(/<br\s*\/?>/gi, '. ')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/* ─────────────────────────────────────────────────────────
   TTS — Web Speech API wrapper
   ───────────────────────────────────────────────────────── */
class AetherTTS {
  constructor() {
    this.supported  = 'speechSynthesis' in window;
    this.enabled    = true;
    this.speaking   = false;
    this._voice     = null;
    this._onSpeakStart = null;
    this._onSpeakEnd   = null;

    if (this.supported) this._loadVoices();
  }

  _loadVoices() {
    const pick = () => {
      const voices = window.speechSynthesis.getVoices();
      if (!voices.length) return;

      /* Priority list — ordered from most premium to fallback */
      const PRIORITY = [
        v => /google uk english female/i.test(v.name),
        v => /google uk english/i.test(v.name),
        v => /microsoft (zira|jenny|aria|natasha)/i.test(v.name),
        v => v.lang === 'en-GB' && v.localService,
        v => v.lang === 'en-US' && v.localService,
        v => /^en-GB/i.test(v.lang),
        v => /^en-US/i.test(v.lang),
        v => /^en/i.test(v.lang),
      ];

      for (const test of PRIORITY) {
        const match = voices.find(test);
        if (match) { this._voice = match; break; }
      }
    };

    pick();
    if (!this._voice) {
      window.speechSynthesis.addEventListener('voiceschanged', pick, { once: true });
    }
  }

  speak(text) {
    if (!this.supported || !this.enabled) return;

    /* Cancel any in-progress speech */
    window.speechSynthesis.cancel();

    const clean = stripHtml(text);
    if (!clean) return;

    const utt = new SpeechSynthesisUtterance(clean);
    utt.rate   = 0.92;   // slightly slower — calm, authoritative tone
    utt.pitch  = 0.95;
    utt.volume = 1;
    if (this._voice) utt.voice = this._voice;

    utt.onstart = () => {
      this.speaking = true;
      this._onSpeakStart?.();
    };
    utt.onend = utt.onerror = () => {
      this.speaking = false;
      this._onSpeakEnd?.();
    };

    /* Chrome bug: long utterances get cut off — split at sentence boundaries */
    const sentences = clean.match(/[^.!?]+[.!?]*/g) || [clean];
    if (sentences.length > 1) {
      this._speakChunked(sentences);
    } else {
      window.speechSynthesis.speak(utt);
    }
  }

  _speakChunked(sentences) {
    sentences.forEach((sentence, i) => {
      const utt = new SpeechSynthesisUtterance(sentence.trim());
      utt.rate   = 0.92;
      utt.pitch  = 0.95;
      utt.volume = 1;
      if (this._voice) utt.voice = this._voice;

      if (i === 0) utt.onstart = () => { this.speaking = true; this._onSpeakStart?.(); };
      if (i === sentences.length - 1) {
        utt.onend = utt.onerror = () => { this.speaking = false; this._onSpeakEnd?.(); };
      }

      window.speechSynthesis.speak(utt);
    });
  }

  stop() {
    if (!this.supported) return;
    window.speechSynthesis.cancel();
    this.speaking = false;
    this._onSpeakEnd?.();
  }

  toggle() {
    this.enabled = !this.enabled;
    if (!this.enabled) this.stop();
    return this.enabled;
  }
}

/* ─────────────────────────────────────────────────────────
   AetherChat — main class
   ───────────────────────────────────────────────────────── */
class AetherChat {
  constructor() {
    this.qaData      = [];
    this.isOpen      = false;
    this.isThinking  = false;
    this.msgCount    = 0;
    this.trigger     = null;
    this.panel       = null;
    this.overlay     = null;
    this.messagesEl  = null;
    this.inputEl     = null;
    this.sendBtn     = null;
    this.suggestionsEl = null;
    this.ttsBtn      = null;
    this.statusDot   = null;
    this.statusText  = null;
    this.tts         = new AetherTTS();
  }

  async init() {
    try {
      const res = await fetch('./data/qa.json');
      this.qaData = await res.json();
    } catch {
      console.warn('[AetherChat] Could not load qa.json — running without Q&A data.');
    }
    this._buildDOM();
    this._bindEvents();
    this._wiresTTS();
    this._showWelcome();
  }

  /* ── DOM Construction ── */
  _buildDOM() {
    /* Overlay (mobile backdrop) */
    const overlay = document.createElement('div');
    overlay.id = 'chat-overlay';
    document.body.appendChild(overlay);
    this.overlay = overlay;

    /* Trigger button */
    const trigger = document.createElement('button');
    trigger.id = 'chat-trigger';
    trigger.setAttribute('aria-label', 'Open AI Assistant');
    trigger.innerHTML = `
      <svg class="icon-chat" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6">
        <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
      </svg>
      <svg class="icon-close" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
        <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
      </svg>
      <span class="chat-badge" id="chat-badge"></span>`;
    document.body.appendChild(trigger);
    this.trigger = trigger;

    /* Chat panel */
    const ttsUnavailable = !this.tts.supported ? 'style="display:none"' : '';
    const panel = document.createElement('div');
    panel.id = 'chat-panel';
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-label', 'Aether AI Assistant');
    panel.innerHTML = `
      <div class="chat-header">
        <div class="chat-header-avatar">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
            <circle cx="12" cy="12" r="3"/><path d="M12 1v4M12 19v4M4.22 4.22l2.83 2.83M16.95 16.95l2.83 2.83M1 12h4M19 12h4M4.22 19.78l2.83-2.83M16.95 7.05l2.83-2.83"/>
          </svg>
        </div>
        <div class="chat-header-info">
          <div class="chat-header-name">Aether AI</div>
          <div class="chat-header-status">
            <span class="chat-status-dot" id="chat-status-dot"></span>
            <span class="chat-status-text" id="chat-status-text">Online — Private Aviation</span>
          </div>
        </div>
        <button id="chat-tts-btn" class="chat-tts-btn" aria-label="Toggle voice" title="Toggle voice on/off" ${ttsUnavailable}>
          <svg class="tts-icon-on" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6">
            <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/>
            <path d="M15.54 8.46a5 5 0 0 1 0 7.07"/>
            <path d="M19.07 4.93a10 10 0 0 1 0 14.14"/>
          </svg>
          <svg class="tts-icon-off" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6">
            <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/>
            <line x1="23" y1="9" x2="17" y2="15"/>
            <line x1="17" y1="9" x2="23" y2="15"/>
          </svg>
          <span class="tts-label">Voice</span>
        </button>
      </div>

      <div class="chat-messages" id="chat-messages"></div>

      <div class="chat-suggestions" id="chat-suggestions">
        <div class="chat-suggestions-label">Suggested questions</div>
        <div class="suggestion-chips">
          <button class="suggestion-chip">Range of the G700</button>
          <button class="suggestion-chip">Interior options</button>
          <button class="suggestion-chip">Pricing & quotes</button>
          <button class="suggestion-chip">How to use the configurator</button>
          <button class="suggestion-chip">Cabin amenities</button>
          <button class="suggestion-chip">Operating costs</button>
        </div>
      </div>

      <div class="chat-input-area">
        <textarea
          id="chat-input"
          placeholder="Ask about the aircraft, options, pricing…"
          rows="1"
          aria-label="Type your message"
        ></textarea>
        <button id="chat-send" aria-label="Send message" disabled>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/>
          </svg>
        </button>
      </div>`;

    document.body.appendChild(panel);
    this.panel        = panel;
    this.messagesEl   = panel.querySelector('#chat-messages');
    this.inputEl      = panel.querySelector('#chat-input');
    this.sendBtn      = panel.querySelector('#chat-send');
    this.suggestionsEl = panel.querySelector('#chat-suggestions');
    this.ttsBtn       = panel.querySelector('#chat-tts-btn');
    this.statusDot    = panel.querySelector('#chat-status-dot');
    this.statusText   = panel.querySelector('#chat-status-text');
  }

  /* ── TTS wiring ── */
  _wiresTTS() {
    if (!this.tts.supported) return;

    /* Sync TTS speaking callbacks → status indicator */
    this.tts._onSpeakStart = () => this._setSpeakingState(true);
    this.tts._onSpeakEnd   = () => this._setSpeakingState(false);

    /* Toggle button */
    this.ttsBtn.addEventListener('click', () => {
      const on = this.tts.toggle();
      this._updateTtsBtn(on);
    });

    /* Initialise button appearance (on by default) */
    this._updateTtsBtn(true);
  }

  _updateTtsBtn(enabled) {
    if (!this.ttsBtn) return;
    this.ttsBtn.classList.toggle('tts-off', !enabled);
    this.ttsBtn.setAttribute('aria-label', enabled ? 'Voice on — click to mute' : 'Voice off — click to enable');
    this.ttsBtn.title = enabled ? 'Voice on — click to mute' : 'Voice off — click to enable';
  }

  _setSpeakingState(speaking) {
    if (!this.statusDot || !this.statusText) return;
    this.statusDot.classList.toggle('speaking', speaking);
    this.statusText.textContent = speaking ? 'Speaking…' : 'Online — Private Aviation';
  }

  /* ── Event Wiring ── */
  _bindEvents() {
    this.trigger.addEventListener('click', () => this.toggle());
    this.overlay.addEventListener('click', () => this.close());
    this.sendBtn.addEventListener('click', () => this._send());

    this.inputEl.addEventListener('keydown', e => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        this._send();
      }
    });

    this.inputEl.addEventListener('input', () => {
      this.sendBtn.disabled = !this.inputEl.value.trim() || this.isThinking;
      this._resizeInput();
    });

    this.panel.querySelectorAll('.suggestion-chip').forEach(chip => {
      chip.addEventListener('click', () => {
        this.inputEl.value = chip.textContent;
        this.sendBtn.disabled = false;
        chip.style.opacity = '0.4';
        chip.style.pointerEvents = 'none';
        setTimeout(() => this._send(), 80);
      });
    });

    document.addEventListener('keydown', e => {
      if (e.key === 'Escape' && this.isOpen) this.close();
    });
  }

  _resizeInput() {
    this.inputEl.style.height = 'auto';
    this.inputEl.style.height = Math.min(this.inputEl.scrollHeight, 100) + 'px';
  }

  /* ── Open / Close ── */
  toggle() { this.isOpen ? this.close() : this.open(); }

  open() {
    this.isOpen = true;
    this.panel.classList.add('open');
    this.trigger.classList.add('open');
    this.trigger.setAttribute('aria-label', 'Close AI Assistant');
    if (window.innerWidth <= 768) this.overlay.classList.add('visible');
    document.getElementById('chat-badge').classList.remove('visible');
    setTimeout(() => this.inputEl.focus(), 320);
  }

  close() {
    this.isOpen = false;
    this.panel.classList.remove('open');
    this.trigger.classList.remove('open');
    this.trigger.setAttribute('aria-label', 'Open AI Assistant');
    this.overlay.classList.remove('visible');
    this.tts.stop();
  }

  /* ── Welcome message ── */
  _showWelcome() {
    this._addDivider('Now');
    const welcomeText = 'Welcome to Aether Private Aviation. I\'m here to help you explore the Gulfstream G700 and answer any questions about the configurator, specifications, or ownership. What would you like to know?';
    this._addMsg(
      'assistant',
      'Welcome to <strong>Aether Private Aviation</strong>. I\'m here to help you explore the Gulfstream G700 and answer any questions about the configurator, specifications, or ownership.\n\nWhat would you like to know?',
      welcomeText
    );
  }

  /* ── Send a user message ── */
  _send() {
    const text = this.inputEl.value.trim();
    if (!text || this.isThinking) return;

    if (this.msgCount === 0) {
      this.suggestionsEl.style.transition = 'opacity 0.2s ease';
      this.suggestionsEl.style.opacity = '0';
      setTimeout(() => { this.suggestionsEl.style.display = 'none'; }, 280);
    }

    this.inputEl.value = '';
    this.inputEl.style.height = 'auto';
    this.sendBtn.disabled = true;
    this.msgCount++;

    /* Stop any current speech when user sends a new message */
    this.tts.stop();

    this._addMsg('user', this._escape(text));
    this._showTyping();

    const delay = 600 + Math.random() * 700;
    setTimeout(() => this._respond(text), delay);
  }

  /* ── Generate a response ── */
  _respond(query) {
    this._hideTyping();

    const match = findAnswer(query, this.qaData);
    const answer = match ? match.entry.answer : fallback();
    const html   = this._formatAnswer(answer);

    this._addMsg('assistant', html, answer);

    if (!match) {
      setTimeout(() => this._showSuggestionNote(), 300);
    }
  }

  /* ── Message helpers ── */

  /* speakText is the plain-text version for TTS; html is displayed in chat */
  _addMsg(role, html, speakText) {
    const el = document.createElement('div');
    el.className = `msg ${role}`;
    const time = formatTime(new Date());

    if (role === 'user') {
      el.innerHTML = `
        <span class="msg-time">${time}</span>
        <div class="msg-bubble">${html}</div>`;
    } else {
      el.innerHTML = `
        <div class="msg-bubble">${html}</div>
        <span class="msg-time">${time}</span>`;
    }

    this.messagesEl.appendChild(el);
    this._scrollBottom();

    if (role === 'assistant') {
      if (!this.isOpen) {
        document.getElementById('chat-badge').classList.add('visible');
      }
      /* Speak the response (TTS decides if enabled) */
      if (speakText) this.tts.speak(speakText);
    }
  }

  _addDivider(label) {
    const el = document.createElement('div');
    el.className = 'chat-divider';
    el.innerHTML = `<span>${label}</span>`;
    this.messagesEl.appendChild(el);
  }

  _showTyping() {
    this.isThinking = true;
    const el = document.createElement('div');
    el.className = 'typing-indicator';
    el.id = 'chat-typing';
    el.innerHTML = `
      <div class="typing-bubble">
        <span class="typing-dot"></span>
        <span class="typing-dot"></span>
        <span class="typing-dot"></span>
      </div>`;
    this.messagesEl.appendChild(el);
    this._scrollBottom();
  }

  _hideTyping() {
    this.isThinking = false;
    const el = this.messagesEl.querySelector('#chat-typing');
    if (el) el.remove();
  }

  _scrollBottom() {
    requestAnimationFrame(() => {
      this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
    });
  }

  _showSuggestionNote() {
    const suggestions = ['Range of the G700', 'Interior options', 'Pricing & quotes', 'Cabin amenities'];
    const html = suggestions.map(s =>
      `<button class="suggestion-chip" style="font-size:11px;">${s}</button>`
    ).join('');

    const el = document.createElement('div');
    el.className = 'msg assistant';
    el.style.marginTop = '-6px';
    el.innerHTML = `
      <div class="msg-bubble" style="font-size:12px; color: var(--text-mid);">
        Here are some topics I can help with:
        <div class="suggestion-chips" style="margin-top:8px; flex-wrap:wrap;">${html}</div>
      </div>`;

    el.querySelectorAll('.suggestion-chip').forEach(chip => {
      chip.addEventListener('click', () => {
        this.inputEl.value = chip.textContent;
        this.sendBtn.disabled = false;
        setTimeout(() => this._send(), 80);
      });
    });

    this.messagesEl.appendChild(el);
    this._scrollBottom();
  }

  _formatAnswer(text) {
    return text
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/\n/g, '<br>');
  }

  _escape(text) {
    return text
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/\n/g, '<br>');
  }
}

/* ── Initialise on load ── */
const aetherChat = new AetherChat();
aetherChat.init();

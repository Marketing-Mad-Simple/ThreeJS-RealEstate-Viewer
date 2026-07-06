// AI Assistant — Fuse.js fuzzy search (instant) + optional LLM via Transformers.js
(function () {
  'use strict';

  let fuse = null;
  let llm = null;
  let modelState = 'idle'; // idle | loading | ready | error
  let chatHistory = [];    // [{role, content}] kept for LLM multi-turn context
  let pendingStall = null; // Last suggested stall, resolved on next "yes" reply

  // ── TTS (Web Speech API) ─────────────────────────────────────────────────────
  let ttsEnabled = true;
  let cachedVoices = [];

  if (window.speechSynthesis) {
    const loadVoices = () => { cachedVoices = speechSynthesis.getVoices(); };
    speechSynthesis.addEventListener('voiceschanged', loadVoices);
    loadVoices();
  }

  function ttsSpeak(text) {
    if (!ttsEnabled || !window.speechSynthesis) return;
    window.speechSynthesis.cancel();
    const clean = text
      .replace(/•\s*/g, '')      // bullet points
      .replace(/\[.*?\]/g, '')   // [Category] tags
      .replace(/\n+/g, '. ')     // newlines → sentence break
      .replace(/\s{2,}/g, ' ')
      .trim();
    if (!clean) return;
    const utt = new SpeechSynthesisUtterance(clean);
    utt.lang = 'en-US';
    utt.rate = 1.05;
    const voice =
      cachedVoices.find(v => /en[-_](US|GB)/i.test(v.lang) && v.localService && /female|zira|samantha|karen|moira|fiona|victoria|tessa/i.test(v.name))
      || cachedVoices.find(v => /en/i.test(v.lang) && /female|zira|samantha|karen|moira|fiona|victoria|tessa/i.test(v.name))
      || cachedVoices.find(v => /samantha|zira|karen/i.test(v.name))
      || cachedVoices.find(v => /en[-_](US|GB)/i.test(v.lang) && v.localService)
      || cachedVoices.find(v => /en/i.test(v.lang));
    if (voice) utt.voice = voice;
    window.speechSynthesis.speak(utt);
  }

  window.toggleTTS = function() {
    ttsEnabled = !ttsEnabled;
    const btn = document.getElementById('aiTtsBtn');
    if (btn) {
      btn.textContent = ttsEnabled ? '🔊' : '🔇';
      btn.classList.toggle('tts-on', ttsEnabled);
    }
    if (!ttsEnabled && window.speechSynthesis) window.speechSynthesis.cancel();
  };

  // ── Intent patterns ──────────────────────────────────────────────────────────
  const RE_NAV    = /\b(take me|navigate|go to|directions?|route|bring me|walk me|get me)\b/i;
  const RE_NEARBY = /\b(near(by)?|close|around me|closest)\b/i;
  const RE_HELP   = /\b(help|what can you|commands?|how do i)\b/i;
  const RE_YES    = /^(yes|yeah|sure|ok|yep|please|navigate|take me|go|start|do it)\b/i;
  const RE_DIST   = /\b(how far|distance|far is|far from|how long|how many metres?|how many meters?)\b/i;
  const RE_EXIST  = /\b(is there|do you have|any|exist|find|are there|show me|looking for|which)\b/i;
  const RE_ABOUT  = /\b(what (is|are|does)|tell me about|describe|about|info(rmation)?|details?|more about|who (is|are))\b/i;

  // ── Stall helpers ────────────────────────────────────────────────────────────
  function validStalls() {
    return (window.STALL_DATA || []).filter(s =>
      !/^(EMPTY|RESERV|RESERVED|BOOKED)/.test((s.company || '').trim().toUpperCase())
    );
  }

  function initFuse() {
    if (fuse || typeof Fuse === 'undefined') return;
    fuse = new Fuse(validStalls(), {
      keys: [
        { name: 'company',  weight: 0.5  },
        { name: 'keywords', weight: 0.35 }, // array field — Fuse searches each element
        { name: 'category', weight: 0.1  },
        { name: 'id',       weight: 0.05 }, // ID handled separately via exact/prefix
      ],
      threshold: 0.4,
      includeScore: true,
      minMatchCharLength: 2,
    });
  }

  function searchStalls(q, n) {
    // Strip punctuation and normalise whitespace so "B17?" and "B17" both match
    const raw = (q || '').replace(/[?!.,;:'"]/g, '').replace(/\s+/g, ' ').trim();
    if (!raw) return [];
    const all = validStalls();
    const upper = raw.toUpperCase();

    // 1. Exact ID match — trim stall IDs too in case data has trailing spaces
    const exact = all.filter(s => (s.id || '').trim().toUpperCase() === upper);
    if (exact.length) return exact.map(s => ({ item: s, score: 0 }));

    // 2. Prefix ID match (e.g. "B2" → B20, B21 …)
    if (upper.length >= 2) {
      const prefix = all.filter(s => (s.id || '').trim().toUpperCase().startsWith(upper));
      if (prefix.length) return prefix.slice(0, n || 5).map(s => ({ item: s, score: 0.05 }));
    }

    // 3. Fuse fuzzy match on company + id
    if (!fuse) return [];
    return fuse.search(raw).slice(0, n || 5);
  }

  function nearbyStalls(n) {
    const ax = window.aX || 0, az = window.aZ || 0;
    return validStalls()
      .map(s => ({ ...s, d: Math.hypot(s.x - ax, s.z - az) }))
      .sort((a, b) => a.d - b.d)
      .slice(0, n || 5);
  }

  function distFrom(stall) {
    return Math.hypot(stall.x - (window.aX || 0), stall.z - (window.aZ || 0));
  }

  function distText(stall) {
    const d = distFrom(stall);
    const metres = Math.round(d * 5);
    const secs   = Math.round(d * 5 / 1.2);
    const time   = secs < 60 ? `~${secs}s` : `~${Math.round(secs / 60)}min`;
    return { metres, time };
  }

  // Strip navigation command words to get the bare search query
  function extractQuery(text) {
    return text
      .replace(/\b(take me to|navigate to|go to|directions? to|route to|bring me to|walk me to|get me to)\s+/gi, '')
      .replace(/\b(where is|find|look(?:ing)? for|search for|locate|show me|how far is|how far from|distance to|distance from)\s+/gi, '')
      .replace(/\b(is there|do you have|any|are there)\s+/gi, '')
      .replace(/\b(the|a|an)\s+/g, ' ')
      .replace(/\b(stall|booth|stand)\b/gi, '')
      .trim();
  }

  // ── Navigation execution ─────────────────────────────────────────────────────
  function doNav(stall) {
    if (typeof window.aiNavigateTo === 'function') {
      window.aiNavigateTo(stall);
    } else if (typeof window.setDestination === 'function') {
      window.setDestination(stall);
    }
  }

  // ── Category / keyword search ────────────────────────────────────────────────
  // Searches company name, category, and keywords array for the given term
  function categorySearch(term, n) {
    const k = term.toLowerCase();
    return validStalls().filter(s => {
      if ((s.company  || '').toLowerCase().includes(k)) return true;
      if ((s.category || '').toLowerCase().includes(k)) return true;
      return (s.keywords || []).some(kw => kw.toLowerCase().includes(k));
    }).slice(0, n || 6);
  }

  // Format a stall as a one-line result including category hint
  function stallLine(s) {
    return s.category
      ? `• ${s.id}: ${s.company} [${s.category}]`
      : `• ${s.id}: ${s.company}`;
  }

  // Extract keyword terms from the query (words not in stop list), returns array
  const STOP_WORDS = new Set([
    'stall','stalls','booth','booths','stand','stands','company','companies',
    'any','there','here','the','an','a','is','are','do','you','have','find',
    'show','me','i','want','to','know','about','related','for','what','which',
    'in','at','convention','center','hall','expo',
    // extra noise verbs / prepositions often left after extractQuery
    'with','looking','deals','deal','need','some','like','does','searching',
    'offer','sell','has','get','got','see','this','that','from','who',
  ]);
  function extractCategory(text) {
    const words = text.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/);
    return words.filter(w => w.length > 2 && !STOP_WORDS.has(w));
  }

  // ── Rule-based responses (instant, no LLM needed) ───────────────────────────
  function ruleReply(text, matches) {
    const lo = text.toLowerCase();

    if (RE_HELP.test(lo)) {
      return {
        msg: 'I can help you navigate the convention!\n\nTry saying:\n• "Take me to Honda"\n• "Navigate me to B20"\n• "How far is SOTI?"\n• "Are there any engineering stalls?"\n• "What\'s nearby?"',
      };
    }

    if (RE_NEARBY.test(lo)) {
      const nb = nearbyStalls(5);
      if (!nb.length) return { msg: "I don't know your location yet — start walking first!" };
      const list = nb.map(s => `• ${s.id}: ${s.company} (~${Math.round(s.d * 5)}m)`).join('\n');
      return { msg: `Stalls near you:\n${list}` };
    }

    if (/\b(list|all stalls|how many stalls)\b/i.test(lo)) {
      return { msg: `There are ${validStalls().length} active stalls. Ask me to find a specific company or category!` };
    }

    // Distance query with a known stall
    if (RE_DIST.test(lo) && matches.length) {
      const s = matches[0].item;
      const { metres, time } = distText(s);
      return {
        msg: `${s.company} (${s.id}) is ~${metres}m away — about a ${time} walk.\nShould I navigate you there?`,
        pending: s,
      };
    }

    // "About" query for a known stall — return brief with category + keywords
    if (RE_ABOUT.test(lo) && matches.length) {
      const s = matches[0].item;
      const lines = [`${s.company} — stall ${s.id}`];
      if (s.category) lines.push(`Category: ${s.category}`);
      if (s.keywords && s.keywords.length) {
        lines.push(`Specialties: ${s.keywords.slice(0, 5).join(', ')}`);
      }
      lines.push('Want me to navigate you there?');
      return { msg: lines.join('\n'), pending: s };
    }

    // Navigation with a match
    if (matches.length) {
      const isNav = RE_NAV.test(text);
      const top = matches[0];
      const s = top.item;
      const isGoodMatch = !top.score || top.score < 0.22;

      if ((matches.length === 1 || isGoodMatch) && isNav) {
        return { msg: `Navigating to ${s.company} (${s.id})!`, nav: s };
      }

      if (matches.length === 1 || isGoodMatch) {
        return {
          msg: `Found: ${s.company} at stall ${s.id}${s.category ? ' [' + s.category + ']' : ''}.\nShould I navigate you there?`,
          pending: s,
        };
      }

      // Multiple matches — include category to help user distinguish
      const list = matches.slice(0, 4).map(m => stallLine(m.item)).join('\n');
      return {
        msg: isNav
          ? `Found a few options:\n${list}\n\nWhich one should I take you to?`
          : `Here's what I found:\n${list}\n\nSay "take me to [name]" to navigate there.`,
      };
    }

    // Category / keyword search — no direct name match, search across all fields
    const catTerms = extractCategory(lo);
    if (catTerms.length) {
      // Search each extracted term independently and union results
      const seen = new Set();
      const catResults = [];
      for (const term of catTerms) {
        categorySearch(term, 6).forEach(s => {
          if (!seen.has(s.id)) { seen.add(s.id); catResults.push(s); }
        });
      }
      if (catResults.length) {
        const label = catTerms.join(', ');
        const list = catResults.slice(0, 6).map(s => stallLine(s)).join('\n');
        return { msg: `Found ${catResults.length} stall${catResults.length > 1 ? 's' : ''} matching "${label}":\n${list}` };
      }
    }

    // Navigation intent but no stall found
    if (RE_NAV.test(lo)) {
      const q = extractQuery(text);
      return { msg: `I couldn't find a stall called "${q}". Check the spelling or try a partial name.` };
    }

    return { msg: "I couldn't find any stalls matching that. Try a company name, stall ID, or keyword." };
  }

  // ── Detect unhelpful LLM output ──────────────────────────────────────────────
  function isUnhelpful(text) {
    if (!text || text.trim().length < 8) return true;
    // Refusals / apologies
    if (/\b(i'?m sorry|i am sorry|i can'?t|i cannot|i don'?t|i do not|i apologize|unfortunately|i'?m unable|as an ai)\b/i.test(text)) return true;
    // Stall IDs — LLM must not invent these (pattern: letter + 1-3 digits, e.g. B20, A3)
    if (/\b[A-Z]\d{1,3}\b/.test(text)) return true;
    // Made-up distances / times (e.g. "20-minute walk", "150 metres")
    if (/\b\d+[\s-]*(minute|min|second|sec|metre|meter|m)\b/i.test(text)) return true;
    return false;
  }

  // ── LLM call — last resort for purely conversational queries ─────────────────
  async function llmReply(text) {
    if (!llm) return null;
    const system = 'You are a helpful assistant for a convention center. Answer briefly in 1-2 sentences. Do not mention stall IDs, distances, or specific exhibitor names.';
    const messages = [
      { role: 'system', content: system },
      ...chatHistory.slice(-4),
      { role: 'user', content: text },
    ];
    try {
      const out = await llm(messages, { max_new_tokens: 60, temperature: 0.7, do_sample: true });
      const gen = out[0].generated_text;
      const raw = gen[gen.length - 1].content;
      return isUnhelpful(raw) ? null : raw;
    } catch (e) {
      console.warn('[AI] inference error:', e);
      return null;
    }
  }

  // ── Main message handler ─────────────────────────────────────────────────────
  // Rule-based (Fuse.js + intent) is PRIMARY and authoritative.
  // LLM is only consulted for open-ended conversational queries with no stall matches.
  async function handleMsg(text) {
    text = text.trim();
    if (!text) return null;

    // Resolve pending "yes" follow-up
    if (pendingStall && RE_YES.test(text)) {
      const s = pendingStall;
      pendingStall = null;
      doNav(s);
      return `Navigating to ${s.company} (${s.id})!`;
    }

    const query = extractQuery(text);
    let matches = searchStalls(query, 5);

    // If Fuse found nothing on the full query, try each extracted keyword term
    // so "find me forklifts" hits the keyword index on "forklifts" alone
    if (!matches.length) {
      for (const term of extractCategory(text)) {
        const r = searchStalls(term, 5);
        if (r.length) { matches = r; break; }
      }
    }

    // If intent is navigation or distance but extractQuery found nothing,
    // scan the original text for a stall ID pattern (e.g. "B17") as a fallback
    if (!matches.length && (RE_NAV.test(text) || RE_DIST.test(text))) {
      const idInText = text.match(/\b([A-Za-z]\d{1,3})\b/);
      if (idInText) matches = searchStalls(idInText[1], 5);
    }

    const ruled = ruleReply(text, matches);

    // Rule-based is definitive for any stall/navigation related intent
    const ruleIsDefinitive =
      ruled.nav      ||          // clear single-stall nav
      ruled.pending  ||          // single match awaiting confirm
      matches.length > 0 ||      // found stalls
      RE_NEARBY.test(text) ||    // nearby request
      RE_HELP.test(text)   ||    // help request
      RE_NAV.test(text)    ||    // any navigation intent
      RE_DIST.test(text)   ||    // distance query
      RE_EXIST.test(text)  ||    // existence/search query
      RE_ABOUT.test(text);       // stall brief / info query

    if (ruleIsDefinitive) {
      if (ruled.nav) doNav(ruled.nav);
      pendingStall = ruled.pending || null;
      pushHistory(text, ruled.msg);
      return ruled.msg;
    }

    // Only reach here for genuinely open-ended conversational queries.
    const llmAnswer = modelState === 'ready' ? await llmReply(text) : null;
    const reply = llmAnswer || ruled.msg;

    pendingStall = null;
    pushHistory(text, reply);
    return reply;
  }

  function pushHistory(userText, assistantText) {
    chatHistory.push({ role: 'user', content: userText });
    chatHistory.push({ role: 'assistant', content: assistantText });
    if (chatHistory.length > 20) chatHistory = chatHistory.slice(-20);
  }

  // ── Model loading ─────────────────────────────────────────────────────────────
  const MODEL_CANDIDATES = [
    'HuggingFaceTB/SmolLM2-135M-Instruct',
    'Xenova/TinyLlama-1.1B-Chat-v1.0',
  ];

  // iOS/Android kill the tab when the model exceeds their per-tab memory limit.
  // Fuse.js handles all navigation queries without the LLM, so skip it on mobile.
  function isMobileDevice() {
    if (/iPhone|iPad|iPod|Android/i.test(navigator.userAgent)) return true;
    // iPad with iOS 13+ reports MacIntel but has touch points
    if (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1) return true;
    return false;
  }

  async function loadModel() {
    if (modelState !== 'idle') return;

    if (isMobileDevice()) {
      modelState = 'error';
      setBadge('ready', 'Search Mode');
      addMsg('assistant', 'Smart stall search is ready! Ask me:\n• "How far is stall B17?"\n• "Are there any mechanical stalls?"\n• "Navigate me to Honda"\n• "What\'s nearby?"');
      return;
    }

    modelState = 'loading';
    setBadge('loading', 'Loading…');

    try {
      const { pipeline, env } = await import(
        'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3/dist/transformers.min.js'
      );
      env.allowLocalModels = false;

      for (const modelId of MODEL_CANDIDATES) {
        for (const device of ['webgpu', 'wasm']) {
          try {
            llm = await pipeline('text-generation', modelId, {
              dtype: 'q4',
              device,
              progress_callback: ({ status, progress }) => {
                if (status === 'downloading' || status === 'loading') {
                  setBadge('loading', progress ? Math.round(progress) + '%' : '…');
                }
              },
            });
            modelState = 'ready';
            const shortName = modelId.split('/')[1];
            setBadge('ready', shortName);
            addMsg('assistant', 'AI model loaded! I can now answer general questions too.');
            return;
          } catch (err) {
            console.warn(`[AI] ${modelId} on ${device} failed:`, err.message);
            llm = null;
          }
        }
      }
      throw new Error('all models/devices failed');
    } catch (e) {
      modelState = 'error';
      setBadge('error', 'Offline');
      console.error('[AI] Model load failed:', e);
      addMsg('assistant', 'AI model unavailable — smart stall search is still active! Ask me about any stall or say "Nearby stalls".');
    }
  }

  // ── UI helpers ───────────────────────────────────────────────────────────────
  function setBadge(cls, txt) {
    const el = document.getElementById('aiModelBadge');
    if (!el) return;
    el.className = cls;
    el.textContent = txt;
  }

  function addMsg(role, text) {
    const wrap = document.getElementById('aiMessages');
    if (!wrap) return null;
    const div = document.createElement('div');
    div.className = 'ai-msg ' + role;
    div.textContent = text;
    wrap.appendChild(div);
    wrap.scrollTop = wrap.scrollHeight;
    if (role === 'assistant') ttsSpeak(text);
    return div;
  }

  // ── Public API ───────────────────────────────────────────────────────────────
  window.toggleAIPanel = function () {
    document.getElementById('devPanel').classList.remove('open');
    const panel = document.getElementById('aiPanel');
    const open = panel.classList.toggle('open');
    if (!open && window.speechSynthesis) window.speechSynthesis.cancel();
    if (open && modelState === 'idle') loadModel();
  };

  window.aiSend = async function () {
    const inp = document.getElementById('aiInput');
    const text = (inp.value || '').trim();
    if (!text) return;
    inp.value = '';
    inp.disabled = true;

    addMsg('user', text);
    const spinner = addMsg('assistant thinking', '…');

    const reply = await handleMsg(text);
    if (spinner) spinner.remove();
    if (reply) addMsg('assistant', reply);

    inp.disabled = false;
    inp.focus();
  };

  window.aiChip = function (txt) {
    document.getElementById('aiInput').value = txt;
    window.aiSend();
  };

  window.addEventListener('load', () => {
    setTimeout(initFuse, 150);
    const inp = document.getElementById('aiInput');
    if (inp) {
      inp.addEventListener('keydown', e => {
        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); window.aiSend(); }
      });
    }
  });

  if (window.STALL_DATA) initFuse();
})();

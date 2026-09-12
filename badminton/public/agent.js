'use strict';

/* ============================================================
   The assistant bubble.

   A button in the corner that opens a small conversation. It posts to
   /api/chat, which does the thinking and the tool calls server-side —
   no key ever comes down to the page.

   The conversation is kept on this device, one per tournament, so
   closing the page or locking the phone does not lose it. When the
   assistant changes something, the scoreboard behind the panel is
   pulled fresh straight away rather than waiting for the next poll.

   Like sync.js, this adds itself to the page and changes nothing that
   was already there.
   ============================================================ */

(function () {

  var LOG_PREFIX = 'badminton-chat-';
  var LOG_LIMIT = 60;          /* keep the last 60 lines, then forget */
  var HISTORY_TURNS = 12;      /* how much of it Gemini is reminded of */

  var log = [];                /* [{ who: 'you'|'them'|'oops'|'did', text }] */
  var loadedFor = null;        /* which tournament the log above belongs to */
  var busy = false;
  var open = false;
  var listEl, inputEl, sendEl, panelEl, buttonEl, clearEl;

  function sync() {
    return window.badmintonSync || null;
  }

  function tournamentId() {
    var s = sync();
    return s ? s.tournamentId() : null;
  }

  /* ---------- keeping the conversation ---------- */

  /* One conversation per tournament, so opening a different one does not
     show you the last one's replies. */
  function logKey() {
    return LOG_PREFIX + (tournamentId() || 'local');
  }

  function readLog(key) {
    try {
      var raw = window.localStorage.getItem(key);
      if (!raw) return [];
      var parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch (e) {
      return [];                 /* private window, or something unreadable */
    }
  }

  function saveLog() {
    if (log.length > LOG_LIMIT) log = log.slice(-LOG_LIMIT);
    try { window.localStorage.setItem(logKey(), JSON.stringify(log)); }
    catch (e) { /* out of room or no storage — the panel still works */ }
  }

  /* The tournament id arrives a moment after the page loads, so settle on
     the right conversation when the panel is opened rather than at boot. */
  function ensureLog() {
    var key = logKey();
    if (loadedFor === key) return;
    loadedFor = key;
    log = readLog(key);
    paint();
  }

  function remember(who, text) {
    log.push({ who: who, text: text });
    saveLog();
  }

  /* ---------- chrome ---------- */

  function styles() {
    return [
      '#ai-fab{position:fixed;right:14px;bottom:calc(env(safe-area-inset-bottom) + 14px);',
      'z-index:60;width:54px;height:54px;border-radius:50%;border:0;cursor:pointer;',
      'background:linear-gradient(180deg,var(--mat,#2B6053),var(--mat-deep,#1F4941));color:#fff;',
      'box-shadow:0 6px 20px rgba(31,73,65,.26);',
      'display:flex;align-items:center;justify-content:center;padding:0;',
      'transition:transform .22s var(--ease,ease),box-shadow .22s var(--ease,ease)}',
      '#ai-fab:hover{transform:translateY(-2px) scale(1.04);box-shadow:0 10px 26px rgba(31,73,65,.3)}',
      '#ai-fab:active{transform:translateY(0) scale(.98)}',
      '#ai-fab svg{transition:transform .3s var(--ease,ease)}',
      '#ai-panel.on ~ #ai-fab svg,#ai-fab:hover svg{transform:rotate(-6deg)}',
      '#ai-fab svg{width:25px;height:25px;display:block}',

      '#ai-panel{position:fixed;right:14px;bottom:calc(env(safe-area-inset-bottom) + 76px);',
      'z-index:61;width:min(380px,calc(100vw - 28px));max-height:min(68vh,560px);',
      'display:flex;flex-direction:column;background:var(--card);',
      'border:1px solid var(--hair,var(--rule));',
      'border-radius:18px;box-shadow:var(--lift-3,0 12px 34px rgba(8,48,42,.24));overflow:hidden;',
      'opacity:0;visibility:hidden;transform:translateY(14px) scale(.97);transform-origin:100% 100%;',
      'transition:opacity .28s var(--ease,ease),transform .28s var(--ease,ease),visibility 0s .28s}',
      '#ai-panel.on{opacity:1;visibility:visible;transform:none;',
      'transition:opacity .28s var(--ease,ease),transform .28s var(--ease,ease),visibility 0s}',

      '#ai-head{display:flex;align-items:center;gap:10px;padding:11px 13px;',
      'background:var(--mat-deep);color:#fff;font:600 16px/1.1 var(--cond);letter-spacing:.01em}',
      '#ai-head span{flex:1 1 auto}',
      '#ai-clear{appearance:none;background:transparent;border:0;color:#D9EDE6;cursor:pointer;',
      'font:500 12.5px/1 var(--sans);padding:3px 2px;min-height:auto;text-decoration:underline}',
      '#ai-clear:hover{color:#fff}',
      '#ai-close{appearance:none;background:transparent;border:0;color:#D9EDE6;cursor:pointer;',
      'font:400 22px/1 var(--sans);padding:0 2px;min-height:auto}',
      '#ai-close:hover{color:#fff}',

      '#ai-list{flex:1 1 auto;overflow-y:auto;padding:12px 13px;display:flex;',
      'flex-direction:column;gap:9px;background:var(--paper)}',
      '.ai-msg{max-width:85%;padding:8px 11px;border-radius:11px;font-size:14.5px;line-height:1.45;',
      'white-space:pre-wrap;overflow-wrap:anywhere}',
      '.ai-msg.them{align-self:flex-start;background:var(--card);border:1px solid var(--rule);',
      'border-bottom-left-radius:3px;color:var(--ink)}',
      '.ai-msg.you{align-self:flex-end;background:var(--mat);color:#fff;border-bottom-right-radius:3px}',
      '.ai-msg.oops{align-self:flex-start;background:var(--cork-pale);border:1px solid #DFC48E;',
      'color:var(--cork-text)}',
      '.ai-did{align-self:flex-start;font-size:12px;color:#3F544A;padding:0 3px;font-style:italic}',
      '.ai-dots{align-self:flex-start;color:#3F544A;font-size:14px;padding:6px 11px}',
      '@keyframes ai-in{from{opacity:0;transform:translateY(9px)}to{opacity:1;transform:none}}',
      '@keyframes ai-blink{0%,80%,100%{opacity:.25}40%{opacity:1}}',
      '.ai-msg,.ai-did{animation:ai-in .32s var(--ease,ease) both}',
      '.ai-dots{animation:ai-blink 1.3s ease-in-out infinite}',
      '#ai-send{transition:background .2s var(--ease,ease),transform .16s var(--ease,ease)}',
      '#ai-send:not(:disabled):hover{transform:translateY(-1px)}',
      '@media (prefers-reduced-motion:reduce){',
      '#ai-panel,.ai-msg,.ai-did,.ai-dots,#ai-fab,#ai-fab svg{animation:none!important;transition:none!important}',
      '}',

      '#ai-foot{display:flex;gap:8px;padding:10px;border-top:1px solid var(--rule);background:var(--card)}',
      '#ai-in{flex:1 1 auto;font:400 16px/1.3 var(--sans);color:var(--ink);background:#fff;',
      'border:1px solid var(--rule);border-radius:11px;padding:9px 11px;min-height:42px;',
      'resize:none;max-height:110px}',
      '#ai-send{appearance:none;border:0;background:var(--mat-deep);color:#fff;cursor:pointer;',
      'font:600 14px/1 var(--cond);letter-spacing:.03em;padding:0 15px;border-radius:11px;min-height:42px}',
      '#ai-send:disabled{background:#9FB3AD;cursor:default}',

      '@media print{#ai-fab,#ai-panel{display:none!important}}'
    ].join('');
  }

  function install() {
    var css = document.createElement('style');
    css.textContent = styles();
    document.head.appendChild(css);

    buttonEl = document.createElement('button');
    buttonEl.type = 'button';
    buttonEl.id = 'ai-fab';
    buttonEl.className = 'no-print';
    buttonEl.setAttribute('aria-label', 'Ask about the tournament');
    buttonEl.innerHTML =
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" ' +
      'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      '<path d="M21 11.5a8.4 8.4 0 0 1-9 8.4 9.5 9.5 0 0 1-3.2-.5L3 21l1.7-4.6A8.2 8.2 0 0 1 3.6 11.5 8.4 8.4 0 0 1 12 3a8.4 8.4 0 0 1 9 8.5z"/>' +
      '<circle cx="9" cy="11.5" r="1"/><circle cx="12.5" cy="11.5" r="1"/><circle cx="16" cy="11.5" r="1"/>' +
      '</svg>';

    panelEl = document.createElement('div');
    panelEl.id = 'ai-panel';
    panelEl.className = 'no-print';
    panelEl.innerHTML =
      '<div id="ai-head"><span>Ask about the tournament</span>' +
      '<button type="button" id="ai-clear">Clear</button>' +
      '<button type="button" id="ai-close" aria-label="Close">&times;</button></div>' +
      '<div id="ai-list" role="log" aria-live="polite"></div>' +
      '<div id="ai-foot">' +
      '<textarea id="ai-in" rows="1" placeholder="Ask, or tell me a result…"></textarea>' +
      '<button type="button" id="ai-send">Send</button>' +
      '</div>';

    document.body.appendChild(buttonEl);
    document.body.appendChild(panelEl);

    listEl = document.getElementById('ai-list');
    inputEl = document.getElementById('ai-in');
    sendEl = document.getElementById('ai-send');
    clearEl = document.getElementById('ai-clear');

    buttonEl.addEventListener('click', toggle);
    document.getElementById('ai-close').addEventListener('click', toggle);
    sendEl.addEventListener('click', send);
    clearEl.addEventListener('click', clearLog);

    inputEl.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
    });
    inputEl.addEventListener('input', function () {
      inputEl.style.height = 'auto';
      inputEl.style.height = Math.min(inputEl.scrollHeight, 110) + 'px';
    });
  }

  /* ---------- drawing the conversation ---------- */

  function line(entry) {
    var el = document.createElement('div');
    el.className = entry.who === 'did' ? 'ai-did' : 'ai-msg ' + entry.who;
    el.textContent = entry.text;
    listEl.appendChild(el);
    return el;
  }

  function toBottom() {
    listEl.scrollTop = listEl.scrollHeight;
  }

  /* Redraw the whole conversation — used when the panel first opens with
     something already in it. */
  function paint() {
    if (!listEl) return;
    listEl.innerHTML = '';
    log.forEach(line);
    toBottom();
  }

  function show(who, text) {
    remember(who, text);
    line({ who: who, text: text });
    toBottom();
  }

  function thinking() {
    var el = document.createElement('div');
    el.className = 'ai-dots';
    el.textContent = 'Thinking…';
    listEl.appendChild(el);
    toBottom();
    return el;
  }

  function clearLog() {
    log = [];
    try { window.localStorage.removeItem(logKey()); } catch (e) { /* nothing to remove */ }
    paint();
    greet();
  }

  function toggle() {
    open = !open;
    panelEl.classList.toggle('on', open);
    if (!open) return;
    ensureLog();
    if (!log.length) greet();
    setTimeout(function () { inputEl.focus(); }, 50);
  }

  function greet() {
    if (!tournamentId()) {
      show('them', 'This tournament is only saved on this phone at the moment, so I cannot see it yet.\n\nTap "Put it online" at the top and I will be able to answer questions about it and keep it up to date for you.');
      return;
    }
    var s = sync();
    show('them', s && s.isAdmin()
      ? 'Ask me anything, or just tell me a result and I will put it in.\n\nTry: "who is top of group B?" or "Rahul beat Anita 21-15 21-18".'
      : 'Ask me anything — who is winning, who plays next, how someone has done.\n\nTo change a score, tap Unlock scoring at the top first.');
  }

  /* ---------- talking to the server ---------- */

  /* Only the back-and-forth goes to Gemini; the "checked the tables" asides
     are for the reader, not for it. */
  function historyForGemini() {
    return log
      .filter(function (e) { return e.who === 'you' || e.who === 'them'; })
      .slice(-HISTORY_TURNS)
      .map(function (e) {
        return { role: e.who === 'you' ? 'user' : 'assistant', text: e.text };
      });
  }

  function send() {
    if (busy) return;
    var text = inputEl.value.trim();
    if (!text) return;

    ensureLog();
    var id = tournamentId();

    if (!id) {
      show('you', text);
      show('oops', 'I still cannot see this one — tap "Put it online" at the top of the page first.');
      inputEl.value = '';
      return;
    }

    var past = historyForGemini();
    show('you', text);
    inputEl.value = '';
    inputEl.style.height = 'auto';
    busy = true;
    sendEl.disabled = true;
    var waiting = thinking();

    var headers = { 'Content-Type': 'application/json' };
    var s = sync();
    var tok = s ? s.token() : '';
    if (tok) headers.Authorization = 'Bearer ' + tok;

    fetch('/api/chat', {
      method: 'POST',
      headers: headers,
      body: JSON.stringify({ tournamentId: id, message: text, history: past })
    }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (data) {
        if (!res.ok) throw new Error(data.error || ('The assistant is not answering (' + res.status + ').'));
        return data;
      });
    }).then(function (data) {
      waiting.remove();
      if (data.used && data.used.length) show('did', describeWork(data.used));
      show('them', data.text);

      /* It changed something — put the new scores on the page now rather
         than leaving them until the next poll comes round. */
      if (data.changed && s) {
        return s.refresh().then(function () {
          show('did', 'scoreboard updated');
        }, function () {
          show('oops', 'I saved that, but could not refresh the page. Pull down to reload.');
        });
      }
    }).catch(function (err) {
      waiting.remove();
      show('oops', err.message);
    }).then(function () {
      busy = false;
      sendEl.disabled = false;
      inputEl.focus();
    });
  }

  /* "checked the standings, saved a score" reads better than a list of
     function names. */
  var PLAIN = {
    get_tournament_overview: 'had a look at the tournament',
    get_standings: 'checked the tables',
    get_matches: 'looked through the fixtures',
    get_match: 'looked up the match',
    get_knockout_bracket: 'checked the knockout',
    get_player_stats: 'checked the record',
    list_players: 'looked up the players',
    list_tournaments: 'looked through the tournaments',
    get_raw_state: 'read the whole tournament',
    set_score: 'saved the score',
    set_game_score: 'saved the game',
    clear_match_score: 'cleared the match',
    set_match_winner: 'set the winner',
    set_match_note: 'added a note',
    rename_player: 'renamed a player',
    set_tournament_info: 'updated the details',
    set_rules: 'changed the scoring rules',
    pin_knockout_place: 'pinned a knockout place',
    clear_knockout_pin: 'cleared a pinned place',
    set_group_order: 'set a group order by hand',
    clear_group_order: 'cleared a hand-set group order',
    clear_seed_pin: 'cleared a pinned seed',
    find_pinned_places_that_disagree_with_the_scores: 'checked for anything pinned by hand'
  };

  function describeWork(used) {
    var seen = [];
    used.forEach(function (name) {
      var said = PLAIN[name] || name;
      if (seen.indexOf(said) < 0) seen.push(said);
    });
    return seen.join(', ');
  }

  /* ---------- start ---------- */

  function boot() {
    install();
    /* Settle the conversation once sync has had a moment to work out which
       tournament this is, so a reload shows the right one straight away. */
    setTimeout(ensureLog, 1200);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();

})();

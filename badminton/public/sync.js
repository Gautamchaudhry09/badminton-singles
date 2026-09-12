'use strict';

/* ============================================================
   Badminton tournament — live sync, scoring password, and the
   stale-override nudge.

   This file is additive. It does not change a line of the page
   it sits under: it wraps two globals (commit and render) and
   adds its own strip of UI above the tabs.

   Opening the page with no link asks the server which tournament
   is being played and opens that one, so nobody has to know a link
   exists. If the server has none, or cannot be reached, the page
   falls back to how it always worked: one device, localStorage,
   nothing on a wire. ?local=1 forces that old behaviour.
   ============================================================ */

(function () {

  /* Straight away, not on DOMContentLoaded: this script runs while the
     page is still parsing, so the sheet lands before the first paint and
     nobody sees the old colours flash past. */
  (function theme() {
    var link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = 'theme.css';
    document.head.appendChild(link);
  })();

  var TOKEN_KEY = 'badminton-admin-token';
  var NAME_KEY = 'badminton-who-am-i';
  var PUSH_DEBOUNCE_MS = 600;
  var POLL_MS = 4000;
  var TYPING_GRACE_MS = 3000;

  var tid = null;         /* tournament id from the URL, null = local only */
  var localRev = 0;       /* the rev the server confirmed for what we hold */
  var lastSent = null;    /* the state as the server last accepted it */
  var pushTimer = null;
  var pushing = false;
  var dirty = false;
  var offline = false;
  var coldOffline = false;  /* opened a live link with no signal: we cannot
                               tell how far behind this copy is, so it is
                               shown but not editable until we reconnect */
  var lastTypedAt = 0;
  var dismissed = {};
  var liveStashTimer = null;

  /* ---------- small helpers ---------- */

  function token() {
    try { return window.localStorage.getItem(TOKEN_KEY) || ''; } catch (e) { return ''; }
  }

  function setToken(v) {
    try {
      if (v) window.localStorage.setItem(TOKEN_KEY, v);
      else window.localStorage.removeItem(TOKEN_KEY);
    } catch (e) { /* private window, stay signed out */ }
  }

  function isAdmin() { return !!token(); }

  /* Editing is only gated once a tournament is shared. On your own
     device, with no link, nothing changes about how the page works. */
  function canEdit() { return !tid || (isAdmin() && !coldOffline); }

  function api(method, path, body) {
    var opts = { method: method, headers: {} };
    if (body !== undefined) {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(body);
    }
    var t = token();
    if (t) opts.headers.Authorization = 'Bearer ' + t;
    return fetch(path, opts).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (data) {
        if (res.ok) return data;
        var err = new Error(data.error || ('Request failed (' + res.status + ')'));
        err.status = res.status;
        err.data = data;
        throw err;
      });
    });
  }

  function say(msg) {
    if (typeof toast === 'function') toast(msg);
  }

  function snapshot() {
    /* toJSON() already strips the _memo scratch keys. */
    return JSON.parse(toJSON());
  }

  function liveKey(id) { return 'badminton-live-' + id; }

  /* A shared tournament gets its own drawer in localStorage. The page's
     own backup of whatever you were scoring on this device stays where
     it was, so opening someone's link never costs you your own draw. */
  function liveStash() {
    clearTimeout(liveStashTimer);
    liveStashTimer = setTimeout(function () {
      try { window.localStorage.setItem(liveKey(tid), toJSON()); } catch (e) { /* no storage here */ }
    }, 400);
  }

  function liveUnstash(id) {
    try {
      var t = window.localStorage.getItem(liveKey(id));
      if (t) return JSON.parse(t);
    } catch (e) { /* no storage here */ }
    return null;
  }

  /* ---------- the strip above the tabs ---------- */

  function installChrome() {
    var css = document.createElement('style');
    css.textContent = [
      '#sy-bar{display:flex;align-items:center;gap:9px;max-width:760px;margin:0 auto;',
      'padding:8px var(--gutter);font:500 13.5px/1.3 var(--sans);color:var(--ink-soft);',
      'background:var(--shade);border-bottom:1px solid var(--rule);flex-wrap:wrap}',
      '#sy-dot{width:9px;height:9px;border-radius:50%;background:var(--ink-soft);flex:0 0 auto}',
      '#sy-dot.live{background:#2E8B57}#sy-dot.warn{background:var(--cork)}#sy-dot.off{background:var(--alert)}',
      '#sy-msg{flex:1 1 auto;min-width:120px}',
      '.sy-btn{appearance:none;border:1px solid var(--rule);background:#fff;color:var(--ink);',
      'font:600 13px/1 var(--cond);letter-spacing:.02em;padding:8px 11px;border-radius:7px;',
      'min-height:34px;cursor:pointer}',
      '.sy-btn:hover{border-color:var(--mat)}',
      '#sy-nudges{max-width:760px;margin:0 auto;padding:0 var(--gutter)}',
      '.sy-nudge{display:flex;align-items:center;gap:10px;flex-wrap:wrap;',
      'background:var(--cork-pale);border:1px solid #E8D2A8;border-left:3px solid var(--cork);',
      'border-radius:8px;padding:9px 11px;margin:8px 0;font-size:13.5px;color:var(--cork-text)}',
      '.sy-nudge p{margin:0;flex:1 1 220px}',
      '.sy-ro #app input,.sy-ro #app select,.sy-ro #app textarea{background:var(--shade)}',

      /* ---- the sledging corner under each match ---- */
      '.sy-thread{margin:-6px 0 12px;padding:0 2px}',
      '.sy-thread-top{appearance:none;background:transparent;border:0;cursor:pointer;',
      'display:flex;align-items:center;gap:7px;padding:5px 6px;width:100%;',
      'color:var(--ink-soft);font:600 12px/1 var(--cond);letter-spacing:.07em;',
      'text-transform:uppercase;min-height:30px;border-radius:6px}',
      '.sy-thread-top:hover{background:var(--shade);color:var(--mat)}',
      '.sy-thread.on .sy-thread-top{color:var(--mat)}',
      '.sy-caret{font-size:9px;line-height:1;opacity:.8}',
      '.sy-label{white-space:nowrap}',
      '.sy-tally{background:var(--mat);color:#fff;border-radius:20px;min-width:18px;',
      'padding:2px 6px;font:600 11px/1.2 var(--sans);letter-spacing:0;text-align:center}',
      '.sy-quiet{color:#A9B7B1;font:400 11.5px/1.2 var(--sans);letter-spacing:0;',
      'text-transform:none;font-style:italic}',
      '.sy-thread-body{border-left:2px solid var(--rule);margin:2px 0 0 11px;',
      'padding:6px 0 2px 12px}',
      '.sy-comment{margin-bottom:10px}',
      '.sy-comment:last-of-type{margin-bottom:12px}',
      '.sy-comment-top{display:flex;align-items:baseline;gap:8px}',
      '.sy-comment-top b{font:600 13.5px/1.2 var(--sans);color:var(--ink)}',
      '.sy-when{font:400 11.5px/1.2 var(--sans);color:#A9B7B1}',
      '.sy-bin{appearance:none;background:transparent;border:0;cursor:pointer;margin-left:auto;',
      'color:#B6C4BD;font:400 11.5px/1.2 var(--sans);padding:2px 3px;min-height:auto}',
      '.sy-bin:hover{color:var(--alert);text-decoration:underline}',
      '.sy-comment p{margin:2px 0 0;font:400 14.5px/1.45 var(--sans);color:var(--ink);',
      'overflow-wrap:anywhere}',
      '.sy-empty{margin:0 0 12px;font:400 13.5px/1.4 var(--sans);color:#A9B7B1;font-style:italic}',
      '.sy-say-row{display:flex;gap:7px}',
      '.sy-say{flex:1 1 auto;min-width:0;font:400 15px/1.3 var(--sans)!important;',
      'min-height:38px!important;padding:7px 10px!important;border-radius:7px!important;',
      'border:1px solid var(--rule)!important;background:#fff!important;color:var(--ink)}',
      '.sy-post{appearance:none;border:0;background:var(--mat);color:#fff;cursor:pointer;',
      'font:600 13px/1 var(--cond);letter-spacing:.03em;padding:0 14px;border-radius:7px;',
      'min-height:38px;flex:0 0 auto}',
      '.sy-post:hover{background:var(--mat-deep)}',
      '.sy-asyou{margin:8px 0 0;font:400 12px/1.3 var(--sans);color:#A9B7B1}',
      '.sy-asyou b{font-weight:600;color:var(--ink-soft)}',
      '.sy-rename{appearance:none;background:transparent;border:0;cursor:pointer;',
      'color:var(--mat);font:400 12px/1.3 var(--sans);padding:0 0 0 5px;min-height:auto;',
      'text-decoration:underline}',
      '.sy-rename:hover{color:var(--mat-deep)}',
      '@media print{.sy-thread-top,.sy-say-row,.sy-asyou{display:none!important}',
      '.sy-thread-body{border-left-color:#999}}',

      '.sy-emoji{font-size:12.5px;line-height:1}',

      /* ---- asking for a name or the password ---- */
      '.sy-ask-back{position:fixed;inset:0;z-index:80;background:rgba(8,48,42,.42);',
      'display:flex;align-items:center;justify-content:center;padding:18px;',
      '-webkit-backdrop-filter:blur(2px);backdrop-filter:blur(2px)}',
      '.sy-ask{width:min(340px,100%);background:var(--card);border-radius:12px;',
      'border:1px solid var(--rule);box-shadow:0 16px 40px rgba(8,48,42,.3);padding:18px}',
      '.sy-ask h3{margin:0;font:600 20px/1.15 var(--cond);color:var(--ink)}',
      '.sy-ask p{margin:6px 0 0;font:400 13.5px/1.4 var(--sans);color:var(--ink-soft)}',
      '.sy-ask-field{width:100%;margin-top:13px;font:400 16px/1.3 var(--sans)!important;',
      'color:var(--ink);background:#fff;border:1px solid var(--rule)!important;',
      'border-radius:8px!important;padding:10px 11px!important;min-height:44px!important}',
      '.sy-ask-field:focus-visible{outline:2.5px solid var(--cork);outline-offset:1px}',
      '.sy-ask-row{display:flex;gap:8px;margin-top:14px}',
      '.sy-ask-btn{flex:1 1 0;appearance:none;cursor:pointer;border-radius:8px;min-height:44px;',
      'font:600 15px/1 var(--cond);letter-spacing:.02em;',
      'background:#fff;border:1px solid var(--rule);color:var(--ink-soft)}',
      '.sy-ask-btn:hover{border-color:var(--mat);color:var(--mat)}',
      '.sy-ask-btn.go{background:var(--mat);border-color:var(--mat);color:#fff}',
      '.sy-ask-btn.go:hover{background:var(--mat-deep);border-color:var(--mat-deep);color:#fff}',

      /* ---- final placings, on the summary ---- */
      '.sy-podium{background:var(--card);border:1px solid var(--rule);border-radius:10px;',
      'padding:14px;margin:0 0 14px}',
      '.sy-podium h2{font:600 20px/1.15 var(--cond);margin:0 0 4px;display:flex;',
      'align-items:baseline;justify-content:space-between;gap:10px}',
      '.sy-podium .sy-sub{margin:0 0 12px;color:var(--ink-soft);font-size:13.5px}',
      '.sy-place{display:flex;align-items:center;gap:12px;padding:11px 12px;margin-bottom:8px;',
      'border:1px solid var(--rule);border-radius:9px;background:var(--shade)}',
      '.sy-place:last-child{margin-bottom:0}',
      '.sy-place.p1{background:var(--cork-pale);border-color:#E8D2A8;padding:15px 12px}',
      '.sy-medal{flex:0 0 34px;width:34px;height:34px;border-radius:50%;color:#fff;',
      'font:700 16px/34px var(--cond);text-align:center;letter-spacing:0}',
      '.p1 .sy-medal{background:var(--cork);width:40px;height:40px;flex-basis:40px;',
      'font-size:19px;line-height:40px}',
      '.p2 .sy-medal{background:#8B9E96}',
      '.p3 .sy-medal{background:#A9743F}',
      '.p4 .sy-medal{background:#C3CFC9;color:var(--ink-soft)}',
      '.sy-who{flex:1 1 auto;min-width:0}',
      '.sy-name{font:700 22px/1.1 var(--cond);color:var(--ink);overflow-wrap:anywhere}',
      '.p1 .sy-name{font-size:clamp(26px,7vw,32px)}',
      '.sy-what{font:600 11.5px/1.3 var(--cond);letter-spacing:.08em;text-transform:uppercase;',
      'color:var(--ink-soft);margin-top:2px}',
      '.p1 .sy-what{color:var(--cork-text)}',
      '.sy-detail{font:400 13px/1.3 var(--sans);color:var(--ink-soft);margin-top:3px}',
      '.sy-place.sy-waiting{border-style:dashed;background:transparent}',
      '.sy-waiting .sy-name{font-weight:500;color:var(--ink-soft)}',
      '.sy-waiting .sy-medal{background:transparent;color:#B6C4BD;',
      'border:1.5px dashed var(--rule);line-height:31px}',
      '.sy-waiting.p1 .sy-medal{line-height:37px}',
      '@media print{',
      '.sy-place{background:#fff!important;border-color:#999!important;break-inside:avoid}',
      '.sy-medal{background:#fff!important;color:#000!important;border:1.5px solid #000}',
      '.sy-name,.sy-what{color:#000!important}',
      '}'
    ].join('');
    document.head.appendChild(css);

    var bar = document.createElement('div');
    bar.id = 'sy-bar';
    bar.className = 'no-print';
    bar.innerHTML =
      '<span id="sy-dot"></span>' +
      '<span id="sy-msg"></span>' +
      '<button type="button" class="sy-btn" id="sy-auth">Unlock scoring</button>';

    var nudges = document.createElement('div');
    nudges.id = 'sy-nudges';
    nudges.className = 'no-print';

    var main = document.getElementById('app');
    main.parentNode.insertBefore(bar, main);
    main.parentNode.insertBefore(nudges, main);

    document.getElementById('sy-auth').addEventListener('click', onAuth);
  }

  /* Only when you land on a tab — never on the redraw that follows a
     keystroke, or the whole page would flutter while you enter a score. */
  var lastView = null;
  var entranceTimer = null;

  function playEntrance() {
    lastView = VIEW;
    var root = document.getElementById('app');
    if (!root) return;
    root.classList.remove('sy-enter');
    void root.offsetWidth;              /* let the browser notice it went */
    root.classList.add('sy-enter');
    clearTimeout(entranceTimer);
    entranceTimer = setTimeout(function () {
      root.classList.remove('sy-enter');
    }, 900);
  }

  function paintBar() {
    var dot = document.getElementById('sy-dot');
    var msg = document.getElementById('sy-msg');
    var auth = document.getElementById('sy-auth');
    if (!dot) return;

    dot.className = '';
    if (!tid) {
      dot.className = 'off';
      msg.textContent = 'Cannot reach the scoreboard — showing what is on this phone';
    } else {
      if (coldOffline) {
        dot.className = 'off';
        msg.textContent = 'Offline — showing the last copy from this device, view only until you reconnect';
      } else if (offline) {
        dot.className = 'off';
        msg.textContent = 'Offline — scores are safe on this device and will go up when you reconnect';
      } else if (!isAdmin()) {
        dot.className = 'warn';
        msg.textContent = 'Live scoreboard — watching only';
      } else {
        dot.className = 'live';
        msg.textContent = dirty || pushing ? 'Saving…' : 'Live — everyone watching sees your scores';
      }
    }

    auth.hidden = false;
    auth.textContent = isAdmin() ? 'Lock' : 'Unlock scoring';
    document.body.classList.toggle('sy-ro', !canEdit());
  }

  /* ---------- read-only gating ---------- */

  /* Applied after each render rather than woven into the views, so the
     original rendering code stays exactly as it was. The server refuses
     writes without a token regardless of what the page looks like. */
  var SAFE_WHEN_LOCKED = { save: 1, copy: 1, tab: 1 };

  function gate() {
    if (canEdit()) return;
    var root = document.getElementById('app');
    if (!root) return;
    var fields = root.querySelectorAll('input,select,textarea,button');
    for (var i = 0; i < fields.length; i++) {
      var el = fields[i];
      /* The sledging corner belongs to everyone watching, not just whoever
         holds the password. It lives inside #app, so it has to be spared
         here by name. */
      if (el.closest('.sy-thread')) continue;
      var act = el.getAttribute('data-act');
      if (act && SAFE_WHEN_LOCKED[act]) continue;
      el.disabled = true;
    }
  }

  /* ---------- tidying the setup page ---------- */

  /* Saving to a file, copying as text and pasting one back made sense when
     the tournament lived in a single browser tab. It is on a server now and
     everyone is looking at the same one, so those buttons offer nothing and
     the paste box could quietly overwrite a live event. The two that still
     mean something stay, under a heading that says what they do. */
  function tidySetup() {
    if (VIEW !== 'setup') return;
    var root = document.getElementById('app');
    if (!root) return;

    var panels = root.querySelectorAll('.panel');
    for (var i = 0; i < panels.length; i++) {
      var head = panels[i].querySelector('h2');
      if (!head || head.textContent.trim() !== 'Saving') continue;
      var panel = panels[i];

      ['save', 'open', 'copy', 'pastepanel', 'pasteload'].forEach(function (act) {
        var gone = panel.querySelectorAll('[data-act="' + act + '"]');
        for (var j = 0; j < gone.length; j++) gone[j].remove();
      });

      var paste = panel.querySelector('#pastePanel');
      if (paste) paste.remove();

      var blurb = panel.querySelector('.hint');
      if (blurb) {
        blurb.textContent = 'Scores are saved for everyone as you enter them. ' +
          'These two start again, and cannot be undone.';
      }

      var rows = panel.querySelectorAll('.row-btns');
      for (var k = 0; k < rows.length; k++) {
        if (!rows[k].querySelector('button')) rows[k].remove();
        else rows[k].classList.remove('spaced');
      }

      head.textContent = 'Starting again';
    }
  }

  /* The summary offers the same file download. */
  function tidySummary() {
    if (VIEW !== 'summary') return;
    var root = document.getElementById('app');
    if (!root) return;
    var gone = root.querySelectorAll('[data-act="save"]');
    for (var i = 0; i < gone.length; i++) gone[i].remove();
  }

  /* ---------- asking for something, nicely ---------- */

  /* The browser's own prompt() is ugly, unstyleable, and on some phones it
     does not appear at all. This is the same thing in the page's own clothes. */
  function askFor(opts) {
    return new Promise(function (resolve) {
      var done = false;

      function finish(value) {
        if (done) return;
        done = true;
        document.removeEventListener('keydown', onKey, true);
        back.remove();
        resolve(value);
      }

      function onKey(e) {
        if (e.key === 'Escape') { e.preventDefault(); finish(null); }
        else if (e.key === 'Enter' && document.activeElement === field) {
          e.preventDefault();
          finish(field.value);
        }
      }

      var back = document.createElement('div');
      back.className = 'sy-ask-back no-print';
      back.addEventListener('mousedown', function (e) {
        if (e.target === back) finish(null);
      });

      var card = document.createElement('div');
      card.className = 'sy-ask';
      card.setAttribute('role', 'dialog');
      card.setAttribute('aria-modal', 'true');

      var title = document.createElement('h3');
      title.textContent = opts.title;
      card.appendChild(title);

      if (opts.hint) {
        var hint = document.createElement('p');
        hint.textContent = opts.hint;
        card.appendChild(hint);
      }

      var field = document.createElement('input');
      field.type = opts.password ? 'password' : 'text';
      field.className = 'sy-ask-field';
      field.placeholder = opts.placeholder || '';
      field.maxLength = opts.maxLength || 60;
      if (opts.value) field.value = opts.value;
      if (opts.password) field.autocomplete = 'current-password';
      card.appendChild(field);

      var row = document.createElement('div');
      row.className = 'sy-ask-row';

      var cancel = document.createElement('button');
      cancel.type = 'button';
      cancel.className = 'sy-ask-btn';
      cancel.textContent = 'Cancel';
      cancel.addEventListener('click', function () { finish(null); });
      row.appendChild(cancel);

      var go = document.createElement('button');
      go.type = 'button';
      go.className = 'sy-ask-btn go';
      go.textContent = opts.confirm || 'OK';
      go.addEventListener('click', function () { finish(field.value); });
      row.appendChild(go);

      card.appendChild(row);
      back.appendChild(card);
      document.body.appendChild(back);
      document.addEventListener('keydown', onKey, true);
      setTimeout(function () { field.focus(); field.select(); }, 30);
    });
  }

  /* ---------- sledging corner ---------- */

  /* The page rebuilds the whole of #app on every keystroke, so a thread's
     open/shut state, a half-typed remark and the caret inside it all have
     to be held out here and put back after each render. */
  var comments = {};
  var openThreads = {};
  var drafts = {};
  var refocus = null;          /* { matchId, caret } */
  /* These two mark something that has only just happened, so it can be
     animated. They are timestamps rather than one-shot flags: the page
     redraws for all sorts of unrelated reasons — a score syncing, someone
     else's change arriving — and a flag cleared by the first of those would
     cut the animation off halfway. A short window survives all that and
     expires on its own. */
  var justOpened = null;       /* { id, until } — a thread unfurling */
  var justSaid = null;         /* { id, until } — a remark landing */

  function stillFresh(mark, id) {
    return !!mark && mark.id === id && Date.now() < mark.until;
  }

  function whoAmI() {
    try { return window.localStorage.getItem(NAME_KEY) || ''; } catch (e) { return ''; }
  }

  function setWhoAmI(name) {
    try { window.localStorage.setItem(NAME_KEY, name); } catch (e) { /* no storage */ }
  }

  function whenText(iso) {
    var then = new Date(iso).getTime();
    if (isNaN(then)) return '';
    var mins = Math.round((Date.now() - then) / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return mins + 'm ago';
    var hrs = Math.round(mins / 60);
    if (hrs < 24) return hrs + 'h ago';
    return Math.round(hrs / 24) + 'd ago';
  }

  function threadFor(matchId) {
    return (comments && comments[matchId]) || [];
  }

  function paintThreads() {
    var root = document.getElementById('app');
    if (!root) return;
    var cards = root.querySelectorAll('article.match[data-m]');

    for (var i = 0; i < cards.length; i++) {
      var card = cards[i];
      var id = card.getAttribute('data-m');
      card.insertAdjacentElement('afterend', buildThread(id));
    }

    /* Put the caret back where it was before the page redrew itself. */
    if (refocus) {
      var box = root.querySelector('.sy-say[data-m="' + refocus.matchId + '"]');
      if (box) {
        box.focus({ preventScroll: true });
        try { box.setSelectionRange(refocus.caret, refocus.caret); } catch (e) { /* fine */ }
      }
      refocus = null;
    }
  }

  function buildThread(matchId) {
    var list = threadFor(matchId);
    var isOpen = !!openThreads[matchId];

    var wrap = document.createElement('div');
    wrap.className = 'sy-thread' + (isOpen ? ' on' : '') +
      (stillFresh(justOpened, matchId) ? ' sy-just-opened' : '');
    wrap.setAttribute('data-m', matchId);

    var toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'sy-thread-top';
    toggle.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
    toggle.innerHTML =
      '<span class="sy-caret">' + (isOpen ? '&#9662;' : '&#9656;') + '</span>' +
      '<span class="sy-emoji" aria-hidden="true">\uD83D\uDCAC</span>' +
      '<span class="sy-label">Sledging corner</span>' +
      (list.length ? '<span class="sy-tally">' + list.length + '</span>'
                   : '<span class="sy-quiet">quiet so far</span>');
    toggle.addEventListener('click', function () {
      openThreads[matchId] = !openThreads[matchId];
      justOpened = openThreads[matchId] ? { id: matchId, until: Date.now() + 500 } : null;
      render();
    });
    wrap.appendChild(toggle);

    if (!isOpen) return wrap;

    var body = document.createElement('div');
    body.className = 'sy-thread-body';

    list.forEach(function (c) {
      var row = document.createElement('div');
      row.className = 'sy-comment' + (stillFresh(justSaid, c.id) ? ' sy-new' : '');

      var head = document.createElement('div');
      head.className = 'sy-comment-top';
      var who = document.createElement('b');
      who.textContent = c.who;
      head.appendChild(who);
      var when = document.createElement('span');
      when.className = 'sy-when';
      when.textContent = whenText(c.at);
      head.appendChild(when);

      if (isAdmin()) {
        var bin = document.createElement('button');
        bin.type = 'button';
        bin.className = 'sy-bin';
        bin.textContent = 'remove';
        bin.addEventListener('click', function () { removeComment(matchId, c.id); });
        head.appendChild(bin);
      }
      row.appendChild(head);

      var said = document.createElement('p');
      said.textContent = c.text;
      row.appendChild(said);
      body.appendChild(row);
    });

    if (!list.length) {
      var empty = document.createElement('p');
      empty.className = 'sy-empty';
      empty.textContent = 'Nobody has said anything about this one yet.';
      body.appendChild(empty);
    }

    var form = document.createElement('div');
    form.className = 'sy-say-row';

    var box = document.createElement('input');
    box.type = 'text';
    box.className = 'sy-say';
    box.setAttribute('data-m', matchId);
    box.maxLength = 300;
    box.placeholder = 'Say something…';
    box.value = drafts[matchId] || '';
    box.addEventListener('input', function () {
      drafts[matchId] = box.value;
    });
    box.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); postComment(matchId); }
    });
    form.appendChild(box);

    var send = document.createElement('button');
    send.type = 'button';
    send.className = 'sy-post';
    send.textContent = 'Post';
    send.addEventListener('click', function () { postComment(matchId); });
    form.appendChild(send);

    body.appendChild(form);

    /* Whoever this phone posts as, with a way out of it. Only shown once a
       name has been chosen — before that, posting asks for one anyway. */
    if (whoAmI()) {
      var asYou = document.createElement('p');
      asYou.className = 'sy-asyou';
      asYou.appendChild(document.createTextNode('posting as '));
      var mine = document.createElement('b');
      mine.textContent = whoAmI();
      asYou.appendChild(mine);
      asYou.appendChild(document.createTextNode(' \u00b7'));
      var change = document.createElement('button');
      change.type = 'button';
      change.className = 'sy-rename';
      change.textContent = 'change';
      change.addEventListener('click', changeName);
      asYou.appendChild(change);
      body.appendChild(asYou);
    }

    wrap.appendChild(body);
    return wrap;
  }

  /* Remarks already posted keep the name they were posted under — they are
     a record of what was said at the time, not a profile. */
  function changeName() {
    return askFor({
      title: 'Change your name',
      hint: 'What people see next to your remarks from now on. Kept on this phone.',
      placeholder: 'Your name',
      value: whoAmI(),
      confirm: 'Save',
      maxLength: 24
    }).then(function (given) {
      var chosen = String(given || '').trim().slice(0, 24);
      if (!chosen || chosen === whoAmI()) return;
      setWhoAmI(chosen);
      say('You will post as ' + chosen + ' from now on.');
      render();
    });
  }

  function postComment(matchId) {
    var text = String(drafts[matchId] || '').trim();
    if (!text) return;
    if (!tid) { say('Not connected, so nobody else would see it.'); return; }

    var name = whoAmI();
    if (name) return sendComment(matchId, name, text);

    return askFor({
      title: 'What should people call you?',
      hint: 'It goes next to anything you say. Kept on this phone, asked once.',
      placeholder: 'Your name',
      confirm: 'Save',
      maxLength: 24
    }).then(function (given) {
      var chosen = String(given || '').trim().slice(0, 24);
      if (!chosen) return;
      setWhoAmI(chosen);
      return sendComment(matchId, chosen, text);
    });
  }

  function sendComment(matchId, name, text) {
    drafts[matchId] = '';
    refocus = { matchId: matchId, caret: 0 };

    return api('POST', '/api/tournaments/' + tid + '/comments/' + encodeURIComponent(matchId), {
      who: name, text: text
    }).then(function (data) {
      comments[matchId] = threadFor(matchId).concat([data.comment]);
      justSaid = { id: data.comment.id, until: Date.now() + 1600 };
      localRev = data.rev;
      render();
    }).catch(function (err) {
      drafts[matchId] = text;     /* hand it back rather than losing it */
      say(err.message);
      render();
    });
  }

  function removeComment(matchId, commentId) {
    if (!tid) return;
    api('DELETE', '/api/tournaments/' + tid + '/comments/' +
        encodeURIComponent(matchId) + '/' + encodeURIComponent(commentId))
      .then(function (data) {
        comments[matchId] = threadFor(matchId).filter(function (c) { return c.id !== commentId; });
        localRev = data.rev;
        render();
      }).catch(function (err) { say(err.message); });
  }

  /* ---------- final placings ---------- */

  /* First and second come out of the final. Third and fourth only exist if
     a third-place match is being played — without one, the two beaten
     semi-finalists are genuinely joint third, so we do not invent an order
     between them. */
  function placings() {
    var out = [];
    var f = findMatch(S, 'F');
    var fw = f && matchWinner(S, f);

    if (fw) {
      var g = gamesWon(f);
      var won = fw === 'a' ? g[0] : g[1];
      var lost = fw === 'a' ? g[1] : g[0];
      out.push({
        n: 1, what: 'Champion',
        id: resolveSlot(S, fw === 'a' ? f.a : f.b),
        detail: 'won the final ' + won + '–' + lost
      });
      out.push({
        n: 2, what: 'Runner-up',
        id: resolveSlot(S, fw === 'a' ? f.b : f.a),
        detail: 'lost the final ' + lost + '–' + won
      });
    } else {
      out.push({ n: 1, what: 'Champion', id: null });
      out.push({ n: 2, what: 'Runner-up', id: null });
    }

    if (S.config.thirdPlace) {
      var tp = findMatch(S, 'TP');
      var tw = tp && matchWinner(S, tp);
      if (tw) {
        var t = gamesWon(tp);
        out.push({
          n: 3, what: 'Third',
          id: resolveSlot(S, tw === 'a' ? tp.a : tp.b),
          detail: 'won the third-place match ' + (tw === 'a' ? t[0] : t[1]) + '–' + (tw === 'a' ? t[1] : t[0])
        });
        out.push({
          n: 4, what: 'Fourth',
          id: resolveSlot(S, tw === 'a' ? tp.b : tp.a),
          detail: 'lost the third-place match'
        });
      } else {
        out.push({ n: 3, what: 'Third', id: null });
        out.push({ n: 4, what: 'Fourth', id: null });
      }
    }
    return out;
  }

  function paintPodium() {
    if (VIEW !== 'summary') return;
    var root = document.getElementById('app');
    if (!root) return;
    var crown = root.querySelector('.panel.crown');
    if (!crown) return;

    var rows = placings();
    var settled = rows.filter(function (r) { return r.id; }).length;

    var el = document.createElement('section');
    el.className = 'sy-podium';

    var head = document.createElement('h2');
    head.appendChild(document.createTextNode('Final placings'));
    if (settled < rows.length) {
      var count = document.createElement('span');
      count.className = 'count';
      count.textContent = settled + ' of ' + rows.length + ' decided';
      head.appendChild(count);
    }
    el.appendChild(head);

    var sub = document.createElement('p');
    sub.className = 'sy-sub';
    sub.textContent = S.config.thirdPlace
      ? 'First and second from the final, third and fourth from the third-place match.'
      : 'From the final. Turn on the third-place match in Set up to separate third and fourth.';
    el.appendChild(sub);

    rows.forEach(function (r) {
      var row = document.createElement('div');
      row.className = 'sy-place p' + r.n + (r.id ? '' : ' sy-waiting');

      var medal = document.createElement('span');
      medal.className = 'sy-medal';
      medal.textContent = r.n;
      row.appendChild(medal);

      var who = document.createElement('div');
      who.className = 'sy-who';

      var name = document.createElement('div');
      name.className = 'sy-name';
      name.textContent = r.id ? playerName(S, r.id) : 'Still to be decided';
      who.appendChild(name);

      var what = document.createElement('div');
      what.className = 'sy-what';
      what.textContent = r.what;
      who.appendChild(what);

      if (r.id && r.detail) {
        var detail = document.createElement('div');
        detail.className = 'sy-detail';
        detail.textContent = r.detail;
        who.appendChild(detail);
      }

      row.appendChild(who);
      el.appendChild(row);
    });

    crown.insertAdjacentElement('afterend', el);
  }

  /* ---------- stale overrides ---------- */

  /* Three places let a human pin a result by hand, and each one stops
     later score edits from flowing through. That is worth keeping — but
     not worth hiding. When a pin no longer agrees with what the scores
     now say, say so and offer to drop it.

     Everything here runs against a throwaway copy so the live state's
     memo cache is never touched. */
  function shadow() {
    var c = JSON.parse(toJSON());
    c._memo = {};
    return c;
  }

  function findStale() {
    var out = [];
    var c;

    S.matches.forEach(function (m) {
      ['a', 'b'].forEach(function (side) {
        var slot = m[side];
        if (!slot || !slot.override) return;
        c = shadow();
        var cm = findMatch(c, m.id);
        if (!cm || !cm[side]) return;
        delete cm[side].override;
        c._memo = {};
        var computed = resolveSlot(c, cm[side]);
        if (computed && computed !== slot.override) {
          out.push({
            key: 'slot:' + m.id + ':' + side,
            text: (m.label || m.id) + ' has ' + playerName(S, slot.override) +
                  ' picked by hand, but the scores now point to ' + playerName(S, computed) + '.',
            clear: function () { delete m[side].override; }
          });
        }
      });
    });

    Object.keys(S.standingOverride || {}).forEach(function (gid) {
      var pinned = S.standingOverride[gid];
      if (!Array.isArray(pinned) || !pinned.length) return;
      c = shadow();
      delete c.standingOverride[gid];
      c._memo = {};
      var auto = standings(c, gid).map(function (r) { return r.id; });
      if (auto.join('|') === pinned.join('|')) return;
      out.push({
        key: 'standing:' + gid,
        text: 'Group ' + gid + ' is ordered by hand and no longer matches the table the scores produce.',
        clear: function () { delete S.standingOverride[gid]; }
      });
    });

    Object.keys(S.seedOverride || {}).forEach(function (n) {
      var pinned = S.seedOverride[n];
      if (!pinned) return;
      c = shadow();
      delete c.seedOverride[n];
      c._memo = {};
      var auto = semiSeeds(c)[parseInt(n, 10) - 1];
      if (!auto || auto === pinned) return;
      out.push({
        key: 'seed:' + n,
        text: 'Semi-final seed ' + n + ' is set to ' + playerName(S, pinned) +
              ' by hand, but the scores now point to ' + playerName(S, auto) + '.',
        clear: function () { delete S.seedOverride[n]; }
      });
    });

    return out;
  }

  function paintNudges() {
    var box = document.getElementById('sy-nudges');
    if (!box) return;
    box.innerHTML = '';
    if (!canEdit()) return;

    findStale().forEach(function (item) {
      if (dismissed[item.key]) return;
      var el = document.createElement('div');
      el.className = 'sy-nudge';
      el.innerHTML = '<p></p>';
      el.firstChild.textContent = item.text;

      var use = document.createElement('button');
      use.type = 'button';
      use.className = 'sy-btn';
      use.textContent = 'Use the scores';
      use.addEventListener('click', function () {
        item.clear();
        commit();
      });

      var keep = document.createElement('button');
      keep.type = 'button';
      keep.className = 'sy-btn';
      keep.textContent = 'Keep my pick';
      keep.addEventListener('click', function () {
        dismissed[item.key] = true;
        paintNudges();
      });

      el.appendChild(use);
      el.appendChild(keep);
      box.appendChild(el);
    });
  }

  /* ---------- pushing ---------- */

  function matchesById(state) {
    var out = {};
    (state.matches || []).forEach(function (m) { if (m && m.id) out[m.id] = m; });
    return out;
  }

  function withoutMatches(state) {
    var c = Object.assign({}, state);
    delete c.matches;
    return JSON.stringify(c);
  }

  function schedulePush() {
    if (!tid || !isAdmin()) return;
    dirty = true;
    paintBar();
    clearTimeout(pushTimer);
    pushTimer = setTimeout(runPush, PUSH_DEBOUNCE_MS);
  }

  function runPush() {
    if (!tid || !isAdmin() || pushing) return;
    pushing = true;
    paintBar();

    var current = snapshot();

    var work;
    if (!lastSent || withoutMatches(current) !== withoutMatches(lastSent) ||
        current.matches.length !== lastSent.matches.length) {
      /* Setup, names, config or a pinned order changed — send the lot,
         with the rev so a second editor cannot be overwritten silently. */
      work = api('PUT', '/api/tournaments/' + tid, { rev: localRev, state: current })
        .then(function (res) { localRev = res.rev; });
    } else {
      /* Only results moved. Send each changed match on its own so two
         people scoring two courts never collide. */
      var before = matchesById(lastSent);
      var changed = current.matches.filter(function (m) {
        return JSON.stringify(m) !== JSON.stringify(before[m.id]);
      });
      if (!changed.length) {
        pushing = false;
        dirty = false;
        paintBar();
        return;
      }
      work = changed.reduce(function (chain, m) {
        return chain.then(function () {
          return api('PATCH', '/api/tournaments/' + tid + '/matches/' + encodeURIComponent(m.id), {
            games: m.games,
            winner: m.winner || null,
            note: m.note || '',
            aOverride: (m.a && m.a.override) || null,
            bOverride: (m.b && m.b.override) || null
          }).then(function (res) { localRev = res.rev; });
        });
      }, Promise.resolve());
    }

    work.then(function () {
      lastSent = current;
      dirty = false;
      offline = false;
    }).catch(function (err) {
      if (err.status === 401) {
        setToken('');
        say('Your scoring access expired. Unlock again to keep saving.');
      } else if (err.status === 409) {
        say('Someone else changed the setup. Loading their version.');
        return pull(true);
      } else if (err.status === 404) {
        say('That tournament link no longer exists on the server.');
        tid = null;
      } else {
        offline = true;
        dirty = true;
        setTimeout(schedulePush, 5000);
      }
    }).then(function () {
      pushing = false;
      paintBar();
      render();
    });
  }

  /* ---------- pulling ---------- */

  function safeToApply() {
    if (dirty || pushing) return false;
    if (Date.now() - lastTypedAt < TYPING_GRACE_MS) return false;
    var a = document.activeElement;
    if (a && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName)) return false;
    return true;
  }

  function pull(force) {
    return api('GET', '/api/tournaments/' + tid).then(function (data) {
      if (!force && !safeToApply()) return;
      var wasCold = coldOffline;
      S = normalize(data.state);
      comments = data.comments || {};
      localRev = data.rev;
      lastSent = snapshot();
      offline = false;
      coldOffline = false;
      render();
      stash();
      if (wasCold) say('Back online — these are the live scores.');
    });
  }

  function poll() {
    if (!tid || document.hidden) return;
    if (!safeToApply()) return;
    api('GET', '/api/tournaments/' + tid + '/rev').then(function (data) {
      if (coldOffline || data.rev > localRev) return pull(false);
      offline = false;
    }).catch(function (err) {
      if (err.status !== 404) offline = true;
      paintBar();
    });
  }

  /* ---------- buttons ---------- */

  function onAuth() {
    if (isAdmin()) {
      setToken('');
      say('Locked. This device is view only now.');
      paintBar();
      render();
      return;
    }
    askFor({
      title: 'Unlock scoring',
      hint: 'The tournament password. Without it you can watch, but not change anything.',
      placeholder: 'Password',
      confirm: 'Unlock',
      password: true
    }).then(function (pw) {
      if (pw === null || !String(pw).trim()) return;
      return api('POST', '/api/login', { password: String(pw) }).then(function (data) {
        setToken(data.token);
        say('Unlocked. You can enter scores.');
        paintBar();
        return tid ? pull(true) : null;
      }).then(function () {
        render();
      }).catch(function (err) {
        say(err.message);
      });
    });
  }

  /* ---------- wiring ---------- */

  var pollTimer = null;
  function startPolling() {
    if (pollTimer) return;
    pollTimer = setInterval(poll, POLL_MS);
  }

  function wrapGlobals() {
    var realCommit = commit;
    commit = function () {
      var out = realCommit.apply(this, arguments);
      schedulePush();
      return out;
    };

    var realStash = stash;
    stash = function () {
      if (!tid) return realStash.apply(this, arguments);
      return liveStash();
    };

    var realRender = render;
    render = function () {
      var arriving = (VIEW !== lastView);
      var out = realRender.apply(this, arguments);
      tidySetup();
      tidySummary();
      paintThreads();
      paintPodium();
      gate();
      paintNudges();
      paintBar();
      if (arriving) playEntrance();
      return out;
    };
  }

  function boot() {
    installChrome();
    wrapGlobals();

    /* What the assistant bubble needs to know, and nothing more. */
    window.badmintonSync = {
      tournamentId: function () { return tid; },
      token: function () { return token(); },
      isAdmin: isAdmin,
      refresh: function () { return tid ? pull(true) : Promise.resolve(); }
    };

    document.addEventListener('input', function (e) {
      lastTypedAt = Date.now();
      /* A remark being typed is about to be wiped by the next render. */
      var el = e.target;
      if (el && el.classList && el.classList.contains('sy-say')) {
        var caret = 0;
        try { caret = el.selectionStart; } catch (err) { caret = el.value.length; }
        refocus = { matchId: el.getAttribute('data-m'), caret: caret };
      }
    }, true);
    document.addEventListener('visibilitychange', function () {
      if (!document.hidden) poll();
    });

    var q = new URLSearchParams(location.search);
    var wanted = q.get('t');

    /* An escape hatch: ?local=1 keeps the page entirely to itself, the way
       it worked before any of this existed. */
    if (q.get('local') === '1') {
      render();
      return;
    }

    if (wanted) {
      openTournament(wanted, false);
      return;
    }

    /* No link in the address bar. Rather than making someone find one, ask
       the server whether a tournament is already being played and open it. */
    api('GET', '/api/tournaments/current').then(function (data) {
      if (!data || !data.id) {
        render();           /* nothing published yet — carry on locally */
        return;
      }
      history.replaceState(null, '', location.pathname + '?t=' + encodeURIComponent(data.id));
      return openTournament(data.id, true);
    }).catch(function () {
      render();             /* server unreachable — carry on locally */
    });
  }

  /* `settled` means this id came from the server just now, so a 404 on it is
     real rather than a stale link someone had bookmarked. */
  function openTournament(id, settled) {
    tid = id;
    return api('GET', '/api/tournaments/' + tid).then(function (data) {
      S = normalize(data.state);
      comments = data.comments || {};
      localRev = data.rev;
      lastSent = snapshot();
      VIEW = 'groups';
      render();
      startPolling();
    }).catch(function (err) {
      if (err.status === 404) {
        /* An old link, kept in someone's address bar after that tournament
           went. Put them on the one being played rather than dropping them
           onto an empty copy of their own. */
        if (!settled) {
          return api('GET', '/api/tournaments/current').then(function (data) {
            if (!data || !data.id || data.id === id) throw new Error('nothing to fall back to');
            history.replaceState(null, '', location.pathname + '?t=' + encodeURIComponent(data.id));
            return openTournament(data.id, true);
          }).catch(function () {
            tid = null;
            say('That link has gone, and I could not find the current tournament.');
            render();
          });
        }
        tid = null;
        say('That tournament no longer exists. Showing what is on this device.');
        render();
        return;
      }
      /* Out of signal at the venue. Fall back to the last copy of THIS
         tournament saved on this phone and keep scoring; the poll will
         pick things up again and the pending edits go out then. */
      var backup = liveUnstash(tid);
      if (backup) {
        S = normalize(backup);
        VIEW = 'groups';
        say('Offline — showing the last copy saved on this device.');
      } else {
        say('Could not reach the scoreboard. Showing what is on this device.');
      }
      offline = true;
      coldOffline = true;
      render();
      startPolling();
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }

})();

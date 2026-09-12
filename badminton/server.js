'use strict';

/* ============================================================
   Badminton tournament — backend.

   Serves public/index.html and a small API that keeps one
   tournament document in MongoDB so several phones can score
   the same event at once.

   The page works perfectly well without this server; the sync
   layer in public/sync.js only switches on when the URL carries
   a ?t=<id>. Nothing here reaches into the tournament rules —
   the browser stays the only place that knows them.
   ============================================================ */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const { MongoClient } = require('mongodb');
const rules = require('./lib/rules');
const gemini = require('./lib/gemini');

/* ---------- config ---------- */

/* A five-line .env reader, so the connection string never has to
   live in a file that gets served to a phone. */
function loadEnv(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (e) { return; }
  text.split('\n').forEach(function (line) {
    const s = line.trim();
    if (!s || s.charAt(0) === '#') return;
    const i = s.indexOf('=');
    if (i < 0) return;
    const k = s.slice(0, i).trim();
    let v = s.slice(i + 1).trim();
    const q = v.charAt(0);
    if ((q === '"' || q === "'") && v.charAt(v.length - 1) === q) v = v.slice(1, -1);
    if (!(k in process.env)) process.env[k] = v;
  });
}
loadEnv(path.join(__dirname, '.env'));

const PORT = parseInt(process.env.PORT, 10) || 3000;
const MONGODB_URI = process.env.MONGODB_URI;
const MONGODB_DB = process.env.MONGODB_DB || 'badminton';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'singles@1234';
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
const TOKEN_TTL_MS = 12 * 60 * 60 * 1000;

if (!MONGODB_URI) {
  console.error('MONGODB_URI is not set. Copy .env.example to .env and fill it in.');
  process.exit(1);
}

/* ---------- tokens ---------- */

/* Signed, stateless, and short-lived. No session store to keep in step,
   and a restart does not log the scorers out so long as SESSION_SECRET
   is pinned in .env. */
function signToken(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const mac = crypto.createHmac('sha256', SESSION_SECRET).update(body).digest('base64url');
  return body + '.' + mac;
}

function readToken(token) {
  if (!token || typeof token !== 'string') return null;
  const bits = token.split('.');
  if (bits.length !== 2) return null;
  const want = crypto.createHmac('sha256', SESSION_SECRET).update(bits[0]).digest('base64url');
  const a = Buffer.from(bits[1]);
  const b = Buffer.from(want);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  let payload;
  try { payload = JSON.parse(Buffer.from(bits[0], 'base64url').toString('utf8')); }
  catch (e) { return null; }
  if (!payload || typeof payload.exp !== 'number' || payload.exp < Date.now()) return null;
  return payload;
}

function samePassword(given) {
  const a = Buffer.from(String(given == null ? '' : given));
  const b = Buffer.from(ADMIN_PASSWORD);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function requireAdmin(req, res, next) {
  const header = req.get('authorization') || '';
  const token = header.slice(0, 7).toLowerCase() === 'bearer ' ? header.slice(7) : '';
  if (!readToken(token)) {
    return res.status(401).json({ error: 'Unlock editing with the tournament password first.' });
  }
  return next();
}

/* A plain counter, enough to make guessing the password tedious. */
const attempts = new Map();
const ATTEMPT_WINDOW_MS = 15 * 60 * 1000;
const ATTEMPT_LIMIT = 10;

function tooManyAttempts(ip) {
  const now = Date.now();
  const row = attempts.get(ip);
  if (!row || now - row.first > ATTEMPT_WINDOW_MS) {
    attempts.set(ip, { first: now, n: 1 });
    return false;
  }
  row.n += 1;
  return row.n > ATTEMPT_LIMIT;
}

/* ---------- shaping what we store ---------- */

/* The browser owns the rules. The server only checks that what arrives
   is the right shape, so a bad request cannot wedge a tournament. */
function cleanState(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  if (!Array.isArray(raw.matches) || !Array.isArray(raw.groups)) return null;
  const out = JSON.parse(JSON.stringify(raw));
  delete out._id;
  return out;
}

function cleanGames(raw) {
  if (!Array.isArray(raw)) return null;
  return raw.slice(0, 9).map(function (g) {
    const a = Array.isArray(g) ? g[0] : null;
    const b = Array.isArray(g) ? g[1] : null;
    return [numOrNull(a), numOrNull(b)];
  });
}

function numOrNull(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = parseInt(v, 10);
  return isNaN(n) ? null : n;
}

function newId() {
  return crypto.randomBytes(6).toString('base64url');
}

/* ---------- app ---------- */

const app = express();
app.set('trust proxy', true);
app.use(express.json({ limit: '4mb' }));
app.use(express.static(path.join(__dirname, 'public')));

let tournaments;

app.post('/api/login', function (req, res) {
  const ip = req.ip || 'unknown';
  if (tooManyAttempts(ip)) {
    return res.status(429).json({ error: 'Too many tries. Wait a few minutes.' });
  }
  if (!samePassword(req.body && req.body.password)) {
    return res.status(401).json({ error: 'That password is not right.' });
  }
  attempts.delete(ip);
  const exp = Date.now() + TOKEN_TTL_MS;
  return res.json({ token: signToken({ role: 'admin', exp: exp }), expiresAt: exp });
});

/* ---------- staying awake ---------- */

/* Deliberately the cheapest route here: no database, no work. Free hosts
   stop a service that has had no inbound request for a while, and waking it
   again takes the best part of a minute — long enough to be irritating with
   a match waiting. Something hitting this every few minutes keeps it up.

   Pass ?db=1 to have it check Mongo too. Do not point a keep-alive at that
   version; it is for when you actually want to know. */
const STARTED_AT = Date.now();

app.get('/api/ping', async function (req, res, next) {
  try {
    const body = {
      ok: true,
      awakeFor: Math.round((Date.now() - STARTED_AT) / 1000),
      now: new Date().toISOString()
    };
    if (req.query.db) {
      const began = Date.now();
      await client.db(MONGODB_DB).command({ ping: 1 });
      body.db = { ok: true, ms: Date.now() - began };
    }
    res.set('Cache-Control', 'no-store');
    res.json(body);
  } catch (err) {
    res.status(503).json({ ok: false, db: { ok: false, error: String(err && err.message) } });
  }
});

app.get('/api/session', function (req, res) {
  const header = req.get('authorization') || '';
  const token = header.slice(0, 7).toLowerCase() === 'bearer ' ? header.slice(7) : '';
  res.json({ admin: !!readToken(token) });
});

app.post('/api/tournaments', requireAdmin, async function (req, res, next) {
  try {
    const state = cleanState(req.body && req.body.state);
    if (!state) return res.status(400).json({ error: 'That is not a tournament.' });
    const doc = {
      _id: newId(),
      name: String((req.body && req.body.name) || (state.meta && state.meta.name) || 'Badminton tournament').slice(0, 200),
      state: state,
      rev: 1,
      createdAt: new Date(),
      updatedAt: new Date()
    };
    await tournaments.insertOne(doc);
    res.status(201).json({ id: doc._id, rev: doc.rev, name: doc.name });
  } catch (err) { next(err); }
});

/* The one being played. Opening the site lands here, so nobody has to know
   what a link is. If the collection is empty a blank tournament is started,
   so the scoreboard is always live and there is never a step to press
   before it works. Registered before /:id so "current" is not mistaken for
   a tournament id. */
async function currentTournament() {
  const found = await tournaments
    .find({}, { projection: { name: 1, rev: 1, updatedAt: 1 } })
    .sort({ updatedAt: -1 })
    .limit(1)
    .next();
  if (found) return found;

  /* A fixed id, so two phones arriving at once cannot start two. */
  const state = rules.strip(rules.makeState(16));
  const fresh = {
    _id: 'main',
    name: state.meta.name,
    state: state,
    rev: 1,
    createdAt: new Date(),
    updatedAt: new Date()
  };
  try {
    await tournaments.insertOne(fresh);
    return fresh;
  } catch (err) {
    if (err && err.code === 11000) return tournaments.findOne({ _id: 'main' });
    throw err;
  }
}

app.get('/api/tournaments/current', async function (req, res, next) {
  try {
    const doc = await currentTournament();
    res.json({ id: doc._id, name: doc.name, rev: doc.rev, updatedAt: doc.updatedAt });
  } catch (err) { next(err); }
});

app.get('/api/tournaments/:id', async function (req, res, next) {
  try {
    const doc = await tournaments.findOne({ _id: req.params.id });
    if (!doc) return res.status(404).json({ error: 'No tournament with that link.' });
    res.json({
      id: doc._id, rev: doc.rev, name: doc.name, state: doc.state,
      comments: doc.comments || {}, updatedAt: doc.updatedAt
    });
  } catch (err) { next(err); }
});

/* ---------- the chatter under each match ---------- */

/* Kept beside the tournament rather than inside it: the state object is
   rebuilt from scratch by the page's own normalize() every time it loads,
   which would throw anything it does not recognise away. */

const CHAT_MAX_PER_MATCH = 200;
const chatter = new Map();
const CHATTER_WINDOW_MS = 60 * 1000;
const CHATTER_LIMIT = 12;

function tooChatty(ip) {
  const now = Date.now();
  const row = chatter.get(ip);
  if (!row || now - row.first > CHATTER_WINDOW_MS) {
    chatter.set(ip, { first: now, n: 1 });
    return false;
  }
  row.n += 1;
  return row.n > CHATTER_LIMIT;
}

/* Open to anyone who can see the scoreboard — that is the point of it.
   Removing someone else's remark needs the password. */
app.post('/api/tournaments/:id/comments/:matchId', async function (req, res, next) {
  try {
    if (tooChatty(req.ip || 'unknown')) {
      return res.status(429).json({ error: 'Steady on. Give it a minute.' });
    }
    const text = String((req.body && req.body.text) || '').trim();
    if (!text) return res.status(400).json({ error: 'Nothing to say?' });

    const doc = await tournaments.findOne({ _id: req.params.id }, { projection: { comments: 1 } });
    if (!doc) return res.status(404).json({ error: 'No tournament with that link.' });
    const already = ((doc.comments || {})[req.params.matchId] || []).length;
    if (already >= CHAT_MAX_PER_MATCH) {
      return res.status(409).json({ error: 'This match has heard enough.' });
    }

    const comment = {
      id: crypto.randomBytes(5).toString('hex'),
      who: String((req.body && req.body.who) || 'Someone').trim().slice(0, 24) || 'Someone',
      text: text.slice(0, 300),
      at: new Date()
    };

    const updated = await tournaments.findOneAndUpdate(
      { _id: req.params.id },
      {
        $push: { ['comments.' + req.params.matchId]: comment },
        $set: { updatedAt: new Date() },
        $inc: { rev: 1 }
      },
      { returnDocument: 'after', projection: { rev: 1 } }
    );
    if (!updated) return res.status(404).json({ error: 'No tournament with that link.' });
    res.status(201).json({ comment: comment, rev: updated.rev });
  } catch (err) { next(err); }
});

app.delete('/api/tournaments/:id/comments/:matchId/:commentId', requireAdmin, async function (req, res, next) {
  try {
    const updated = await tournaments.findOneAndUpdate(
      { _id: req.params.id },
      {
        $pull: { ['comments.' + req.params.matchId]: { id: req.params.commentId } },
        $set: { updatedAt: new Date() },
        $inc: { rev: 1 }
      },
      { returnDocument: 'after', projection: { rev: 1 } }
    );
    if (!updated) return res.status(404).json({ error: 'No tournament with that link.' });
    res.json({ removed: true, rev: updated.rev });
  } catch (err) { next(err); }
});

/* The poll. Deliberately tiny: four bytes of answer most of the time. */
app.get('/api/tournaments/:id/rev', async function (req, res, next) {
  try {
    const doc = await tournaments.findOne({ _id: req.params.id }, { projection: { rev: 1 } });
    if (!doc) return res.status(404).json({ error: 'No tournament with that link.' });
    res.json({ rev: doc.rev });
  } catch (err) { next(err); }
});

/* Whole-state save, for the setup tab. Guarded by rev so two people
   editing the draw at once cannot quietly overwrite each other. */
app.put('/api/tournaments/:id', requireAdmin, async function (req, res, next) {
  try {
    const state = cleanState(req.body && req.body.state);
    if (!state) return res.status(400).json({ error: 'That is not a tournament.' });
    const rev = parseInt(req.body && req.body.rev, 10);
    if (isNaN(rev)) return res.status(400).json({ error: 'Missing rev.' });

    const updated = await tournaments.findOneAndUpdate(
      { _id: req.params.id, rev: rev },
      {
        $set: {
          state: state,
          name: String((state.meta && state.meta.name) || 'Badminton tournament').slice(0, 200),
          updatedAt: new Date()
        },
        $inc: { rev: 1 }
      },
      { returnDocument: 'after' }
    );

    if (!updated) {
      const now = await tournaments.findOne({ _id: req.params.id });
      if (!now) return res.status(404).json({ error: 'No tournament with that link.' });
      return res.status(409).json({
        error: 'Someone else saved first.',
        rev: now.rev,
        state: now.state
      });
    }
    res.json({ id: updated._id, rev: updated.rev });
  } catch (err) { next(err); }
});

/* One match at a time. Two people scoring two courts touch different
   paths in the document, so neither can clobber the other.

   Shared by the scoring buttons and the assistant, so a change made by
   asking is exactly the same write as a change made by typing. */
async function patchMatch(id, matchId, body) {
  const set = {};
  const unset = {};

  if (body.games !== undefined) {
    const games = cleanGames(body.games);
    if (!games) return { error: 'Bad games.', status: 400 };
    set['state.matches.$[m].games'] = games;
  }
  if (body.winner !== undefined) {
    const w = body.winner;
    set['state.matches.$[m].winner'] = (w === 'a' || w === 'b') ? w : null;
  }
  if (body.note !== undefined) {
    set['state.matches.$[m].note'] = String(body.note == null ? '' : body.note).slice(0, 500);
  }
  ['a', 'b'].forEach(function (side) {
    const key = side + 'Override';
    if (body[key] === undefined) return;
    if (body[key] === null || body[key] === '') unset['state.matches.$[m].' + side + '.override'] = '';
    else set['state.matches.$[m].' + side + '.override'] = String(body[key]).slice(0, 40);
  });

  if (!Object.keys(set).length && !Object.keys(unset).length) {
    return { error: 'Nothing to change.', status: 400 };
  }

  set.updatedAt = new Date();
  const update = { $set: set, $inc: { rev: 1 } };
  if (Object.keys(unset).length) update.$unset = unset;

  const updated = await tournaments.findOneAndUpdate(
    { _id: id },
    update,
    { arrayFilters: [{ 'm.id': matchId }], returnDocument: 'after' }
  );

  if (!updated) return { error: 'No tournament with that link.', status: 404 };
  return { id: updated._id, rev: updated.rev };
}

/* Whole-tournament save without the rev check — for changes the assistant
   makes, where there is no page revision to compare against. */
async function replaceState(id, state) {
  const updated = await tournaments.findOneAndUpdate(
    { _id: id },
    {
      $set: {
        state: state,
        name: String((state.meta && state.meta.name) || 'Badminton tournament').slice(0, 200),
        updatedAt: new Date()
      },
      $inc: { rev: 1 }
    },
    { returnDocument: 'after' }
  );
  if (!updated) return { error: 'No tournament with that link.', status: 404 };
  return { id: updated._id, rev: updated.rev };
}

app.patch('/api/tournaments/:id/matches/:matchId', requireAdmin, async function (req, res, next) {
  try {
    const out = await patchMatch(req.params.id, req.params.matchId, req.body || {});
    if (out.error) return res.status(out.status).json({ error: out.error });
    res.json(out);
  } catch (err) { next(err); }
});

/* ---------- the assistant ---------- */

app.get('/api/chat/status', function (req, res) {
  res.json({ ready: gemini.configured(), model: gemini.configured() ? gemini.model() : null });
});

app.post('/api/chat', async function (req, res, next) {
  try {
    if (!gemini.configured()) {
      return res.status(503).json({
        error: 'The assistant is not switched on yet — GEMINI_API_KEY is missing from .env.'
      });
    }

    const id = String((req.body && req.body.tournamentId) || '');
    const message = String((req.body && req.body.message) || '').trim();
    if (!id) return res.status(400).json({ error: 'Share the tournament first, then I can see it.' });
    if (!message) return res.status(400).json({ error: 'Say something and I will have a look.' });

    const doc = await tournaments.findOne({ _id: id });
    if (!doc) return res.status(404).json({ error: 'No tournament with that link.' });

    const header = req.get('authorization') || '';
    const bearer = header.slice(0, 7).toLowerCase() === 'bearer ' ? header.slice(7) : '';

    /* Everything the tools are allowed to touch, and nothing else. */
    const ctx = {
      collection: tournaments,
      tournamentId: id,
      isAdmin: !!readToken(bearer),
      state: rules.fresh(doc.state),
      changed: false,
      async reload() {
        const now = await tournaments.findOne({ _id: id });
        return rules.fresh(now.state);
      },
      async patchMatch(matchId, fields) {
        const out = await patchMatch(id, matchId, fields);
        if (out.error) throw new Error(out.error);
        return out;
      },
      async saveState(next) {
        const out = await replaceState(id, next);
        if (out.error) throw new Error(out.error);
        return out;
      }
    };

    const answer = await gemini.ask(req.body && req.body.history, message, ctx);
    res.json({
      text: answer.text,
      used: answer.used.map(function (u) { return u.name; }),
      changed: answer.changed
    });
  } catch (err) {
    if (err && /API key|API_KEY|PERMISSION_DENIED/i.test(String(err.message))) {
      return res.status(502).json({ error: 'Gemini turned the key down: ' + err.message });
    }
    if (err && err.status === 404) {
      return res.status(502).json({
        error: 'Gemini does not offer ' + gemini.model() + ' on this key. Change GEMINI_MODEL in .env.'
      });
    }
    if (err && err.status === 429) {
      return res.status(429).json({ error: 'Gemini\u2019s free tier only allows a few questions a minute, and we have just used them up. Give it half a minute.' });
    }
    next(err);
  }
});

app.use('/api', function (req, res) {
  res.status(404).json({ error: 'No such endpoint.' });
});

app.use(function (err, req, res, next) { // eslint-disable-line no-unused-vars
  console.error(err);
  res.status(500).json({ error: 'Something went wrong on the server.' });
});

/* ---------- start ---------- */

const client = new MongoClient(MONGODB_URI, { serverSelectionTimeoutMS: 15000 });

async function start() {
  await client.connect();
  await client.db(MONGODB_DB).command({ ping: 1 });
  tournaments = client.db(MONGODB_DB).collection('tournaments');
  await tournaments.createIndex({ updatedAt: -1 });
  app.listen(PORT, function () {
    console.log('Badminton tournament running on http://localhost:' + PORT);
    console.log('Scoring password: ' + (process.env.ADMIN_PASSWORD ? '(from .env)' : ADMIN_PASSWORD));
    keepAwake();
  });
}

/* Ping our own public address on a timer, so the host keeps seeing traffic.

   Worth being clear about what this can and cannot do: it holds the service
   up while this process is running, which covers the ordinary case of a quiet
   evening between matches. It cannot wake anything — if the host has already
   stopped us, the timer stopped with it. For that you need something outside
   asking as well; the README says what. */
function keepAwake() {
  const url = (process.env.KEEP_AWAKE_URL || '').trim();
  if (!url) return;

  if (/^https?:\/\/(localhost|127\.|0\.0\.0\.0|\[::1\])/i.test(url)) {
    console.log('KEEP_AWAKE_URL points at this machine, so there is nothing to keep awake. Ignoring it.');
    return;
  }

  const minutes = Math.min(Math.max(parseFloat(process.env.KEEP_AWAKE_MINUTES) || 12, 1), 60);
  const target = url.replace(/\/+$/, '') + '/api/ping';
  let failures = 0;

  const timer = setInterval(function () {
    fetch(target, { headers: { 'User-Agent': 'badminton-keep-awake' } })
      .then(function (res) {
        if (res.ok) { failures = 0; return; }
        throw new Error('HTTP ' + res.status);
      })
      .catch(function (err) {
        failures += 1;
        /* Say so once, then stay quiet — a sleeping host would otherwise
           fill the log with the same line every few minutes. */
        if (failures === 1 || failures % 10 === 0) {
          console.log('keep-awake ping failed (' + failures + '): ' + (err && err.message));
        }
      });
  }, minutes * 60 * 1000);

  timer.unref();   /* never hold the process open on its own account */
  console.log('Keeping awake: pinging ' + target + ' every ' + minutes + ' minutes.');
}

start().catch(function (err) {
  console.error('Could not start.');
  console.error(err && err.message ? err.message : err);
  console.error('\nIf this hangs or times out, the usual cause is Atlas Network Access:');
  console.error('add this machine\'s IP under Network Access in the Atlas dashboard.');
  process.exit(1);
});

process.on('SIGINT', async function () {
  await client.close().catch(function () {});
  process.exit(0);
});

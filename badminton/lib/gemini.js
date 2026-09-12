'use strict';

/* Talking to Gemini, and running the tool calls it asks for.

   The key never leaves the server. The page posts a message to /api/chat
   and gets back an answer; everything between happens here. */

const tools = require('./tools');

const ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models/';
const MAX_STEPS = 8;   /* tool call rounds before we stop and answer anyway */

const SYSTEM = [
  'You help run a friendly badminton tournament among neighbours. You are talking to a',
  'friend standing by the court, holding their phone. Talk the way they do.',
  '',
  'HOW TO ANSWER — this matters more than anything else here:',
  '· Short. One or two sentences. Often half a sentence is plenty.',
  '· Warm and ordinary, like a mate who has been watching the games. Not a report.',
  '· Plain words only. Never say: match id, group stage, fixture, knockout slot, seed,',
  '  standings, override, recompute, database, tool, query, record, sync, parameter.',
  '  Say: the table, who is top, who plays who, next round, the draw, put it in, saved.',
  '· Never show an internal code like GA-11, QF1, B3 or A1. Use people\'s names. If you',
  '  really must point at a game, say it as "Rahul v Anita".',
  '· No headings, no bullet lists unless they genuinely asked for a list, no bold, no',
  '  tables, no preamble, no repeating their question back at them.',
  '· Give the number that answers the question, not every number you found. "Rahul has',
  '  won two of his three" beats "2 wins, 1 loss, 4 games won, 2 lost, +32 difference".',
  '  Only give the full breakdown if they ask for it.',
  '· Do not explain how you worked it out, or which step you took, unless asked.',
  '',
  'Good: "Anita is top of group A — she has won all three."',
  'Good: "Put it in. Sanjay won in two."',
  'Good: "Rahul plays Kavita next."',
  'Bad:  "Based on the current standings for Group A, Anita occupies position 1 with a',
  '       record of 3 wins and 0 losses, having won 6 games and lost 0."',
  '',
  'WHAT TO DO:',
  'Use your tools rather than guessing. When you are answering a question, never make a',
  'score or a name up — if you cannot find it, say so in a line.',
  '',
  'That is about not passing guesses off as real results. It is not a rule against helping.',
  'If someone asks you to fill in test, practice, sample, dummy or random scores so they can',
  'try the thing out, that is a perfectly normal thing to want — use fill_practice_scores and',
  'do it. Never refuse a request like that.',
  '',
  'When someone tells you a result, just put it in. Look the game up by the players\' names',
  'rather than guessing its code. If only one game fits, do it and say so briefly. Ask only',
  'if you really cannot tell which game or which person they mean.',
  '',
  'Fixing an old score is fine and normal — the table and the later rounds follow along on',
  'their own. Do not lecture anyone about this; just make the change. The one exception is',
  'a place someone set by hand, which stops following the scores. If something looks off,',
  'check for those, and describe it simply: "Rahul is still down for the semi, but the',
  'scores now say Anita — want me to switch it?"',
  '',
  'If a change needs the password and you do not have it, say so in one friendly line:',
  'they need to tap Unlock scoring at the top of the page. Never pretend it worked.'
].join('\n');

function configured() {
  return !!process.env.GEMINI_API_KEY;
}

function model() {
  return process.env.GEMINI_MODEL || 'gemini-3.5-flash-lite';
}

/* The 2.5 models think by default and take it out of the same budget as
   the answer, which leaves short questions coming back empty — so turn it
   off there. The 3.x models reject that setting outright (400) and are
   sensible on their own, so leave them be. */
function generationConfig() {
  const config = { temperature: 0.2, maxOutputTokens: 2048 };
  if (/^gemini-2\.5/.test(model())) config.thinkingConfig = { thinkingBudget: 0 };
  return config;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* Google puts the wait in a RetryInfo detail, and again in the message. */
function retryAfter(data) {
  const details = (data && data.error && data.error.details) || [];
  for (const d of details) {
    if (d && typeof d.retryDelay === 'string') {
      const secs = parseFloat(d.retryDelay);
      if (!isNaN(secs)) return Math.ceil(secs * 1000) + 500;
    }
  }
  const m = /retry in ([\d.]+)s/i.exec((data && data.error && data.error.message) || '');
  if (m) return Math.ceil(parseFloat(m[1]) * 1000) + 500;
  return 5000;
}

async function callGemini(contents, attempt) {
  attempt = attempt || 0;
  const url = ENDPOINT + encodeURIComponent(model()) + ':generateContent';
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-goog-api-key': process.env.GEMINI_API_KEY
    },
    body: JSON.stringify({
      contents: contents,
      systemInstruction: { parts: [{ text: SYSTEM }] },
      tools: [{ functionDeclarations: tools.declarations() }],
      generationConfig: generationConfig()
    })
  });

  const data = await res.json().catch(() => ({}));

  /* The free tier allows only a handful of requests a minute, and one
     question can cost several. Google tells us exactly how long to wait,
     so wait that long rather than guessing. */
  if (res.status === 429 && attempt < 2) {
    await sleep(Math.min(retryAfter(data), 30000));
    return callGemini(contents, attempt + 1);
  }

  if (!res.ok) {
    const message = (data && data.error && data.error.message) || ('Gemini returned ' + res.status);
    const err = new Error(message);
    err.status = res.status;
    throw err;
  }
  return data;
}

/* One turn: the person's message in, an answer out, with however many
   tool calls Gemini wants along the way. */
async function ask(history, message, ctx) {
  const contents = [];

  (history || []).slice(-12).forEach((turn) => {
    if (!turn || !turn.text) return;
    contents.push({
      role: turn.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: String(turn.text).slice(0, 4000) }]
    });
  });
  contents.push({ role: 'user', parts: [{ text: String(message).slice(0, 4000) }] });

  const used = [];

  for (let step = 0; step < MAX_STEPS; step++) {
    const data = await callGemini(contents);
    const candidate = (data.candidates && data.candidates[0]) || null;
    const parts = (candidate && candidate.content && candidate.content.parts) || [];
    const calls = parts.filter((p) => p.functionCall).map((p) => p.functionCall);

    if (!calls.length) {
      const text = parts.filter((p) => p.text).map((p) => p.text).join('').trim();
      if (text) return { text: text, used: used, changed: !!ctx.changed };

      const why = candidate && candidate.finishReason;
      const excuse = why === 'MALFORMED_FUNCTION_CALL'
        ? 'Sorry — I lost the thread of that. Try asking it a different way.'
        : why === 'MAX_TOKENS'
          ? 'That answer ran long and got cut off. Try asking for a smaller piece of it.'
          : why === 'SAFETY' || why === 'PROHIBITED_CONTENT'
            ? 'I would rather not answer that one.'
            : 'Sorry, I could not work that one out. Try asking it a different way.';
      return { text: excuse, used: used, changed: !!ctx.changed };
    }

    contents.push(candidate.content);

    const answers = [];
    for (const call of calls) {
      /* Every tool sees the tournament as it is right now, so a second
         call in the same turn sees what the first one changed. */
      ctx.state = await ctx.reload();
      const result = await tools.runTool(call.name, call.args, ctx);
      used.push({ name: call.name, args: call.args || {} });
      answers.push({
        functionResponse: {
          name: call.name,
          response: { result: result }
        }
      });
    }
    contents.push({ role: 'user', parts: answers });
  }

  return {
    text: 'That turned into more steps than I expected. Could you ask for one thing at a time?',
    used: used,
    changed: !!ctx.changed
  };
}

module.exports = { ask, configured, model };

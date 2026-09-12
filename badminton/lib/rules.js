'use strict';

/* The tournament rules — standings, tie-breaks, who plays whom in the
   quarter-finals — live in one place: the first <script> block of
   public/index.html. The agent needs to answer questions using exactly
   those rules, so rather than keeping a second copy here that could drift
   out of step, we lift that block out of the page and run it in a sandbox.

   It is pure: no DOM, no state of its own, just functions over a state
   object. */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const PAGE = path.join(__dirname, '..', 'public', 'index.html');

function load() {
  const html = fs.readFileSync(PAGE, 'utf8');
  const blocks = [];
  const re = /<script>([\s\S]*?)<\/script>/g;
  let m;
  while ((m = re.exec(html)) !== null) blocks.push(m[1]);
  if (!blocks.length) throw new Error('No inline <script> found in public/index.html');

  const sandbox = { console: console };
  vm.createContext(sandbox);
  vm.runInContext(blocks[0], sandbox, { filename: 'index.html:rules' });

  if (typeof sandbox.makeState !== 'function' || typeof sandbox.standings !== 'function') {
    throw new Error('The rules engine did not load — has the first <script> block in index.html moved?');
  }
  return sandbox;
}

const rules = load();

/* The engine memoises into state._memo. Anything we hand it should get a
   clean slate, and nothing we hand it should be the caller's own object. */
rules.fresh = function fresh(state) {
  const copy = JSON.parse(JSON.stringify(state, (k, v) => (k.charAt(0) === '_' ? undefined : v)));
  copy._memo = {};
  return copy;
};

rules.strip = function strip(state) {
  return JSON.parse(JSON.stringify(state, (k, v) => (k.charAt(0) === '_' ? undefined : v)));
};

module.exports = rules;

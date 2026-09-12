'use strict';

/* What the assistant can actually do.

   Every tool is a plain function over the tournament document. Reads are
   open to anyone who can open the link; writes need the same password the
   scoring buttons need, and say so plainly when they do not have it, so
   the assistant can tell the person rather than silently doing nothing.

   Writes go through the same match-scoped update the scoring buttons use,
   so the assistant changing a score cannot clobber someone scoring a
   different court at the same time. */

const rules = require('./rules');

/* ---------- shared helpers ---------- */

function nameOf(state, id) {
  return id ? rules.playerName(state, id) : null;
}

/* People say "Rahul", not "A3". Take either, and be forgiving about case
   and stray spaces. */
function findPlayerId(state, who) {
  if (!who) return null;
  const needle = String(who).trim().toLowerCase();
  const all = rules.allPlayers(state);
  let hit = all.find((p) => p.id.toLowerCase() === needle);
  if (hit) return hit.id;
  hit = all.find((p) => String(p.name).trim().toLowerCase() === needle);
  if (hit) return hit.id;
  const partial = all.filter((p) => String(p.name).toLowerCase().includes(needle));
  if (partial.length === 1) return partial[0].id;
  return null;
}

function sideLabel(state, m, side) {
  const id = rules.resolveSlot(state, m[side]);
  if (id) return nameOf(state, id);
  const slot = m[side];
  if (!slot) return 'TBD';
  if (slot.k === 'grouppos') return 'Group ' + slot.group + ' #' + slot.pos;
  if (slot.k === 'seed') return 'Seed ' + slot.n;
  if (slot.k === 'winner') return 'Winner of ' + slot.of;
  if (slot.k === 'loser') return 'Loser of ' + slot.of;
  return 'TBD';
}

function describeMatch(state, m) {
  const played = m.games.filter((g) => g[0] !== null || g[1] !== null);
  const winner = rules.matchWinner(state, m);
  return {
    id: m.id,
    stage: m.stage,
    group: m.group || null,
    label: m.label || null,
    a: sideLabel(state, m, 'a'),
    b: sideLabel(state, m, 'b'),
    aPlayerId: rules.resolveSlot(state, m.a),
    bPlayerId: rules.resolveSlot(state, m.b),
    games: played.map((g) => g[0] + '-' + g[1]),
    score: played.length ? played.map((g) => g[0] + '-' + g[1]).join(', ') : null,
    played: played.length > 0,
    winner: winner ? sideLabel(state, m, winner) : null,
    winnerDecidedByHand: !!m.winner,
    note: m.note || ''
  };
}

function progress(state) {
  const done = state.matches.filter((m) => rules.matchWinner(state, m));
  return { matchesPlayed: done.length, matchesTotal: state.matches.length };
}

/* ---------- the tools ---------- */

/* Each entry: what Gemini is told about it, and what actually runs.
   `writes` marks the ones that need the password. */
const TOOLS = {

  /* ---- reading ---- */

  get_tournament_overview: {
    writes: false,
    description: 'The tournament at a glance: its name, venue, date, the rules in force, how many matches have been played, and how far each group has got. Start here when asked something general.',
    parameters: { type: 'object', properties: {} },
    run({ state }) {
      const groups = state.groups.map((g) => ({
        id: g.id,
        name: g.name,
        players: g.players.map((p) => p.name),
        complete: rules.groupComplete(state, g.id)
      }));
      return {
        name: state.meta.name,
        venue: state.meta.venue || null,
        date: state.meta.date || null,
        format: state.config.format + ' players',
        rules: {
          pointsToWin: state.config.pointsToWin,
          winByTwo: state.config.winByTwo,
          cap: state.config.cap || 'none',
          gamesPerMatch: 'best of ' + state.config.gamesPerMatch,
          thirdPlacePlayoff: !!state.config.thirdPlace
        },
        groups,
        progress: progress(state)
      };
    }
  },

  get_standings: {
    writes: false,
    description: 'The group table, in order, with played/won/lost, games won and lost, and points for and against. Give a group letter for one table, or leave it out for all four.',
    parameters: {
      type: 'object',
      properties: { group: { type: 'string', description: 'A, B, C or D. Omit for every group.' } }
    },
    run({ state }, args) {
      const wanted = args.group ? [String(args.group).trim().toUpperCase()] : state.groups.map((g) => g.id);
      return wanted.map((gid) => {
        const group = state.groups.find((g) => g.id === gid);
        if (!group) return { group: gid, error: 'No such group.' };
        return {
          group: gid,
          name: group.name,
          complete: rules.groupComplete(state, gid),
          orderedByHand: !!(state.standingOverride && state.standingOverride[gid]),
          table: rules.standings(state, gid).map((r, i) => ({
            position: i + 1,
            player: r.name,
            playerId: r.id,
            played: r.played,
            won: r.won,
            lost: r.lost,
            gamesWon: r.gw,
            gamesLost: r.gl,
            pointsFor: r.pf,
            pointsAgainst: r.pa
          }))
        };
      });
    }
  },

  get_matches: {
    writes: false,
    description: 'The fixture list, filtered however you need: by stage, by group, by player, or only the ones still to be played. Use this to answer "what is left", "who does X play next", "what were the results in group B".',
    parameters: {
      type: 'object',
      properties: {
        stage: { type: 'string', description: 'group, qf, sf, final or third' },
        group: { type: 'string', description: 'A, B, C or D' },
        player: { type: 'string', description: 'A player name or id — only their matches' },
        onlyPlayed: { type: 'boolean', description: 'Only matches with a result' },
        onlyUnplayed: { type: 'boolean', description: 'Only matches still to come' }
      }
    },
    run({ state }, args) {
      let list = state.matches.slice();
      if (args.stage) list = list.filter((m) => m.stage === String(args.stage).trim().toLowerCase());
      if (args.group) list = list.filter((m) => m.group === String(args.group).trim().toUpperCase());
      if (args.player) {
        const pid = findPlayerId(state, args.player);
        if (!pid) return { error: 'No player matches "' + args.player + '". Use list_players to see the names.' };
        list = list.filter((m) => rules.resolveSlot(state, m.a) === pid || rules.resolveSlot(state, m.b) === pid);
      }
      let out = list.map((m) => describeMatch(state, m));
      if (args.onlyPlayed) out = out.filter((m) => m.played);
      if (args.onlyUnplayed) out = out.filter((m) => !m.played);
      return { count: out.length, matches: out };
    }
  },

  get_match: {
    writes: false,
    description: 'One match in full, by its id — game by game.',
    parameters: {
      type: 'object',
      properties: { matchId: { type: 'string', description: 'For example GA-11 or QF1' } },
      required: ['matchId']
    },
    run({ state }, args) {
      const m = rules.findMatch(state, args.matchId);
      if (!m) return { error: 'No match with id ' + args.matchId + '.' };
      const out = describeMatch(state, m);
      out.gamesRaw = m.games;
      return out;
    }
  },

  get_knockout_bracket: {
    writes: false,
    description: 'The knockout draw with the names filled in as far as the scores allow. Places still waiting on a group are flagged as provisional.',
    parameters: { type: 'object', properties: {} },
    run({ state }) {
      return state.matches
        .filter((m) => m.stage !== 'group')
        .map((m) => {
          const d = describeMatch(state, m);
          d.aProvisional = rules.slotProvisional(state, m.a);
          d.bProvisional = rules.slotProvisional(state, m.b);
          d.aPinnedByHand = !!(m.a && m.a.override);
          d.bPinnedByHand = !!(m.b && m.b.override);
          return d;
        });
    }
  },

  get_player_stats: {
    writes: false,
    description: 'How a player has done across the whole tournament — matches won and lost, games, points for and against. Name a player, or leave it out for everyone, ranked.',
    parameters: {
      type: 'object',
      properties: { player: { type: 'string', description: 'A player name or id. Omit for all.' } }
    },
    run({ state }, args) {
      const stats = rules.overallStats(state);
      const rows = rules.allPlayers(state).map((p) => {
        const s = stats[p.id] || { won: 0, lost: 0, gw: 0, gl: 0, pf: 0, pa: 0 };
        return {
          player: p.name,
          playerId: p.id,
          group: p.group,
          matchesWon: s.won,
          matchesLost: s.lost,
          gamesWon: s.gw,
          gamesLost: s.gl,
          pointsFor: s.pf,
          pointsAgainst: s.pa,
          pointDifference: s.pf - s.pa
        };
      });
      if (args.player) {
        const pid = findPlayerId(state, args.player);
        if (!pid) return { error: 'No player matches "' + args.player + '".' };
        return rows.find((r) => r.playerId === pid);
      }
      rows.sort((x, y) => y.matchesWon - x.matchesWon || y.pointDifference - x.pointDifference);
      return rows;
    }
  },

  list_players: {
    writes: false,
    description: 'Every player with their id and group.',
    parameters: { type: 'object', properties: {} },
    run({ state }) {
      return rules.allPlayers(state).map((p) => ({ playerId: p.id, name: p.name, group: p.group }));
    }
  },

  list_tournaments: {
    writes: false,
    description: 'Every tournament saved on this server, newest first — for when someone asks about a different one, or about past events.',
    parameters: { type: 'object', properties: {} },
    async run({ collection, tournamentId }) {
      const docs = await collection
        .find({}, { projection: { name: 1, rev: 1, updatedAt: 1, createdAt: 1 } })
        .sort({ updatedAt: -1 })
        .limit(50)
        .toArray();
      return docs.map((d) => ({
        id: d._id,
        name: d.name,
        isTheOneOpenNow: d._id === tournamentId,
        link: '/?t=' + d._id,
        lastChanged: d.updatedAt,
        created: d.createdAt
      }));
    }
  },

  get_raw_state: {
    writes: false,
    description: 'The whole stored tournament exactly as it sits in the database. Only reach for this when the other tools cannot answer the question — it is large.',
    parameters: { type: 'object', properties: {} },
    run({ state }) { return rules.strip(state); }
  },

  /* ---- writing ---- */

  set_score: {
    writes: true,
    description: 'Set the score of a match, game by game. Pass every game played. To wipe a result, pass an empty list. This is the normal way to record a result.',
    parameters: {
      type: 'object',
      properties: {
        matchId: { type: 'string', description: 'For example GA-11 or QF1' },
        games: {
          type: 'array',
          description: 'One entry per game, each a pair of points, for example [[21,15],[19,21],[21,18]]',
          items: { type: 'array', items: { type: 'number' } }
        }
      },
      required: ['matchId', 'games']
    },
    async run(ctx, args) {
      const m = rules.findMatch(ctx.state, args.matchId);
      if (!m) return { error: 'No match with id ' + args.matchId + '.' };

      const games = [];
      const want = ctx.state.config.gamesPerMatch;
      (args.games || []).forEach((g) => {
        if (!Array.isArray(g)) return;
        games.push([numOrNull(g[0]), numOrNull(g[1])]);
      });
      while (games.length < want) games.push([null, null]);

      /* Warn rather than refuse: someone may be recording a match that was
         cut short, or a house rule we do not know about. */
      const problems = [];
      games.forEach((g, i) => {
        if (g[0] === null && g[1] === null) return;
        const issue = rules.gameIssue(ctx.state.config, g);
        if (issue) problems.push('Game ' + (i + 1) + ': ' + issue);
      });

      await ctx.patchMatch(args.matchId, { 'games': games });
      const after = await ctx.reload();
      const done = describeMatch(after, rules.findMatch(after, args.matchId));
      return {
        saved: true,
        match: done,
        warnings: problems.length ? problems : undefined,
        note: 'Everything downstream recomputes on its own — standings, and any knockout place that follows from them.'
      };
    }
  },

  set_game_score: {
    writes: true,
    description: 'Set a single game within a match, leaving the other games alone. Handy for "the second game was 21-18".',
    parameters: {
      type: 'object',
      properties: {
        matchId: { type: 'string' },
        gameNumber: { type: 'number', description: '1 for the first game, 2 for the second, and so on' },
        a: { type: 'number', description: 'Points for the first-named side' },
        b: { type: 'number', description: 'Points for the second-named side' }
      },
      required: ['matchId', 'gameNumber', 'a', 'b']
    },
    async run(ctx, args) {
      const m = rules.findMatch(ctx.state, args.matchId);
      if (!m) return { error: 'No match with id ' + args.matchId + '.' };
      const i = parseInt(args.gameNumber, 10) - 1;
      if (isNaN(i) || i < 0 || i >= m.games.length) {
        return { error: 'This match has ' + m.games.length + ' games; there is no game ' + args.gameNumber + '.' };
      }
      const games = m.games.map((g) => [g[0], g[1]]);
      games[i] = [numOrNull(args.a), numOrNull(args.b)];
      await ctx.patchMatch(args.matchId, { games: games });
      const after = await ctx.reload();
      return { saved: true, match: describeMatch(after, rules.findMatch(after, args.matchId)) };
    }
  },

  clear_match_score: {
    writes: true,
    description: 'Wipe a match back to unplayed — every game blank and any hand-picked winner removed.',
    parameters: {
      type: 'object',
      properties: { matchId: { type: 'string' } },
      required: ['matchId']
    },
    async run(ctx, args) {
      const m = rules.findMatch(ctx.state, args.matchId);
      if (!m) return { error: 'No match with id ' + args.matchId + '.' };
      const blank = m.games.map(() => [null, null]);
      await ctx.patchMatch(args.matchId, { games: blank, winner: null });
      return { cleared: true, matchId: args.matchId };
    }
  },

  set_match_winner: {
    writes: true,
    description: 'Award a match to one side without a score — a walkover or a retirement. Pass the player name or id, or nothing to undo it and go back to the scores.',
    parameters: {
      type: 'object',
      properties: {
        matchId: { type: 'string' },
        player: { type: 'string', description: 'The winner, by name or id. Omit to clear.' }
      },
      required: ['matchId']
    },
    async run(ctx, args) {
      const m = rules.findMatch(ctx.state, args.matchId);
      if (!m) return { error: 'No match with id ' + args.matchId + '.' };
      if (!args.player) {
        await ctx.patchMatch(args.matchId, { winner: null });
        return { cleared: true, matchId: args.matchId };
      }
      const pid = findPlayerId(ctx.state, args.player);
      if (!pid) return { error: 'No player matches "' + args.player + '".' };
      const side = rules.resolveSlot(ctx.state, m.a) === pid ? 'a'
        : rules.resolveSlot(ctx.state, m.b) === pid ? 'b' : null;
      if (!side) return { error: nameOf(ctx.state, pid) + ' is not in match ' + args.matchId + '.' };
      await ctx.patchMatch(args.matchId, { winner: side });
      const after = await ctx.reload();
      return { saved: true, match: describeMatch(after, rules.findMatch(after, args.matchId)) };
    }
  },

  set_match_note: {
    writes: true,
    description: 'Attach a short note to a match — "retired at 11-8", "rain delay", that sort of thing.',
    parameters: {
      type: 'object',
      properties: { matchId: { type: 'string' }, note: { type: 'string' } },
      required: ['matchId', 'note']
    },
    async run(ctx, args) {
      if (!rules.findMatch(ctx.state, args.matchId)) return { error: 'No match with id ' + args.matchId + '.' };
      await ctx.patchMatch(args.matchId, { note: String(args.note).slice(0, 500) });
      return { saved: true, matchId: args.matchId, note: args.note };
    }
  },

  rename_player: {
    writes: true,
    description: 'Change a player\'s name. Their results stay with them.',
    parameters: {
      type: 'object',
      properties: {
        player: { type: 'string', description: 'Who to rename, by current name or id' },
        newName: { type: 'string' }
      },
      required: ['player', 'newName']
    },
    async run(ctx, args) {
      const pid = findPlayerId(ctx.state, args.player);
      if (!pid) return { error: 'No player matches "' + args.player + '".' };
      const next = rules.strip(ctx.state);
      let was = null;
      next.groups.forEach((g) => g.players.forEach((p) => {
        if (p.id === pid) { was = p.name; p.name = String(args.newName).slice(0, 60); }
      }));
      await ctx.saveState(next);
      return { saved: true, playerId: pid, was: was, now: args.newName };
    }
  },

  set_tournament_info: {
    writes: true,
    description: 'Change the tournament name, venue or date. Pass only what should change.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        venue: { type: 'string' },
        date: { type: 'string' }
      }
    },
    async run(ctx, args) {
      const next = rules.strip(ctx.state);
      ['name', 'venue', 'date'].forEach((k) => {
        if (args[k] !== undefined) next.meta[k] = String(args[k]).slice(0, 200);
      });
      await ctx.saveState(next);
      return { saved: true, meta: next.meta };
    }
  },

  set_rules: {
    writes: true,
    description: 'Change how matches are scored: points to win, whether you must win by two, the cap, and best-of how many games. Pass only what should change. Changing best-of resizes every match.',
    parameters: {
      type: 'object',
      properties: {
        pointsToWin: { type: 'number' },
        winByTwo: { type: 'boolean' },
        cap: { type: 'number', description: '0 for no cap' },
        gamesPerMatch: { type: 'number', description: '1, 3, 5 or 7' },
        thirdPlace: { type: 'boolean', description: 'Whether to play off for third' }
      }
    },
    async run(ctx, args) {
      const next = rules.strip(ctx.state);
      if (args.pointsToWin !== undefined) next.config.pointsToWin = Math.max(1, parseInt(args.pointsToWin, 10) || 21);
      if (args.winByTwo !== undefined) next.config.winByTwo = !!args.winByTwo;
      if (args.cap !== undefined) next.config.cap = Math.max(0, parseInt(args.cap, 10) || 0);
      if (args.thirdPlace !== undefined) next.config.thirdPlace = !!args.thirdPlace;
      if (args.gamesPerMatch !== undefined) {
        const n = parseInt(args.gamesPerMatch, 10);
        if ([1, 3, 5, 7].indexOf(n) < 0) return { error: 'Best of 1, 3, 5 or 7 only.' };
        next.config.gamesPerMatch = n;
        rules.resizeGames(next);
      }
      await ctx.saveState(next);
      return { saved: true, rules: next.config };
    }
  },

  pin_knockout_place: {
    writes: true,
    description: 'Put a particular player into a knockout place by hand, overriding what the scores say. Use sparingly: while a place is pinned, later score corrections stop reaching it.',
    parameters: {
      type: 'object',
      properties: {
        matchId: { type: 'string', description: 'For example QF1 or SF2' },
        side: { type: 'string', description: 'a for the top place, b for the bottom' },
        player: { type: 'string', description: 'Who to put there, by name or id' }
      },
      required: ['matchId', 'side', 'player']
    },
    async run(ctx, args) {
      const m = rules.findMatch(ctx.state, args.matchId);
      if (!m) return { error: 'No match with id ' + args.matchId + '.' };
      const side = String(args.side).trim().toLowerCase();
      if (side !== 'a' && side !== 'b') return { error: 'Side must be a or b.' };
      const pid = findPlayerId(ctx.state, args.player);
      if (!pid) return { error: 'No player matches "' + args.player + '".' };
      await ctx.patchMatch(args.matchId, side === 'a' ? { aOverride: pid } : { bOverride: pid });
      return {
        saved: true,
        matchId: args.matchId,
        side: side,
        player: nameOf(ctx.state, pid),
        warning: 'This place is now pinned by hand. Score changes will no longer move it until the pin is cleared.'
      };
    }
  },

  clear_knockout_pin: {
    writes: true,
    description: 'Remove a hand-picked knockout place and let the scores decide it again.',
    parameters: {
      type: 'object',
      properties: {
        matchId: { type: 'string' },
        side: { type: 'string', description: 'a, b, or both' }
      },
      required: ['matchId']
    },
    async run(ctx, args) {
      if (!rules.findMatch(ctx.state, args.matchId)) return { error: 'No match with id ' + args.matchId + '.' };
      const side = String(args.side || 'both').trim().toLowerCase();
      const patch = {};
      if (side === 'a' || side === 'both') patch.aOverride = null;
      if (side === 'b' || side === 'both') patch.bOverride = null;
      await ctx.patchMatch(args.matchId, patch);
      const after = await ctx.reload();
      return { cleared: true, match: describeMatch(after, rules.findMatch(after, args.matchId)) };
    }
  },

  set_group_order: {
    writes: true,
    description: 'Order a group by hand, for a tie the tie-breaks cannot settle. Give the players in the order you want. While an order is pinned, score changes stop moving it.',
    parameters: {
      type: 'object',
      properties: {
        group: { type: 'string', description: 'A, B, C or D' },
        players: { type: 'array', description: 'Every player in the group, in the order they should finish', items: { type: 'string' } }
      },
      required: ['group', 'players']
    },
    async run(ctx, args) {
      const gid = String(args.group).trim().toUpperCase();
      const group = ctx.state.groups.find((g) => g.id === gid);
      if (!group) return { error: 'No group ' + gid + '.' };
      const ids = [];
      for (const who of args.players || []) {
        const pid = findPlayerId(ctx.state, who);
        if (!pid) return { error: 'No player matches "' + who + '".' };
        if (!group.players.some((p) => p.id === pid)) return { error: nameOf(ctx.state, pid) + ' is not in group ' + gid + '.' };
        ids.push(pid);
      }
      if (ids.length !== group.players.length) {
        return { error: 'Give all ' + group.players.length + ' players of group ' + gid + ', in order.' };
      }
      const next = rules.strip(ctx.state);
      next.standingOverride = next.standingOverride || {};
      next.standingOverride[gid] = ids;
      await ctx.saveState(next);
      return { saved: true, group: gid, order: ids.map((id) => nameOf(ctx.state, id)) };
    }
  },

  clear_group_order: {
    writes: true,
    description: 'Drop a hand-set group order and go back to the order the scores produce.',
    parameters: {
      type: 'object',
      properties: { group: { type: 'string' } },
      required: ['group']
    },
    async run(ctx, args) {
      const gid = String(args.group).trim().toUpperCase();
      const next = rules.strip(ctx.state);
      if (!next.standingOverride || !next.standingOverride[gid]) {
        return { error: 'Group ' + gid + ' is not ordered by hand.' };
      }
      delete next.standingOverride[gid];
      await ctx.saveState(next);
      return { cleared: true, group: gid };
    }
  },

  find_pinned_places_that_disagree_with_the_scores: {
    writes: false,
    description: 'Find every hand-set place — knockout picks, group orders, seed pins — that no longer agrees with what the scores now say. Use this when asked whether anything looks wrong, or after correcting an old score.',
    parameters: { type: 'object', properties: {} },
    run({ state }) {
      const out = [];

      state.matches.forEach((m) => {
        ['a', 'b'].forEach((side) => {
          if (!m[side] || !m[side].override) return;
          const shadow = rules.fresh(state);
          const sm = rules.findMatch(shadow, m.id);
          delete sm[side].override;
          shadow._memo = {};
          const computed = rules.resolveSlot(shadow, sm[side]);
          if (computed && computed !== m[side].override) {
            out.push({
              what: 'knockout place',
              matchId: m.id,
              side: side,
              pinnedTo: nameOf(state, m[side].override),
              scoresSay: nameOf(state, computed),
              fixWith: 'clear_knockout_pin'
            });
          }
        });
      });

      Object.keys(state.standingOverride || {}).forEach((gid) => {
        const pinned = state.standingOverride[gid];
        if (!Array.isArray(pinned) || !pinned.length) return;
        const shadow = rules.fresh(state);
        delete shadow.standingOverride[gid];
        shadow._memo = {};
        const auto = rules.standings(shadow, gid).map((r) => r.id);
        if (auto.join('|') === pinned.join('|')) return;
        out.push({
          what: 'group order',
          group: gid,
          pinnedTo: pinned.map((id) => nameOf(state, id)),
          scoresSay: auto.map((id) => nameOf(state, id)),
          fixWith: 'clear_group_order'
        });
      });

      Object.keys(state.seedOverride || {}).forEach((n) => {
        const pinned = state.seedOverride[n];
        if (!pinned) return;
        const shadow = rules.fresh(state);
        delete shadow.seedOverride[n];
        shadow._memo = {};
        const auto = rules.semiSeeds(shadow)[parseInt(n, 10) - 1];
        if (!auto || auto === pinned) return;
        out.push({
          what: 'semi-final seed',
          seed: parseInt(n, 10),
          pinnedTo: nameOf(state, pinned),
          scoresSay: nameOf(state, auto),
          fixWith: 'clear_seed_pin'
        });
      });

      return out.length ? out : { allClear: true, message: 'Nothing pinned by hand disagrees with the scores.' };
    }
  },

  fill_practice_scores: {
    writes: true,
    description: 'Fill matches with made-up scores, for trying the tournament out before it is really played. Defaults to the group stage and to matches with no result yet. Use this whenever someone asks for test, practice, sample, dummy or random scores — that is a normal thing to want and does not count as inventing a result.',
    parameters: {
      type: 'object',
      properties: {
        stage: { type: 'string', description: 'group, qf, sf, final, or all. Defaults to group.' },
        group: { type: 'string', description: 'A, B, C or D, to fill just one group.' },
        overwrite: { type: 'boolean', description: 'true to replace results already entered. Defaults to false.' }
      }
    },
    async run(ctx, args) {
      const next = rules.strip(ctx.state);
      const config = next.config;
      const overwrite = !!args.overwrite;
      const group = args.group ? String(args.group).trim().toUpperCase() : null;
      const stage = String(args.stage || 'group').trim().toLowerCase();
      const order = stage === 'all' ? ['group', 'qf', 'sf', 'third', 'final'] : [stage === 'third' ? 'third' : stage];

      if (order.some((s) => ['group', 'qf', 'sf', 'third', 'final'].indexOf(s) < 0)) {
        return { error: 'Stage must be group, qf, sf, final or all.' };
      }

      const filled = [];
      const skipped = [];

      /* Stage by stage, so the knockout knows who reached it: the group
         scores are in place before a quarter-final asks who won the group. */
      for (const which of order) {
        next._memo = {};
        for (const m of next.matches) {
          if (m.stage !== which) continue;
          if (group && m.group !== group) continue;
          if (which === 'third' && !config.thirdPlace) continue;

          const played = m.games.some((g) => g[0] !== null || g[1] !== null) || m.winner;
          if (played && !overwrite) { skipped.push(m.id); continue; }

          /* Only fill a knockout match once both places are settled. */
          if (which !== 'group') {
            if (!rules.resolveSlot(next, m.a) || !rules.resolveSlot(next, m.b)) { skipped.push(m.id); continue; }
          }

          m.games = randomMatch(config);
          m.winner = null;
          next._memo = {};
          filled.push({
            match: nameOf(next, rules.resolveSlot(next, m.a)) + ' v ' + nameOf(next, rules.resolveSlot(next, m.b)),
            score: m.games.filter((g) => g[0] !== null).map((g) => g[0] + '-' + g[1]).join(', ')
          });
        }
      }

      /* One unambiguous sentence, because a result the model has to piece
         together from several fields is one it can report back wrongly. */
      if (!filled.length) {
        return {
          outcome: 'nothing-to-do',
          message: skipped.length
            ? 'Nothing was filled in: all ' + skipped.length + ' of those matches already have a result. Ask whether they want them overwritten.'
            : 'Nothing was filled in: no matches matched that.'
        };
      }

      await ctx.saveState(rules.strip(next));
      return {
        outcome: 'filled',
        message: 'Done. Filled ' + filled.length + ' match' + (filled.length === 1 ? '' : 'es') +
                 ' with made-up scores' +
                 (skipped.length ? ', and left ' + skipped.length + ' alone that already had results' : '') +
                 '. The tables and the draw have worked themselves out from them. Tell the person this is done.',
        examples: filled.slice(0, 4)
      };
    }
  },

  clear_seed_pin: {
    writes: true,
    description: 'Drop a hand-set semi-final seed and let the results decide it.',
    parameters: {
      type: 'object',
      properties: { seed: { type: 'number', description: '1, 2, 3 or 4' } },
      required: ['seed']
    },
    async run(ctx, args) {
      const n = String(parseInt(args.seed, 10));
      const next = rules.strip(ctx.state);
      if (!next.seedOverride || !next.seedOverride[n]) return { error: 'Seed ' + n + ' is not pinned.' };
      delete next.seedOverride[n];
      await ctx.saveState(next);
      return { cleared: true, seed: parseInt(n, 10) };
    }
  }
};

function numOrNull(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = parseInt(v, 10);
  return isNaN(n) ? null : n;
}

/* ---------- made-up scores that look like real ones ---------- */

const pick = (n) => Math.floor(Math.random() * n);

/* One game, obeying whatever the tournament is actually playing to. */
function randomGame(config) {
  const target = Math.max(2, config.pointsToWin);
  const cap = config.cap > 0 ? Math.max(config.cap, target) : target + 9;

  /* Every so often, a scrappy one that goes past the target. */
  if (config.winByTwo && cap > target && Math.random() < 0.2) {
    const high = Math.min(target + 1 + pick(Math.min(4, cap - target)), cap);
    return [high, high === cap ? high - 1 : high - 2];
  }
  const floor = Math.max(0, target - 14);
  const loser = Math.min(floor + pick(Math.max(1, target - 2 - floor + 1)), target - 2);
  return [target, Math.max(0, loser)];
}

/* A whole match: the right number of games for the format, a clear winner,
   and the decider last, the way it would have been played. */
function randomMatch(config) {
  const per = config.gamesPerMatch;
  const need = Math.floor(per / 2) + 1;
  const winnerIsA = Math.random() < 0.5;

  const sequence = [];
  for (let i = 0; i < need; i++) sequence.push('w');
  for (let i = 0; i < pick(need); i++) sequence.push('l');

  /* Shuffle, then make sure the match ends on the winner taking a game. */
  for (let i = sequence.length - 1; i > 0; i--) {
    const j = pick(i + 1);
    const t = sequence[i]; sequence[i] = sequence[j]; sequence[j] = t;
  }
  const lastW = sequence.lastIndexOf('w');
  sequence.splice(lastW, 1);
  sequence.push('w');

  const games = sequence.map((who) => {
    const g = randomGame(config);
    const aTookIt = (who === 'w') === winnerIsA;
    return aTookIt ? [g[0], g[1]] : [g[1], g[0]];
  });
  while (games.length < per) games.push([null, null]);
  return games;
}

/* ---------- what Gemini gets told ---------- */

function declarations() {
  return Object.keys(TOOLS).map((name) => {
    const t = TOOLS[name];
    /* Always send a parameters object, even an empty one. Leaving it off a
       no-argument tool makes the model return an empty turn rather than
       calling it — which looked like it had simply failed to answer. */
    return {
      name: name,
      description: t.description,
      parameters: t.parameters || { type: 'object', properties: {} }
    };
  });
}

/* ---------- running one ---------- */

async function runTool(name, args, ctx) {
  const tool = TOOLS[name];
  if (!tool) return { error: 'There is no tool called ' + name + '.' };
  if (tool.writes && !ctx.isAdmin) {
    return {
      error: 'Changing anything needs the tournament password. Tell the person to press Unlock scoring at the top of the page and enter it, then ask again.',
      refused: true
    };
  }
  try {
    const out = await tool.run(ctx, args || {});
    if (tool.writes) ctx.changed = true;
    return out === undefined ? { done: true } : out;
  } catch (err) {
    return { error: String((err && err.message) || err) };
  }
}

module.exports = { TOOLS, declarations, runTool, findPlayerId, describeMatch };

# Badminton tournament

A single-page tournament scorer — groups into quarter-finals, semi-finals and a
final — with a small server behind it so several phones can score one event,
everyone else can watch, and you can just ask it things.

The scoring page itself is unchanged from the original standalone file.
Everything added since sits alongside it.

## Running it

```sh
npm install
npm start                # http://localhost:3100
```

Settings live in `.env` (already filled in). `.env.example` shows the shape.
Port 3100 rather than 3000, because the workflows_v2 dev service uses 3000.

## Putting it online

**Not Vercel.** This is a long-running server holding an open MongoDB connection,
and Vercel runs short-lived serverless functions. It can be made to work, but you
would have to restructure the routes, cache the Mongo connection across cold
starts, and the two in-memory rate limiters would stop working because each
invocation gets its own memory. Use a platform that just runs Node.

**Render** (free) or **Railway** (about $5/mo, never sleeps). Either takes minutes:

1. Put this folder in its own Git repo.
2. New Web Service → point it at the repo.
3. Build `npm install`, start `npm start`.
4. Set the environment variables below in the dashboard — `.env` is gitignored and
   does not travel with the repo.
5. Atlas → Network Access → allow `0.0.0.0/0`. Both platforms use changing IPs, so
   an allow-list of one address will not hold.

| variable | |
|---|---|
| `MONGODB_URI` | the Atlas connection string |
| `MONGODB_DB` | `badminton` |
| `ADMIN_PASSWORD` | the scoring password |
| `SESSION_SECRET` | any long random string — **must** be set, or every restart signs the scorers out |
| `GEMINI_API_KEY` | for the assistant |
| `GEMINI_MODEL` | `gemini-3.5-flash-lite` |
| `KEEP_AWAKE_URL` | the public address, so it can ping itself (optional) |
| `KEEP_AWAKE_MINUTES` | how often, default 12 (optional) |

Do not set `PORT`; the platform provides it and the server already reads it.

Render's free tier sleeps after about 15 minutes idle and takes the best part of a
minute to wake. Fine if someone opens it before the first match; irritating if it
happens mid-tournament. Railway does not sleep.

### Keeping it awake

`GET /api/ping` is the cheapest route in the server — no database, 58 bytes, about
a millisecond — and answers `no-store` so nothing caches it and leaves the host
seeing no traffic. Add `?db=1` when you actually want to know whether Mongo is
reachable; do not point a keep-alive at that version.

Set `KEEP_AWAKE_URL` to the public address and the server pings itself every
`KEEP_AWAKE_MINUTES` (12 by default, and it refuses a localhost target as
pointless). That covers a quiet evening between matches.

**It cannot wake anything.** If the host has already stopped the service, the timer
stopped with it — that is worth being plain about, because a self-ping is often
sold as if it solved the whole problem. For the case where it has genuinely gone
to sleep, something outside has to ask: a free UptimeRobot monitor or a
cron-job.org entry pointed at `/api/ping` every 10 minutes does it, and keeps
working when the service is down, which is exactly when you need it.

Worth knowing: while anyone has the scoreboard open, the page already polls every
four seconds, so the server never sleeps during a tournament. The gap this closes
is the one between sessions.

Two things to do before the link goes anywhere: rotate the Atlas password and the
Gemini key, and remember that anyone with the URL can read the scoreboard and post
in the threads. Only scoring is behind the password.

## How it hangs together

```
public/index.html   the scorer. Untouched but for two <script> tags.
public/theme.css    the palette and the soft edges, layered on top.
public/sync.js      live sync, the password, the stale-pin nudge.
public/agent.js     the assistant bubble.
server.js           express + mongodb + the chat endpoint.
lib/rules.js        the page's own rules engine, lifted out for the server.
lib/tools.js        what the assistant is allowed to do.
lib/gemini.js       talking to Gemini.
```

**It is always live.** Open the site and you are on the tournament everybody else
is on — there is nothing to press first. If the database is empty the server starts
a blank tournament itself, so the very first visit works like every other one.

The only control is **Unlock scoring** / **Lock**. Locked, you watch. Unlocked with
the password, you score.

`?local=1` forces a private copy on this phone alone, if you ever want a scratch
draw. If the server cannot be reached at all, the page falls back to that by itself
rather than showing nothing.

Under the hood `sync.js` wraps three globals — `commit`, `render` and `stash` —
rather than editing the code beneath them, so the original rendering and rules are
left exactly as they were.

### Who can do what

Reading is open, writing needs the password (`singles@1234`, set in `.env`). The
token is a signed 12-hour string, checked by the server on every write — turning
the fields back on in the browser gets you nowhere. The same check covers the
assistant, so it will not change anything for someone who has not unlocked.

`SESSION_SECRET` is pinned in `.env` so a restart does not sign the scorers out.

### Two people scoring at once

Scores are written one match at a time, so two scorers on two courts touch
different parts of the document and neither can overwrite the other.

Changes to the draw itself — names, format, a hand-ordered group — save the whole
tournament at once, and carry the revision they were based on. If someone else
saved first the write is refused rather than applied, and the page loads their
version instead of quietly discarding it.

Each page polls every four seconds, and holds off applying what comes back while
a field is focused or was typed in within the last three seconds, so an incoming
update can never yank a half-entered score out from under the person typing it.

### Losing signal

Already open when the connection drops: keep scoring. Edits queue, the page says
**Offline**, and they go up on reconnect. A copy is kept on the device under a
key of the tournament's own, so a refresh does not cost you anything — and your
own local tournament, if you had one, is left where it was.

Opening a live link *while* offline is different: there is no way to tell how far
behind the on-device copy is, so it is shown but not editable until the server is
reachable. Better than losing scores to a silent overwrite.

## The assistant

The bubble in the corner. Ask it anything about the tournament, or just tell it a
result and it will put it in:

> **you** — Sanjay beat Priya 21-15 21-18 in group B
> **it** — Got it, recorded Sanjay's win over Priya 21-15, 21-18.

It worked out on its own that that match is `GB-31`. You never need to know a
match id.

> **you** — I got group A wrong, Anita actually beat Rahul 21-14 21-16. who tops
> the group now?
> **it** — Anita tops the group now.

It found the match, fixed the score, and the standings and the quarter-final
place followed on their own.

It has 24 tools covering everything in the database: the tables, the fixtures,
the bracket, a player's record, every tournament on the server, and the whole raw
document if nothing else fits. On the writing side: scores, single games, walkovers,
notes, player names, the tournament details, the scoring rules, and the three kinds
of hand-set place. It can also fill the draw with made-up scores — ask for test or
practice scores — which is handy for seeing how the whole thing plays out before
anyone picks up a racket. Those follow the tournament's own rules, so the tables
and the bracket come out looking like a real event. Reads are open to anyone with the link; every write needs the
password, and it says so rather than pretending.

The key stays on the server. The page only ever posts to `/api/chat`.

The conversation is kept on the phone it was had on, one per tournament, so a
reload or a locked screen does not lose it. **Clear** in the panel header wipes it.
Each person's chat is their own — it is not shared with everyone watching.

When the assistant changes something, the scoreboard behind the panel is pulled
fresh immediately rather than waiting for the next four-second poll, and says
*scoreboard updated* so you can see it landed. Everyone else's page picks it up on
their next poll.

### The Gemini key

`GEMINI_API_KEY` and `GEMINI_MODEL` in `.env`. Two things learned the hard way:

- **The model matters.** `gemini-2.5-flash-lite` is no longer offered to new keys,
  and the 2.5 models spend their whole output budget on thinking unless you pass
  `thinkingConfig.thinkingBudget: 0` — which the 3.x models reject outright. The
  code picks the right shape per model; the default is `gemini-3.5-flash-lite`.
- **The free tier is about five requests a minute**, and one question can cost
  several. Ordinary use is fine. Ask a dozen things in a row and it will pause —
  the server reads Google's own "retry in N seconds" and waits that long before
  trying again, and tells you plainly if it still cannot get through.

## The look

`theme.css` loads after the page's own `<style>` and only ever overrides: it
redefines the `:root` variables and softens edges, shadows and transitions. It
changes no layout — the grid, the tab strip and the score board keep the shape
they were built with. Deleting the injection at the top of `sync.js` puts the
original appearance back exactly.

## Final placings

The Summary tab opens with a placings panel: first and second from the final,
third and fourth from the third-place match. Without that match turned on it shows
only first and second — the two beaten semi-finalists are genuinely joint third, so
it does not invent an order between them, it just says where to turn it on.

Places not yet decided show as dashed and *still to be decided* rather than
guessing. It prints with the rest of the summary.

## The sledging corner

Every match box has a thread tucked under it, collapsed, labelled **Sledging
corner** with a count. Click to open it, say your piece, click to shut it.

Anyone who can see the scoreboard can post — no password, that is the point of it —
and picks a name the first time, kept on their own device, changeable from the
line under the box. The read-only gate spares the thread by name, since it lives
inside `#app` alongside the score fields it does lock. Removing someone else's remark needs
the scoring password. Comments live beside the tournament in the same document
rather than inside `state`, because the page's own `normalize()` rebuilds `state`
from scratch on every load and would throw them away.

The page redraws the whole of `#app` on every keystroke, so the open/shut state of
each thread, any half-typed remark and the caret inside it are all held outside the
DOM and put back after each render.

## Correcting a score later

Any score can be changed at any time, including a group match after the knockout
has been drawn. This is how the page already worked — every knockout place is
worked out from the scores on each render, never frozen — so a correction flows
through the standings, the quarter-finals, the semis and the final on its own.

Three things opt out of that, by design: picking a player into a knockout slot by
hand, dragging a group into a manual order, and pinning a semi-final seed. Each
stops later edits from reaching that spot, which is the point of them — but it
used to happen silently.

Now, when a pin stops agreeing with what the scores say, a note appears above the
tabs saying so, with **Use the scores** to drop the pin and let the recomputation
through, or **Keep my pick** to leave it and say no more about it. The assistant
can check the same thing if you ask whether anything looks wrong.

## The database

One document per tournament in `tournaments`:

```js
{ _id, name, state, rev, createdAt, updatedAt }
```

`state` is exactly what the page would have written to `localStorage`. The server
checks its shape and nothing more — the rules live in the browser, in one place,
and `lib/rules.js` lifts that same code out of the page rather than keeping a
second copy that could drift.

| | |
|---|---|
| `POST /api/login` | password in, token out |
| `GET /api/session` | is this token still good |
| `POST /api/tournaments` | create · needs a token |
| `GET /api/tournaments/current` | the one being played · open to all · starts one if there is none |
| `GET /api/tournaments/:id` | read · open to all |
| `GET /api/tournaments/:id/rev` | the poll |
| `PUT /api/tournaments/:id` | whole tournament · needs a token · `409` if stale |
| `PATCH /api/tournaments/:id/matches/:matchId` | one match · needs a token |
| `GET /api/chat/status` | is the assistant switched on |
| `POST /api/chat` | ask it something · token optional, needed to change anything |

## Two things to keep in mind

The Atlas password and the Gemini key were both shared in chat to set this up —
worth rotating both when you get a moment.

If the server hangs on start rather than failing, it is almost always Atlas
Network Access: the machine's IP needs to be on the list.

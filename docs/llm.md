# Brains for the bots

The Mafia bots always play. What this file is about is *how well they talk* while
they do it, and how to give a deployment a language model without giving it a
graphics card.

## The chain

`MAFIA_BOT_PROVIDER` is a comma-separated list, tried in order:

```
MAFIA_BOT_PROVIDER=openai,ollama
```

| Rung            | What it is                                                          | Needs                            |
| --------------- | ------------------------------------------------------------------- | -------------------------------- |
| `api1`…`api4`   | Endpoints speaking `/chat/completions` — OpenRouter, Groq, Cerebras, a vLLM you host | `MAFIA_API_*_KEY` + `_MODEL`    |
| `anthropic`     | The Claude API                                                       | `ANTHROPIC_API_KEY`              |
| `ollama`        | A local daemon at `OLLAMA_URL`                                       | a running Ollama                 |
| `scripted`      | Call nothing                                                         | —                                |

`openai` is the old name for `api1` and still works. Slots 2–4 inherit slot 1's
URL and key, so several free models on one provider cost one line each:

```
MAFIA_BOT_PROVIDER=api1,api2,api3,ollama
MAFIA_API_URL=https://api.groq.com/openai/v1
MAFIA_API_KEY=gsk_…
MAFIA_API_MODEL=openai/gpt-oss-120b
MAFIA_API_2_MODEL=openai/gpt-oss-20b
MAFIA_API_3_URL=https://openrouter.ai/api/v1
MAFIA_API_3_KEY=sk-or-v1-…
MAFIA_API_3_MODEL=cohere/north-mini-code:free
```

Slots 1 and 2 share Groq's URL and key by inheritance; slot 3 overrides both
because it is a different vendor. Either way round works.

## "OpenAI-compatible" stops at the message shape

Suppressing a reasoning model's deliberation is where every one of these
endpoints goes its own way, and getting it wrong is not cosmetic: a reasoning
model given a 300-token budget spends all 300 narrating its plan and returns
`content: ""` with `finish_reason: length`. That looks exactly like a broken
endpoint and costs a request from a daily quota to discover.

Measured, one call each:

| Endpoint                   | Accepts                        | Warm call |
| -------------------------- | ------------------------------ | --------- |
| Groq `openai/gpt-oss-120b` | `reasoning_effort: "low"`      | 465 ms    |
| Groq `openai/gpt-oss-20b`  | `reasoning_effort: "low"`      | 181 ms    |
| Groq `qwen/qwen3.6-27b`    | `reasoning_effort: "none"`     | 392 ms    |
| Groq `groq/compound-mini`  | neither key — send nothing     | 992 ms    |
| OpenRouter `minimax-m3`    | `reasoning: {enabled: false}`  | 1112 ms   |

There is no safe default in that table. Asking bare is not one either — Groq's
`gpt-oss-20b` and `qwen3.6-27b` both answered `json_validate_failed` with no
reasoning setting and answered correctly with one.

So the client does not guess. `QUIET_FORMS` in `bots.ts` lists the dialects, and
every form an endpoint does not understand comes back 400 — which makes walking
forward on a 400 the entire search. It runs once per slot, costs at most three
wasted requests, and the answer is remembered for the life of the process. The
log says `mafia bots: endpoint dialect learned` with the form it settled on.

A remembered form that starts refusing is forgotten and re-learned, because the
model behind a slot can be changed under you.

A rung with no credentials is dropped at startup rather than discovered per
call, so the line the server logs on boot is the truth about what it can do.
A rung that errors or rate-limits is benched for `MAFIA_BOT_COOLDOWN_MS` and the
chain moves down.

**The last fall is never nothing.** Below every rung is the simulator's own
player — the same brain the headless bench runs, which claims, accuses, lies,
answers questions, writes a will and votes with its family. A table with no model
anywhere near it is still a table with people arguing at it. The difference a
model makes is *how* they argue, not whether.

Telling which one you got, from the outside, is deliberately hard. From the
inside it is one log line: the driver says `mafia bots: this brain is answering`
once per rung, with the model name.

## Running the model on the box itself

`docker compose` ships an `ollama` service behind a profile. Turn it on with one
line in the `.env` beside the compose file:

```
COMPOSE_PROFILES=llm
```

then the usual `docker compose up -d`. Pull a model once:

```
docker compose exec ollama ollama pull qwen3.5:4b
```

It publishes nothing but loopback. The API reaches it over the compose network
as `http://ollama:11434`, which is what `OLLAMA_URL` defaults to inside the
container — a model daemon has no authentication of any kind and no business
being reachable from the LAN.

`OLLAMA_URL` does not have to be local. `ssh -N -L 11434:127.0.0.1:11434 box`
and the default value already points at another machine; nothing in the code
knows what SSH is.

## Free tiers, and how they actually fail

Not by running out at midnight. By answering **429 right now**, because the free
pool is shared and somebody else is in it. Measured against OpenRouter's free
models from the deployment box, one call each:

| Model                                    | Result             |
| ---------------------------------------- | ------------------ |
| `minimax/minimax-m3:free`                | 1.6 s, valid       |
| `nvidia/nemotron-3-super-120b-a12b:free` | 1.4 s, valid       |
| `cohere/north-mini-code:free`            | 1.4 s, valid       |
| `dots-studio/dots-3-note-preview:free`   | 1.7 s, valid       |
| `google/gemma-4-31b-it:free`             | 429                |
| `z-ai/glm-5.2:free`                      | 429                |
| `poolside/laguna-xs-2.1:free`            | 429                |
| `liquid/lfm-2.5-2.6b:free`               | 400, reasoning is mandatory |
| `nvidia/nemotron-3.5-lightning:free`     | burns the whole token budget thinking, returns `""` |

That last row is the trap. A reasoning model given a 300-token budget spends all
300 deliberating and returns empty content with `finish_reason: length` — which
looks exactly like a broken endpoint, and costs a request from the daily quota
to discover. The client sends `reasoning: {enabled: false}` and retries without
it on a 400, because some endpoints refuse to turn it off.

**Quota.** Read it off the response headers rather than the marketing page —
Groq returns `x-ratelimit-limit-requests: 1000` and `x-ratelimit-limit-tokens:
8000` (per minute), OpenRouter returns nothing at all. An OpenRouter key that has
never purchased credits is capped at about 50 requests a day; $10 of credit
raises that to ~1000, and the credit is not spent on `:free` models — it only
unlocks the higher cap. 50/day is roughly two day-phases of a 24-seat table, so
OpenRouter belongs *below* Groq in the chain, not above it.

**Catalogues move.** `llama-3.3-70b-versatile` was this file's Groq
recommendation and is no longer served; the default is `openai/gpt-oss-120b`
now. Check `GET /models` before assuming a model id still resolves.

**Paid models need credit.** `openai/gpt-4o` on a free-tier key answers
`402 Insufficient credits`.

## Which model, on a machine with no GPU

Measured on the mini PC this was written for — Ryzen 7 5700U, 8 cores / 16
threads, integrated graphics, no CUDA, 12 threads given to the container:

| Model                        | Reads      | Writes    | One decision |
| ---------------------------- | ---------- | --------- | ------------ |
| `qwen3.5:4b`                 | 60 tok/s   | 10 tok/s  | **~12 s**    |
| `qwen2.5:3b-instruct-q4_K_M` | 84 tok/s   | 18 tok/s  | **~11 s**    |
| `qwen3:1.7b`                 | 166 tok/s  | 29 tok/s  | **~4.5 s**   |

(One decision = a 340-token briefing in, a 60-to-130-token answer out, weights
already resident. A real live briefing runs 400–700 tokens, so add a second or
three.)

Prompt evaluation dominates, which is why the live briefing is a *conclusion*
rather than a transcript (see `bot-brief.ts`): the cheapest way to make a
CPU-only model fast is to give it less to read.

What this means for a real table: a ninety-second day phase with two requests in
flight gets roughly fifteen model-driven turns out of `qwen3.5:4b` and forty out
of `qwen3:1.7b`. Every other seat that afternoon falls to the played brain and
nobody can tell which is which without reading the log. That is the design
working, not the design failing.

Quality, on the same measurements: with the JSON schema attached, both models
return a valid decision — the right house, the right claim from the enum. The
4B writes a better *sentence*; the 1.7B writes an adequate one three times as
often. The 3B is the worst of both here — as slow as the 4B and considerably
less careful — so it is in the table for completeness rather than as an option.

The recommendation, in order:

- **Several free APIs first, local last.** `api1,api2,api3,api4,ollama` is
  better than any of them alone: four models answering in well under a second
  each, benched independently when their pool says 429, and the box under the
  desk underneath all of them. Groq goes first — 1000 requests a day against
  OpenRouter free's 50, and `gpt-oss-120b` answers in 465 ms against the local
  4B's twelve seconds.
- **`qwen3.5:4b` if the API is usually there** and the local model is a
  fallback that runs a few turns a day.
- **`qwen3:1.7b` if the local model is doing all the work.** Noticeably dumber
  per line, but it takes three times as many turns, and a square where twelve
  seats each said something ordinary reads far better than one where four said
  something clever.

Keep `OLLAMA_KEEP_ALIVE` generous. A cold load costs five seconds on this
hardware, and paying it again between phases is most of what makes a bot feel
absent.

## Tuning knobs

| Variable                | Default                    | What it does                                        |
| ----------------------- | -------------------------- | --------------------------------------------------- |
| `MAFIA_BOT_MODEL`       | `qwen3.5:4b`               | Preferred local tag. A *preference*: the driver probes `/api/tags` and takes the best small chat model actually installed if this one is not there. |
| `MAFIA_BOT_TEMPO`       | `live`                     | `deliberate` gives every bot several think-then-act rounds per phase with the whole board in front of it. A laboratory, not a playable table. |
| `MAFIA_BOT_COOLDOWN_MS` | `60000`                    | How long a rung sits out after refusing. Matched to free-tier 429s, which are per-minute contention rather than a daily wall. |
| `MAFIA_BOT_TURN_MS`     | `25000`                    | How long one turn may spend walking the chain. Refusals are cheap (a 429 lands in ~200ms, so four dead APIs cost under two seconds); it is the local model at the bottom that is slow. Past this the played brain takes the turn. |
| `OLLAMA_CPUS`           | `8`                        | Threads the container may use. The website needs some. |
| `OLLAMA_KEEP_ALIVE`     | `30m`                      | How long weights stay resident.                     |
| `OLLAMA_NUM_PARALLEL`   | `2`                        | Concurrent requests. The driver caps its own in-flight count too. |

## What each model is actually asked

Three different jobs, three different prompts, three different costs.

| | job | prompt | when |
| --- | --- | --- | --- |
| **brain** | decide the turn | none — deterministic policy | always, first |
| **mouth** | write one line | ~380 tok | when a rung is up |
| **ear** | read the humans | ~550 tok | twice a day phase, once at dusk |

The **brain** is `packages/mafia-core/src/sim/policies.ts` and calls nothing. It
reads the claims ledger, the intel and the vote history directly, so it cannot
hallucinate and cannot contradict itself, and eight hundred games of it run in
two seconds — which is how the game gets balanced at all.

The **mouth** is handed an *intention* — accuse house 11, because they swore
they never left and house 3 puts them on a doorstep — and asked for one
sentence. It never sees the board, never picks a target, never gets an opinion.
If it declines or rambles, the phrasebook line the brain already wrote is used
and the turn is identical. That is why the expensive, fallible part of the
system can only ever affect wording.

The **ear** is the one job that genuinely needs a model: turning free-form human
sentences into structured claims. One call per table per phase — a nine-day game
costs about twenty. It only ever *adds* claims, and its output is enum-typed and
validated against the living roster, which bounds the blast radius of the one
place that deliberately reads untrusted player text.

`MAFIA_BOT_MIND=model` restores the original arrangement, where the model decides
the whole turn from a full briefing (~1700 tok). Kept for comparison, and because
letting a model *plan* is worth revisiting once there is a way to tell a good
plan from a confidently invented one.

## Where each errand starts on the chain

Writing a line is the easy job and the brain has already done the hard part, so
the mouth starts one rung down when there are two or more APIs in front of the
local model — 181ms against 465ms, out of the same per-minute allowance. Taking
notes is the hard job, because a misread claim goes on the board and stays there,
so the ear always gets the front of the chain. Both still walk all the way down
to the played brain.

## Keeping it honest

`pnpm --filter back mafia:budget` renders a real briefing for each scenario and
fails if any has grown past its ceiling. The same check runs in the smoke suite,
because a prompt grows the way a prompt grows: one reasonable sentence at a time,
with nobody watching the total.

## What the model is actually asked

Not "write a message". It is handed a briefing — the roles dealt, who is hot,
what was said, what it knows privately — and asked for a small JSON object: a
line, a target, a verdict, and the *claim* its line makes. The claim is the point:
prose is flavour, and the claim is what the table remembers and can catch it out
on three days later. The engine validates everything before it happens, so a
model that hallucinates a house number or bluffs a role this table does not
contain simply does not get that move.

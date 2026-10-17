# Mafia bots: fix plan from the October games

A plan, not a description. It comes from reading the ten traces on the mini PC (`/data/traces`, 22 Sep to 15 Oct). Only `9RVWV` (15 Oct) ran the current code, commit `60e93b3`. The other nine ran older builds, so a problem they show only counts here when the current code still has it.

The goal is the one in [mafia-bots-policy-proposals.md](mafia-bots-policy-proposals.md): what a person at the table notices. The rule from [mafia-bots-llm.md](mafia-bots-llm.md) still holds: the brain decides facts, the mouth only chooses words. So every fix below changes what the brain decides or what the mouth is _told_. None of them asks the model to be smarter.

---

## What went wrong, ranked by what a player notices

| #   | Symptom                                                                                                                       | Games                                                                         | Root cause                                                                                                                                                                                                                      |
| --- | ----------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Bots answer you when you weren't talking to them                                                                              | 7 of 10; 10 lines in 9RVWV                                                    | `answering()` falls back to _any_ human line of the day (`seat.ts`, `mine.length > 0 ? mine : lines`), and the mouth is told it was said "to you or about you" (`mouth.ts`)                                                     |
| 2   | A direct question gets "what did I actually do?" instead of an answer                                                         | all; 3 to 12% of bot day lines                                                | a question to a seat wakes it, but the intent is still the wagon move (`demand`), not an answer                                                                                                                                 |
| 3   | Ex-teammates call you a liar after your role changed                                                                          | 9RVWV                                                                         | team membership is recomputed from _current_ roles (`view.ts` teammates, `isLodgeMate`); nothing remembers a former brother                                                                                                     |
| 4   | "One of you is lying" about Mason or Citizen                                                                                  | 9RVWV (5 lines)                                                               | `stolenBadge` / `copiesOf` use the dealt count, and recruits, audits and Amnesiacs create copies mid-game. The "my own badge" branch (`policies.ts`, `thief`) also never checks uniqueness                                      |
| 5   | Lodge ignores you: "no", "not him", "go for hulk" changed nothing                                                             | 9RVWV, 55USN                                                                  | the night steer only exists for `kill` (`seat.ts`, `action.type === 'kill' ? familyAsk`); the Mason Leader never reads the lodge. A bare "no" has no house to refuse (`asks.ts` `mentions`)                                     |
| 6   | Lodge told to shield a suspect, then re-knocks the same door                                                                  | most games; 28 of 71 knocks hit evil seats                                    | the recruit policy tests suspects on purpose, but the lodge line says "X joins us, do not put them on the stand"; the outcome is never reported; `refused` lives on the leader's seat and is lost when a new leader is promoted |
| 7   | Rude lines aimed at humans, even from teammates                                                                               | 5 games                                                                       | nothing in the mouth rules forbids insulting a person                                                                                                                                                                           |
| 8   | Lines that contradict the action                                                                                              | J6D7G: "Max will get the single death tonight", while the knife moved off Max | family line wording around a spared house                                                                                                                                                                                       |
| 9   | Will says "An Auditor made me the Mason Leader" (it was initiation, then promotion); a Jailor writes "alert, and I stayed in" | 9RVWV                                                                         | the will only knows `roleBefore`, not _why_ the role changed                                                                                                                                                                    |
| 10  | Human lines misread                                                                                                           | 2 to 9 per game                                                               | "why do you vote guilty on X?" filed as accuse X; "he can't be town crier" filed as a clear; "take 2 day" read as house 2; "I was mason… now citizen" filed as a present Mason claim                                            |
| 11  | Stale context                                                                                                                 | every game, mostly invisible                                                  | the mouth's "last things said" and "you already said this today" have no phase window (`bots.ts` `write`)                                                                                                                       |
| 12  | Polish                                                                                                                        | a few per game                                                                | "23. Reason: …" phrasebook line; stage directions ("leans back…", "Cell, 11: whispers…"); localized role names inside English ear prompts                                                                                       |

---

## Phase 0: measure before fixing

Every fix below has to be checkable on a real trace, not only in a unit test. Today that takes ad hoc jq.

**0.1 Trace audit.** Add `--audit` to `pnpm --filter back trace`. It counts the fault classes per game, with the line and its prompt as evidence:

- misaddressed `ANSWER THIS`: the quoted line names neither the seat (fuzzy, via `seatHits`) nor puts it on trial or top of the vote;
- counter-claims on a role with more than one possible holder;
- a former teammate accusing, counter-claiming or voting a former teammate;
- a team action on a house a human spared in that room that night;
- context lines from an earlier phase;
- `demand` share of day lines;
- insults aimed at a human (a small word list is enough).

The analysis scripts from this investigation can be ported as they are. Run it on the ten saved traces: that is the baseline.

**0.2 Bench scenario `loge`** in `sim/scenarios.ts`, for what the bench cannot see today:

- a lodge brother is audited to Citizen and claims "I was Mason, the Auditor made me Citizen";
- a Mason Leader is promoted after a refused knock.

Probes count: counter-claims on the changed seat, former brothers voting it, and re-knocks on refused doors. All three must reach 0.

**0.3 Regression tests**, one per fix, in the existing files (`heard.test.ts`, `react.test.ts`, `asks.test.ts`, `badge.test.ts`, `policies.test.ts`, `engine.test.ts`). Each case is lifted verbatim from a trace line, as the codebase already does.

---

## Phase 1: who is being spoken to (symptoms 1, 2, 11)

**1.1 Addressed vs overheard.** Rewrite `answering()` so it returns only lines that are actually _to_ this seat:

- the line names the seat. Use `seatHits` (fuzzy, which already handles "Aragon" and "Galad"), not the exact-name regex in `answering()`;
- the room has two people in it (a cell or a whisper), so everything is addressed;
- the seat is on trial and the line is unnamed and said during defense or judgement;
- or the line follows this seat's own line within a short gap, names nobody, and reads as a reply (a question mark, "you", "why").

Everything else may stay in the _context_ block, never in `ANSWER THIS`. In team rooms (lodge, family) a teammate's line counts as addressed to the room, so the wording becomes "said in your room".

**1.2 Answer the line that woke you.** `replyLater` and the react triggers know which message caused the turn. Pass its id through `decide(…, 'react', { trigger })`, so the seat answers that line, not whatever human line is newest by the time the timer fires. That is what turned "who else did you jail?" (to Jack, on the stand) into Jon Snow's "I didn't jail anyone". Wagon wake-ups carry only lines from the seats voting for it.

**1.3 A question gets an answer.** When the trigger is a question to this seat (the ear filed `question`, or the line ends in "?" and names the seat), the intent becomes _answer it_ rather than the default wagon move. The material comes only from what the brain is willing to say: its role claim if it would claim, its night account, its vote reason, or a plain "I'm not saying yet". Add a rate cap on `demand` lines: one per seat per day, a few per table per day. Today they are up to 12% of everything bots say.

**1.4 Phase window everywhere.** Factor out the `since` computation from `answering()` (`phaseStartedAt`, with the fallback) as `phaseWindow(state)`. Use it for the mouth's `recent` and `mine` in `bots.ts` `write`. "You already said this today" then really means today.

**1.5 Tone.** Add a mouth rule: argue with what a person did, never insult the person; never mock a teammate. `readLine` gets a short blocklist ("stupid", "idiot", "soggy cracker"…) and falls back to the phrasebook line when it trips.

---

## Phase 2: role changes are first-class (symptoms 3, 4, 9, part of 10)

Today the engine has one choke point, `changeRole(state, seat, to, why)` in `state.ts`. It keeps a single `roleBefore` and throws away the reason, and everything downstream guesses.

**2.1 Role history.** Add `seat.roleHistory: { night, from, to, why: RoleChange }[]`, written in `changeRole`. Keep `roleBefore` as a derived getter for compatibility. Wills use the real `why`: add the keys `mafia.bot.will.promoted` and `mafia.bot.will.remembered`, and use the audit wording only for `audited`. Also check why a Jailor's night record printed the Veteran's "alert" line.

**2.2 Former teammates.** When a seat leaves a team room (audit, conversion), every remaining member records it in `formerMates` (per seat, from `roleHistory` plus who shared the room). It shows in the view as `formerTeammates`. The brain treats a former Mason as **known town**: an audit only ever turns town into Citizen. For trust, vouching and "never counter-claim" it counts as an ally. It gets no lodge chat back. A promoted leader inherits the same set.

**2.3 Roles that can be created.** `copiesOf(info, role)` becomes ∞ when anything dealt can create that role:

| Created role                        | Created by   |
| ----------------------------------- | ------------ |
| Mason                               | Mason Leader |
| Citizen, Mafioso, Enforcer, Scumbag | Auditor      |
| Cultist, Witch Doctor               | Cult         |
| Jester                              | despair      |
| anything that died                  | Amnesiac     |

Put this as a table next to `ROLES` (`CREATES`), so the engine and the brain read the same list. Gate the `thief` branch in `decideDay` on `copiesOf(info, myRole) === 1`, like `stolenBadge`.

**2.4 Claims with a history.** The square reader and the ear learn "I was X, now Y" / "the auditor made me Y" / "I got converted to Y". This files a `role-claim` of **Y**, plus `formerRole: X` and `changedBy`. Today the past tense files X, by design, for confessions; keep that when there is no "now" or "made me". A history claim is consistent when its cause is in play: X→Citizen needs an Auditor, X→Mason needs a Mason Leader. Then it is neither suspicious nor contested. A seat that _knows_ it (a former brother) confirms it out loud instead.

---

## Phase 3: team rooms listen and tell the truth (symptoms 5, 6, 8)

**3.1 The lodge steers the knock.** Extend the night steer in `seat.ts` from `kill` to `recruit`. Read the lodge with `readRoom`:

- a human brother's named house becomes the knock, if it is legal and not a brother or former brother;
- spared houses come out of the pool.

Bots' asks go through `willHeed`, as for families. The leader says in the room what it did with the request (granted, or refused with its reason), reusing `judgeRequest`'s reasons.

**3.2 A bare veto.** In `readRoom`, a line with no house in it that is only a refusal ("no", "not him", "nope", "non", "pas lui", "don't") spares the house most recently put forward _in that room tonight_ by someone else. Only short lines, so "no idea" or "no, 7 was home" do not count. Tests: the three 9RVWV lines, plus "no go to jon snow" from 55USN, which must stay a target.

**3.3 Honest recruit lines.** Two kinds of knock, said differently:

- a _warm_ pick (a trusted seat): "I'm bringing X in tonight";
- a _test_ pick (a suspect): "I'm knocking on X tonight; if the door stays shut, X is no plain townsperson".

Never "do not put them on the stand" before the door has opened. At dawn the leader reports in the lodge whether X is in or the door stayed shut. A shut door becomes lodge evidence (suspect, or a town-power badge), not proof.

**3.4 Lodge-level memory.** Move `refused` from the leader's seat to the lodge (`state.lodge.refused`), so a promoted leader never re-knocks a shut door. Also exclude current _and former_ brothers from the knock.

**3.5 Words match the action.** A family or lodge line is built from the _final_ submitted target after the steer, and a spared house never appears as the subject of "will get the death". Add a test with the J6D7G lines.

---

## Phase 4: reading people (symptom 10)

Add each misread as a failing test first, then fix it in `square.ts`, `asks.ts` and the ear schema:

- Questions about someone else's vote or alignment ("why do you vote guilty on X?", "what are the reasons for X to be mafia?") are a `question`, never an `accuse`.
- "N day(s) / night(s)" and "take N days" are durations, not houses.
- "he can't be <role>" is a counter-claim, never a clear.
- History claims, per 2.4.

---

## Phase 5: polish (symptom 12)

- `'{who}. Reason: {why}.'` renders a number. Use the name, and give it a less robotic wording.
- `readLine` strips stage directions (`*…*`, "leans back", "Cell, 11:" prefixes).
- The ear prompt names roles in the prompt's language, not the table's.

---

## Order and size

| Step                   | Fixes           | Size   | Why this order                                                                     |
| ---------------------- | --------------- | ------ | ---------------------------------------------------------------------------------- |
| 0.1, 0.3               | measuring       | S      | every later step is judged by it                                                   |
| 1.1, 1.2, 1.4          | symptoms 1, 11  | M      | the most visible bug, confined to `seat.ts`, `bots.ts`, `mouth.ts`                 |
| 2.3 + the `thief` gate | symptom 4       | S      | one table and one condition                                                        |
| 3.2, 3.1               | symptom 5       | M      | `asks.ts` plus the steer in `seat.ts`                                              |
| 2.1, 2.2, 2.4          | symptoms 3, 9   | L      | touches the engine state (persisted tables need a default), the view and the brain |
| 3.3, 3.4, 3.5          | symptoms 6, 8   | M      |                                                                                    |
| 1.3, 1.5               | symptoms 2, 7   | M      | needs the trigger plumbing from 1.2                                                |
| 0.2                    | bench           | M      | locks in phase 2 and 3                                                             |
| 4, 5                   | symptoms 10, 12 | S each | independent, can go any time                                                       |

Each step lands as its own commit, with tests, plus `pnpm -r typecheck`, `pnpm -r test`, and the trace audit over the ten saved games. Then one live game on the mini PC and an audit of its trace.

## Decisions (17 Oct)

1. **An audit fails on a Mason or a Mason Leader.** The lodge keeps its members. This is an engine rule: it goes in `keepsItsRole`'s neighbourhood in the audit branch. The Auditor is told the audit failed and keeps its charge. With that rule, nothing in the engine takes a seat out of its team any more, so former-teammate memory (2.2) is not built; the role history it would have read is kept, and read by the wills.
2. **The knock is said for what it is, and the lodge both grows and tests.** The leader picks by need, rather than always knocking on the top suspect:
   - a _grow_ knock on a trusted seat ("I'm bringing X in tonight");
   - a _test_ knock on a suspect ("I'm testing X tonight: if the door stays shut, X is no plain townsperson").

   Grow is the default. A knock is a test only when the seat's doubt reaches 2.5 for a lodge of one or two, or 2 for a bigger one (`knockIsTest`, one rule shared by the pick and the line that announces it); otherwise the lodge knocks on the most trusted seat, the least doubted among equals. The result is reported at dawn, and refused doors pass to a promoted Master.

3. **Mild banter is fine, never aimed at a teammate, and never an insult.**
4. **A seat asked its role outside the stand answers now and then**: 15% in the square, 15 points more with at least two votes on it, 30% in a whisper. Who is asking moves it: halved for somebody voting or accusing the seat, half again for somebody who vouched for it, and up to two fifths either way by how far the seat trusts the asker. Town tells the truth; everybody else gives the mask it would claim on the stand.

---

## Status (17 Oct)

Done, with tests, in the working tree (not committed):

| Step                                                                                                                                                                      | Where                                                                                                                         |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| 0.1 trace audit, `pnpm --filter back trace -- --audit [paths] [--verbose]`                                                                                                | `cli/audit.ts`, `cli/trace.ts`                                                                                                |
| 0.3 regression tests from trace lines                                                                                                                                     | `addressed.test.ts`, `lodge.test.ts`, `square.test.ts`, `heard.test.ts`, `asks.test.ts`, `policies.test.ts`, `engine.test.ts` |
| 1.1 only lines said _to_ a seat are answered; fuzzy names; trial lines belong to their trial (`TrialState.openedAt`)                                                      | `seat.ts` `answering`, `mouth.ts`                                                                                             |
| 1.2 a seat answers the line that woke it: covered by 1.1's addressing, pinned by a test                                                                                   | `addressed.test.ts`                                                                                                           |
| 1.3 a question is answered from the seat's public record; the push-back once per new voter or new sentence, three a day per table                                         | `seat.ts`, `mouth.ts` `asksSomething`, `BotMind.pushedBack`, `BotMinds.countToday`                                            |
| 1.4 phase window on the mouth's context                                                                                                                                   | `seat.ts` `phaseWindow`, `bots.ts` `write`                                                                                    |
| 1.5 banter rule, insult and stage-direction filters                                                                                                                       | `mouth.ts`                                                                                                                    |
| team rooms are told a line was "said in your room"                                                                                                                        | `mouth.ts` `heardIn`                                                                                                          |
| 2.1 role history, read by the wills: initiated, raised to Master, audited, remembered; never "alert" for a non-Veteran                                                    | `state.ts` `roleHistory`, `seat.ts` `willStory`                                                                               |
| 2.3 badges a dealt role can hand out have no ceiling; the "my badge" contest needs a one-copy badge (no Amnesiac row: its borrowed badge is announced to the town)        | `roles.ts` `CREATES`, `policies.ts` `copiesOf`                                                                                |
| 2.4 "I was X, now Y" is a claim of Y                                                                                                                                      | `square.ts` `BECAME`                                                                                                          |
| Decision 1: an audit fails on a Mason and costs no charge                                                                                                                 | `engine.ts`, role descriptions                                                                                                |
| 3.1 the Master reads the lodge: requests, refusals, shut doors, and tells the model what it did with them; the room's power holder re-runs its night when a person speaks | `seat.ts` `steerKnock`, `teamAsk`, `knockLine`, `bots.ts` `answerPrivately`                                                   |
| 3.2 a bare "no" / "not him" refuses the last house put forward; a seat's own pick is not a request from itself                                                            | `asks.ts` `readRoom`                                                                                                          |
| 3.3 grow by default, test a strong suspect; "testing" said as a test; last night's door reported once and filed as a lodge doubt                                          | `policies.ts`, `seat.ts` `knockLine`, locales                                                                                 |
| 3.4 a promoted Master inherits the shut doors (instead of a separate lodge-level list)                                                                                    | `engine.ts` `promoteCarriers`                                                                                                 |
| 3.5 family acts use names, never bare numbers, and say which houses are being left alone; a teammate's veto beats a house already named                                   | `seat.ts`, `family.test.ts`                                                                                                   |
| 4, 5 misreads, `{who}. Reason:` wording, English roles in the ear prompt                                                                                                  | `square.ts`, `asks.ts`, `ear.ts`, locales                                                                                     |
| 0.1 audit also counts former teammates accusing, named vetoes by a person, and skips whisper and team-room replies                                                        | `cli/audit.ts`                                                                                                                |
| Bot characters (nine), role answers off the stand, whispers that reach the sash                                                                                           | `sim/characters.ts`, `seat.ts` `roleAnswer`, `whisper.test.ts`                                                                |

Not done, on purpose:

- **2.2 former-teammate memory.** See decision 1: no rule left in the engine takes a seat out of its team.
- **0.2 bench scenario.** The audit case it was for is now impossible. The bench before and after: win rates within noise, every visible fault at 0; with the cast (`--cast`, 2,700 games) town 34.8% against 34.0% without.

Next: one live game on the mini PC, then `--audit` on its trace against the baseline.

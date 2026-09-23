# How the Mafia bots play

This describes the deterministic bot brain: the player that sits in every bot seat, whether or not a language model is available. It reads the table, decides what to say, whom to accuse, how to vote and whom to visit at night, and it never calls a model. On a live table a model may reword its sentences (see [mafia-bots-llm.md](mafia-bots-llm.md)), but the decisions described here are the bot's own.

Everything below is what the code does today. Where a rule depends on a number, the number is given and comes straight from the code. Where a behaviour exists only in the headless benchmark (the simulator that runs hundreds of games with no chat) or only on a live table, that is said. Anything that could not be confirmed is marked (unverified).

Two words are used throughout in the game's own sense:

- A **claim** is anything a seat says that goes on the public record: "I am the Sheriff", "seat 7 is suspicious", "I stayed home", "I saw 4 leave", "we should vote", "why me?", "4 cannot be the Doctor", "spare me and I will prove it tonight", "I shot 7", "the Sheriff said 3 is clean".
- A **wagon** is the set of running accusations on one seat during the day. It takes a majority of the living (half plus one) to open a trial.

---

## 1. What a bot knows and remembers

### Public information every bot tracks

- The day number, who is alive, who is dead, and the role of each dead player when the table reveals it.
- Who died last night and to which weapon. The dawn report names the weapon (Mafia, Serial Killer, Veteran, and so on) even when the face was cleaned.
- The running accusations of the current day, and each past day's closing accusations.
- Every completed trial with the full ballot: who voted guilty, who voted innocent, who abstained, and whether the accused was hanged.
- The full order in which votes were placed and moved during the day. This is used to describe who opened a wagon and as a small input to the public ranking of suspects; it is not part of the suspicion score a vote is built on.
- A revealed Mayor or Marshall.
- The published role list, both as printed (with its "Random Town" style slots) and as the set of every role that list could contain, plus how many copies of each role the list allows.
- Which seats are human.
- Who is on trial.
- Every claim ever made in a room the bot can hear. Claims made in a private room (Mafia chat, a whisper, the jail cell) are tagged with their room and only bots that could read that room see them.
- Roles the record has proved on living seats: for example, a dead Sheriff's will says it visited seat 4 on the night the dawn report says the Veteran shot it, so seat 4 is the Veteran.

### Private information

- Its own role, its charges, whether it has revealed.
- Every one of its own night results: Sheriff checks, Investigator trade lines, Lookout visitor lists, Detective tails, saves, blocks, jailings, dousings, spy reports, bus swaps, controls.
- The houses its own attack bounced off (armour). This memory is never crossed off by anything anybody says.
- Whether it was healed, guarded, blocked, controlled, jailed, bussed, poisoned or doused last night, and who its Executioner target is.
- Where it actually went last night, so that it can answer "where were you?" honestly, or not.
- A Jailor's cell log: who was in the cell on which night and whether that night was quiet. The room is never told who was in the cell.
- In the headless benchmark, a Mafia, Triad or Cult seat also sees the pooled night results of every living member of its family. On a live table the knife holder is handed only its own night record; family knowledge travels through the family chat as requests (see section 7).

### What persists from one day to the next

Only a short list: the seats it has already checked, its last kill target, how cornered it feels (the desperation meter), where it went last night, its playing style if it is a Jester or a Survivor, whom it has already whispered to, and the Jailor's cell log. Everything else (trust, suspicion, whose claim is credible) is recomputed from the public record every time it decides anything.

### What it never has

- Any other player's real role. The simulator stamps each claim with whether it was truthful, for diagnostics; no bot ever reads that stamp.
- Anything said in a room it could not read.
- Any memory of a night result it did not personally receive (with the family pooling exception above).

*Where in the code:* `sim/policies.ts` (`PublicInfo`, `Claim`, `Brain`, `makeBrain`), `observe.ts` (`toPublicInfo`), `sim/simulate.ts` (`familyIntelFor`), `apps/back/src/mafia/bot-mind.ts` (`BotMinds.board`).

---

## 2. Personality

Every bot seat gets its own personality when the game starts. In the headless benchmark it is rolled from the game seed; on a live table it is derived from a hash of the bot's id, so the same bot plays the same way across a server restart.

### The five appetites (each 0 to 1)

| Appetite | Default | What it does in practice |
| --- | --- | --- |
| aggression | 0.5 | Lowers the bar to accuse: the top suspect must score above (1.7 minus aggression), shrinking as the town's clock runs down. Adds a 4 percent times aggression chance per decision of voting a hunch that scores at least 0.8. Makes a town seat ask more questions and troll slightly more. A quiet town seat is more likely to whisper its role to a revealed Mayor (0.35 plus a quarter of the shortfall in aggression). |
| herd | 0.5 | Each running vote on a seat adds 0.5 times herd to the bot's suspicion of that seat. A high herd repeats other people's accusations more often (herd times 0.35) and doubts a trial case less. |
| claim rate | 0.7 | Multiplies the chance an investigative role publishes what it found, gates a Doctor announcing a save, a Lookout reporting, a Sheriff clearing a seat under a wagon. Below 0.3 the seat says nothing on day one and below 0.25 it does not even claim a role on the stand in the benchmark. On a live table a bystander mutters during a trial only if claim rate is at least 0.45. |
| deceit | 0.4 | Scales every lying appetite: fake accusations, fake claims, the "I am the Jester" gambit, fake "somebody poisoned me" lines (8 percent times (0.5 plus deceit)). A mafioso with deceit above 0.55 is "cold" and boards a doomed brother's wagon 70 percent of the time instead of 20. A Consigliere with a finding wears a Sheriff or Investigator badge with chance 0.4 plus half its deceit. An Executioner accuses its target with probability equal to its deceit. |
| courage | 0.5 | Night nerve only. Lowers the Vigilante's shooting bar (2.2 minus 0.7 times courage), the Jailor's execution bar (2.3 minus courage), the Mafia keeper's execution bar (1.2 minus 0.4 times courage), and raises the Veteran's alert chance and lowers the Survivor's vest caution. |

Each appetite is the default plus or minus up to 0.2, clamped to 0..1.

### The three temperament coefficients (each rolled flat between 0.6 and 1.4)

- **Nerve** scales how hard a personal shock lands on the desperation meter: being on trial (0.4), the share of the hanging bar that the wagon on you has reached (times 0.35), somebody naming your real role out loud (0.25), an attack on your house last night (0.12). Nerve never scales the structural floor of the meter (your side losing). Yesterday's panic fades to 72 percent each dawn but never below the floor.
- **Suspicion** scales how far another seat's voting record moves you. A seat that hanged killers or spared them has a public trust meter; a bot with suspicion 1.4 reads that meter 40 percent larger in both directions before it is capped.
- **Haste** decides how soon an investigative role speaks. The base patience is 0.15 on days 1 and 2, 0.4 on day 3, 0.7 on day 4, then 1, multiplied by haste. The chance of publishing a finding on a given decision is claim rate times patience. A slow Sheriff (haste 0.6) on day 3 speaks with probability 0.7 times 0.24, about 17 percent per decision; a hasty one (1.4) about 39 percent.

### The four quirks (zero for every bot)

These exist so the benchmark can seat a "people-shaped" player. Bots never have them; the benchmark's human-shaped profile has stonewall 0.45, waffle 0.25, late switch 0.6, press 0.5.

- **Stonewall**: chance to ignore a question aimed at you today.
- **Waffle**: chance to volunteer a new account of last night that contradicts the one already given (home becomes visited, or the reverse).
- **Late switch**: how much less evidence it takes to move a placed vote. The normal switch margin is 0.75 points of suspicion; at late switch 0.6 it is 0.3. This only matters on a live table (see section 6).
- **Press**: chance to ask a seat again after it dodged the first question.

### Style, for two roles only

A Jester decides once, at its first decision, whether to play as a clown (odd accusations, random ballots, a big checkable claim once ignored long enough) or as scum (rides wagons on seats the room has nothing on, votes innocent on seats the room has caught, and with no wagon around starts one on the most trusted seat half the time). A Survivor decides once whether it is hurried (from day 4 rides the biggest wagon and votes guilty) or careful (votes like a cautious townsperson). Coin flip each.

### Agenda and mood

Each role has an agenda: town, family (Mafia, Triad, Cult), butcher (solo killers), jester, executioner, parasite (Witch, Scumbag, Auditor, Judge) or passenger (Survivor, Amnesiac, Lover, and anything else). Each dawn the bot reads its desperation meter and derives nine appetites for the day from agenda and mood: seek information, answer honestly, accuse without reason, wear a false role, claim to be the Jester, troll, build trust, sacrifice an ally, push the pace. Examples of what the formulas give:

- A calm town seat answers questions honestly always; at desperation 1 it answers honestly only 45 percent of the time.
- A family seat answers honestly 55 percent of the time when calm and 10 percent when fully cornered; its appetite for a false accusation is (0.2 plus 0.55 times desperation) times deceit.
- The "I am the Jester" gambit only opens for a family seat past desperation 0.6, a solo killer past 0.65, a parasite past 0.7, a passenger past 0.75.
- A family seat's appetite for feeding a brother to the room opens past desperation 0.5.
- A Jester's meter runs backwards: it climbs when nobody is looking at him, and every wagon on him counts as zero pressure.

*Where in the code:* `sim/policies.ts` (`Personality`, `Temperament`, `Quirks`, `DEFAULT_PROFILE`, `HUMAN_PROFILE`, `makePersonality`, `styleOf`, `feelPressure`, `losingClock`), `social.ts` (`agendaOf`, `advanceDesperation`, `stanceOf`), `apps/back/src/mafia/bot-mind.ts` (`seededRng`).

---

## 3. Claims and the role list

### Day one

Nobody says anything of substance and nobody votes. Claims and votes start on day two. A seat that was blackmailed today publishes nothing but still votes.

### When a bot claims its real role

1. **In danger with a notebook.** A Sheriff or Investigator with two or more votes on it, or on trial, claims its role and publishes every suspicious result it holds.
2. **A finding that matters now.** If one of its suspects already has a vote on it or is on trial, a Sheriff or Investigator claims its badge and accuses that seat with probability at least 0.75 (more if it is naturally hasty). A finding nobody is looking at is published without the badge, with probability speak chance times 0.7 (times 1.4 if it holds two or more findings), and the badge stays hidden. This was measured: badging speculative findings cost the town 2.8 points of win rate.
3. **Somebody stole its badge.** If another living seat claims the role this seat is wearing (its real role, or the mask it has already claimed), and that role is unique, then with probability 0.85 it claims the role itself (if it had not) and accuses the impostor. This fires for liars defending a mask as well as for the real holder.
4. **It can prove the claimant impossible.** A town seat that has not worn a mask checks the role list with its own badge silently added: if that makes another living seat's claim impossible (for example two Jailors, or three claimed investigators for two investigative slots), it claims its role and accuses that seat. No dice roll.
5. **A thief, denied.** A town seat whose real role somebody else claims denies that claim ("4 cannot be the Doctor") with probability 0.75. This is a denial, not a role claim.
6. **Whispering** (live table only). From day two, a town seat whispers its real role once to a living revealed Mayor or Marshall, with odds 0.35 plus a quarter of how unaggressive it is. An evil seat whispers only the mask it has already claimed in public (odds 0.5), and never invents a new one.
7. **A promise.** Under the rope (on trial, or two or more votes), a Crier, Mayor, Marshall, Sheriff, Investigator, Lookout, Detective, Veteran or Jailor promises to prove itself (with probability 0.8): the Mayor and Marshall "now", the others "tonight". Other roles bluff the same promise with probability half their false-accusation appetite. A promise that is not followed by any new finding the next day is a broken promise and counts against the seat.
8. **On the stand.** In the benchmark the accused says one thing: a town seat claims its real role, everyone else claims a random town role that nobody living has claimed and that is not in the graveyard, provided its claim rate is above 0.25. On a live table the accused gets three turns: round one the role (or mask), round two an account of a night (a real one for town, an invented one for a liar), round three its will read out verbatim.

A Mayor reveals when cornered (two votes or on trial) and otherwise from day two with chance 0.55 if a wagon it agrees with is at least 40 percent of the way to trial, plus half the town's clock pressure, plus 0.3 if its own accusations have been ignored for two days, plus 0.05 from day five. A Marshall reveals from day four when at least three accusations are on the board, with chance 0.3.

### When and how a bot fake-claims

A seat wears at most **one** false face per game. Only non-town seats do it; a town seat never claims a role it does not have (its lying appetite exists but no path uses it).

Triggers:

- A family seat, when cornered: probability 0.7 times its fake-claim appetite per decision.
- Any non-town, non-Jester seat under fire (a vote or an accusation on it) whose Jester gambit appetite is open: it consults the mask picker.
- A Jester from day three at desperation 0.5 or more: it picks a bait mask (Veteran, Jailor, Mayor or Sheriff) to be disbelieved.
- A Consigliere (or any family seat holding an exact role result on a living non-family evil) that decides to report the rival: it claims Sheriff, then Investigator if Sheriff is taken, with chance 0.4 plus half its deceit.

How the mask is picked, in order:

1. If the Jester gambit appetite is open, with probability 0.35 times that appetite: "I am the Jester" (or a quiet face if a Jester is already known).
2. The **twin**: the town role whose night looks exactly like this seat's night (Consort claims Escort, Consigliere claims Investigator, Witch Doctor claims Doctor, Mafioso claims Vigilante, Kidnapper or Interrogator claims Jailor), with probability equal to the fake-claim appetite. The point is that every true thing it did is also true of the mask.
3. A **scary** face (Veteran, Survivor, Jailor, Bodyguard) with probability 0.45 times the appetite: it buys a night.
4. A **quiet** face (Citizen, Escort, Lookout, Doctor) with probability equal to the appetite: it buys a day.

Before any of that, faces are **burned** and removed from every list: roles not in the role list, roles the graveyard leaves no slot for, roles already in the graveyard, roles a living seat already claims, and masks the graveyard has already torn off a dead seat.

Consistency: a seat wearing a badge that never leaves home (Veteran, Survivor, any role without a night action) always answers "I stayed home" when asked, whatever it really did.

### How a bot checks another player's claim against the role list

When weighing a seat that has claimed a role:

- Claimed an evil role: plus 4, hard evidence.
- The role is not in the role list at all: plus 3.
- The role is in the list but the identified graveyard has already filled every slot that could hold it (a Lover and an Enforcer between them have used up the two slots a Jester could sit in, so "I am the Jester" is impossible): plus 3.
- More living claimants than the list has copies: plus 1.5 per extra claimant, capped at two extra. For unique roles the ceiling is one whatever the list says, so two living Jailors is always a contradiction even on a chaos table.
- A pigeonhole: three seats claim investigative badges and only two slots could hold one. Each seat whose claim, removed alone, makes the rest fit is charged 1.2. Only fires when two or three seats are guilty of it.
- Somebody credible denies the badge: plus the denier's voice, capped at 1.2.
- The rival claimant was hanged and turned out evil: minus 2.5. The contest is settled in this seat's favour.

A badge nobody disputes is worth something before anybody dies, but only from the day after it was claimed: the seat's voice is heard 1.3 times louder and it counts as a "working investigator" to protectors and killers alike.

### Counter-claims between bystanders

When a unique role has two or more living claimants and this seat is not one of them, it publicly denies the badge of the claimant the room trusts least, with probability 0.4 (0.7 when three or more claim it), once per contested seat per day, and at most one such denial per decision.

### Worked example

Day 3. Seat 2 and seat 3 have both claimed Jailor. Seat 1, a Sheriff, has not been asked anything. Because Jailor is unique, seat 1 weighs each claimant at plus 1.5 (two claimants, one copy), plus the pigeonhole charge if the list has only one slot that could be a Jailor. Seat 1 also denies the badge of whichever of 2 and 3 has the worse voting record, with probability 0.4. If seat 3 is later hanged and revealed as a Consigliere, seat 2's penalty vanishes and seat 2 gains 2.5 for having won the contest.

*Where in the code:* `sim/policies.ts` (`decideDay`: the investigator block after `speakChance`, the impostor block, `worthWhispering`, the promise and counter-claim blocks, `burnedFaces`, `wornAFaceAlready`; `suspicionParts` role-claim block; `copiesOf`; `uncontestedBadge`; `defenceStrength`), `social.ts` (`MASKS`, `pickMask`), `roles.ts` (`twinMasks`, `staysHome`, `LOW_PRIORITY_MASKS`), `sim/deduce.ts` (`deductions`, `crowdedBadges`, `privateFindings`), `sim/slots.ts` (`possibleRoles`), `sim/simulate.ts` (`bluffFor`), `apps/back/src/mafia/bots.ts` (`defenceLine`, `maskOf`).

---

## 4. Suspicion and trust

### The trust meter: what your ballots say about you

Every completed trial whose accused was later revealed leaves a mark on each juror. The mark fades: full weight the next day, then down to 40 percent of itself over four days, never to zero.

| Ballot | Accused turned out | Effect on the juror |
| --- | --- | --- |
| guilty | evil | plus 0.2, plus up to 0.9 more the more divided the room was (a unanimous rope earns almost nothing; a killer cannot farm trust by voting with everyone) |
| innocent | evil | minus 1.5 times (0.25 plus 0.75 times how strong the case already was). The case strength is half "how many distinct accusers and an unexplained sighting the accused had by then, out of three" and half "how late in the game it was" |
| abstain | evil | a third of the innocent penalty |
| guilty | town | minus 0.35 |
| innocent | town | plus 0.8 |
| abstain | town | plus 0.26 |
| any | Jester, Scumbag or other neutral | nothing |

On top of that:

- **Building a rope.** The first accuser of a hanged townsperson is charged up to 2.5 when the accusation came from a claimed night's work behind a badge (a quarter of that for a bare hunch); later accusers pay a share that falls quickly. The same rope on a killer pays the same amount as a reward.
- **Being right without a trial.** Naming a killer that later died any other way earns 0.55 for the first accuser with a night's work behind it, 0.2 for anyone else who named it, and 0.2 for having been accused by that killer.
- **Hunches.** Every accusation with nothing checkable behind it costs 0.3, capped at 1.5 in total.

The meter is read through the reader's suspicion coefficient, so two bots read the same record differently.

### How loud a voice is

A living stranger who has shown nothing is discounted to 65 percent on days one to three and 80 percent afterwards. Being right raises the voice (saturating, so six good calls are not six times louder), being wrong lowers it, and clearing a seat that turned out to be a killer is the heaviest debit. A living seat with a trust meter of 2 or more speaks 1.3 times louder; at minus 2 or less, half as loud. A human player gets a small flat bonus (times 1.05, plus 0.15) so that a person is heard, but not believed more than the evidence. A dead townsperson's will is read at 1.6; a dead killer's or dead Jester's words are worth nothing; a dead other neutral's are worth 0.3. A living seat whose role the record proved as town speaks at least at 2.0; a proven evil is worth nothing. No living seat ever drops below 0.2.

### What raises suspicion of a seat

- **Contradiction, plus 3 (hard evidence).** The seat's latest answer about a night was "I stayed home" and a credible witness (voice at least 0.6) reports seeing it out. Only a sighting counts, never an accusation. A seat that later admits going out is no longer contradicted.
- **A proven liar, plus 2.5 (hard).** The seat vouched for someone the graveyard revealed as a killer, or the record proves it evil.
- **Deductions from the record, up to 3.2 in total (hard).** See section 8.
- **Other people's checked accusations.** Every credible accusation that came out of a night's work adds 0.8 times the voice to the hard evidence.
- **A bad record.** Accusing townsfolk who died town or clearing killers who died evil: up to 1.5 (hard).
- **Monomania, plus 2.** The seat closed three or more days voting the same target that nobody else ever accused.
- **Armour, plus 1.2 (hard).** This seat's own attack bounced off that house.
- **Role-claim arithmetic**, as in section 3.
- **Own night results.** A suspicious Sheriff check plus 3, an evil role result plus 4 (hard).
- **The buddy read, up to 0.3.** From the third day of votes, two seats that both voted on at least three days, agreed on at least two, and never once voted for each other are read as possible partners, measured against how much the whole table agrees with itself.
- **A proven evil role, plus 4 (hard).**
- **The chorus.** Accusations are sorted loudest first; the loudest counts at 2 times its voice, each further voice at 65 percent of the previous one. A bare hunch is worth a fifth of a voice the day it is said, a tenth the next day, nothing after. If nothing hard stands against the seat, the echo of the crowd counts at a third and the whole chorus is capped at 1.9, which is below the bar the town needs to vote on its own.
- **Corroboration.** When two different instruments point at the same house (a Sheriff check and an Escort's quiet night, say), the chorus is multiplied by up to 2.2. The same seat checking the same house three nights is one instrument, not three.
- **The wagon.** Each running vote on the seat adds 0.5 times the reader's herd. This is returned separately from the evidence so the vote can refuse to count momentum where momentum should not count.
- **Random jitter** of up to 0.3, so two bots reading the same board do not vote in lockstep.

### What lowers it

- Every credible clearing, at 2.2 times the (decaying) chorus of clears.
- A sighting the seat had already volunteered before the report came out: minus 0.5 times the witness's voice. A sighting that matches an account given after the report is worth nothing either way.
- A good trust meter: up to 1.2 of trust removes up to 0.72.
- An ally: a family member, or a revealed Mayor or Marshall read by a town seat, gets minus 5 and is never a suspect.
- A proven town role: minus 3 (hard).
- Own clear checks: minus 4. Having healed an attack on that seat: minus 2.
- The rival claimant of its role died evil: minus 2.5.

### The count of who could have done it

Separately from the score above, each dawn a bot lists who could have made last night's attack, once it crosses off itself, the victims, anyone its own Lookout list for the dead house did not name, anyone its own checks cleared, anyone it blocked or jailed that night, and any proven town role. If exactly one seat is left, that seat is believed at 0.93 and the bot votes guilty on it without further argument; if two are left, 0.55 each. A list of three or more carries no score at all (pricing it cost the town 1.7 points of win rate in the benchmark), but a list no wider than a third of the living is still said out loud. For a solo killer (Serial Killer, Mass Murderer, Arsonist, Electromaniac, Poisoner) the lists of successive nights are intersected, because the same hand held the knife each night; a family's rotating knife is never tracked this way.

### How strong before it acts

- To **accuse** on its own: the top suspect's score must reach (1.7 minus aggression) scaled down by the clock, and its evidence must reach 0.55 (less as the clock runs) and, for a town seat with nothing hard against the target, at least 2.2. Hearsay alone therefore never starts a town wagon; a contradiction, a check or a deduction does.
- To **vote guilty** on a certain read: belief odds of 0.85 or more (one seat left in the count, or its own evil role result).
- To **vote innocent** on a certain read: odds of 0.12 or less (its own clear check, or the seat was attacked), unless today's rope decides the game.
- A **Vigilante** needs two independent instruments or hard evidence of 1.5 before shooting anybody the count did not single out.

*Where in the code:* `sim/policies.ts` (`trustOf`, `mercyCost`, `stillSpeaks`, `accuserLedger`, `gravesideCredit`, `claimerWeight`, `settledCredit`, `provenLiar`, `contradicted`, `ownsUpTo`, `grounded`, `grounding`, `evidenceLines`, `corroboration`, `suspicionParts`, `buddyRead`, `monomaniacScore`, `allyCredit`), `sim/beliefs.ts` (`beliefs`, `couldHaveKilled`, `narrowing`, `acrossNights`, `surestSuspect`).

---

## 5. Day behaviour

### What a decision looks like

Each time a bot takes a turn during the day it runs the same routine: decide whether to whisper (live table), read its mood, then work through what to say, then decide whom to vote for. In the benchmark every living seat takes one speaking turn at dawn and then up to three voting rounds; on a live table each bot gets one guaranteed turn between 20 and 50 percent of the day, a second turn with probability 0.4 between 50 and 85 percent, a silent second look at its vote between 72 and 90 percent, plus extra turns when it is named, when a vote lands on it, or when it changed its own vote.

### Saying what it did last night

- **Ailments**, first. Poisoned (said with probability 0.95), silenced yesterday (0.85), jailed (0.9), guarded (0.8), healed (0.6), blocked or controlled (0.5), doused (0.45), bussed (0.4), survived an attack with no help (0.2). Once per kind.
- **A fake ailment** (non-town only, from day three, nothing real to report): if the dawn report has shown that weapon exists and a role that could cause it is still alive, the seat claims poison, douse, silence, a heal after a quiet night, or a block, with probability 8 percent times (0.5 plus deceit). It never fakes being guarded, because a Bodyguard who steps in leaves a corpse the room can check.

### Asking and answering

- **Asking.** From day two, with probability half its seek-information appetite (a town seat: between 27 and 43 percent per turn), it asks a random seat that has neither been asked nor accounted for itself. If everyone has been asked, only a "press" quirk makes it ask a dodger again.
- **Answering.** A seat asked today answers once. It answers honestly with probability equal to its honesty appetite; honest and it went somewhere and its claimed badge is one that leaves home, it says where it went; otherwise it says it stayed home. Staying home is the comfortable lie, and only a Lookout, Detective or Spy sighting can prove it false.
- **Demanding reasons.** With at least one vote on it, and with probability 0.6 plus 0.3 times its push appetite, it asks an accuser that has given no reason (no hint, sighting, relay or denial about it) to explain. An accuser that never answers has its accusation heard at half from the next day.

### Deciding whom to accuse

Talking and voting are separate. The order of what gets said:

1. Investigative findings, on the hoarding curve of section 3.
2. A Lookout whose watched house died names every visitor and puts each on that doorstep (probability claim rate). A Detective whose tail ended at the dead house does the same (at least 0.6). A Bus Driver clears the surviving half of a swap where the other half died. An Escort or Jailor, from day three, hints at the seat it held on a night nobody died. A Spy clears the seat the family aimed at and missed. A Doctor announces a save with probability claim rate plus 0.9 times its desperation.
3. **Defending.** A town seat, seeing a seat with two or more votes or on trial that is proven town, or wears an undisputed badge, or has a trust meter of 1.2 or more, clears it with probability 0.7.
4. **Piling on a liar.** Every agenda accuses a contradicted seat with probability 0.7.
5. **Urging the room.** With probability 0.3 plus 0.4 times its push appetite it says either "we have to vote" (when its best case reaches 0.5) or "let us skip today" (when it does not, or its best case is a brother). Nobody asks to skip once the town has only one mistake left.
6. **Relaying.** With probability 0.35 times herd it repeats an accusation or a clear from a voice worth at least 1.3.
7. **Needling.** With probability 0.35 times its troll appetite it taunts a random seat.
8. **Lies.** A family seat, with probability 0.4 times its false-accusation appetite, accuses the hottest non-family seat (most votes plus most accusations), or a random one a quarter of the time when nobody is hot. A Scumbag or Witch accuses the first seat with a vote on it with probability a quarter of its deceit. A family seat with a "framing" coin (heads half the days) dresses its fake accusations as a night's work of the badge it wears, so they are heard as a check rather than a hunch, as long as no brother has already used the same instrument on the same target.
9. **A brother in danger** (two votes or on trial). A family seat first rolls its sacrifice appetite: if it comes up, it accuses the brother with probability 0.6 times the appetite; if not, it clears him with probability 0.6 times its fake-claim appetite. A Mason clears a fellow Mason in danger with probability 0.55.
10. An Executioner accuses its target with probability equal to its deceit. A clown Jester accuses the least suspected seat; a scum Jester rides the biggest wagon that has nothing hard on it.

### Choosing the vote

- An Executioner votes its target while it lives.
- A Survivor at three seats left, or whenever the town is losing, votes the biggest wagon. A hurried Survivor does so from day four when a wagon is at least 30 percent to trial.
- A family seat whose known brother has reached the bar minus one vote boards that wagon (the bus) with probability 0.2, or 0.7 if it is cold (deceit above 0.55), plus 0.3 times its sacrifice appetite.
- Otherwise every candidate is scored with the suspicion of section 4 plus the wagon term. A family seat adds: minus 10 for a brother (never), plus 1.5 for a wagon a teammate is already on, plus 2.4 times how far the wagon has got from day three, plus 3 for a revealed Mayor, plus 1.2 for anyone accused once two or more corpses are signed by a solo killer (the family briefly votes with the town against a rampage). A family seat also adds a rival read: a seat it knows to be a rival killer or armoured is worth 2 to 2.5 more.
- A seat that accuses this bot without any stated reason gets plus 0.8.
- A seat acquitted today is not voted again unless today's rope decides the game.
- A town seat with a certain read (odds 0.8 or more from the count) votes it outright.
- Otherwise the top candidate is voted if it clears the bars of section 4. Failing that, with a 4 percent times aggression chance it votes a hunch scoring 0.8 or more. Failing that, if somebody is voting this bot with no stated reason, it votes back at the strongest such accuser. Otherwise nothing.

### Opening or joining a wagon

There is no separate "start a wagon" decision. A wagon is opened when the routine above lands on a seat nobody is voting yet, which for a town seat requires hard evidence (the 2.2 hearsay floor). Joining happens through the wagon term (0.5 times herd per vote) and, for the family, through the wagon bonuses above. A town seat's vote does not read who opened the wagon; that information is only used in speech ("7 started this").

### Holding, switching and skipping (live table)

On a live table the routine proposes a target and a second layer decides what to do with the vote already placed:

- Nothing proposed, nothing placed: a town seat votes to skip the day when the strongest hard case against anybody is under 0.5, the town still has two or more mistakes left, and nobody credible has asked for a vote. A family or solo-killer seat, from day three, never helps skip while a wagon on a non-ally is at least halfway to trial.
- A tie at the top: the bot breaks it toward the tied seat with suspicion of at least 1.6, never toward a brother.
- A different proposal: it moves only if the new target beats the current one by 0.75 (times 1 minus its late-switch quirk).

In the benchmark this layer is not used: votes are simply re-cast on each of the three rounds, so bench bots switch freely and the late-switch quirk has no effect there.

### When it is itself on trial

- **Benchmark.** It says exactly one thing, its role or a bluff (section 3). It cannot confess: no path produces a claim of an evil role.
- **Live table.** Three turns: badge, night account, will. A non-town seat that has said nothing all day may instead say "I was blackmailed" once (only if a silencing role could still be alive, one seat in four, deceit above 0.4) and then stay silent. After those turns it names who started the wagon on it when at least two people are riding it, or the discredited voter on the wagon. It never invents a third party to blame. Its vote and its verdict do not change because it is on trial; the deterministic routine does not even run while it stands accused, because in both settings the accused seat only gets defence turns.
- Being on trial spikes its desperation by 0.4 (times nerve), which raises its fake-claim and honesty-loss appetites the next day.

### Staying quiet

A bot says nothing when: it is day one; it was blackmailed today; it is a Sheriff sitting on a finding it is not yet hasty enough to publish; the room already has enough voices on the wagon it agrees with (live table: one to three voices per wagon per day are allowed, and a seat with no hard evidence past that cap stays silent); or its speech budget for the day is spent (live table: roughly 45 percent of the living for substantive lines and 12 percent for filler after day one).

*Where in the code:* `sim/policies.ts` (`decideDay`, `pickVote`, `steadyVote`, `wagonAlong`, `votesAgainst`, `answered`, `backedUp`, `dodgedTheQuestion`, `tradeVerdict`), `sim/simulate.ts` (day loop, `bluffFor`), `sim/tempo.ts` (`wagonOpener`), `apps/back/src/mafia/bots.ts` (`onChange` scheduling, `scripted`, `defenceLine`, `openFloor`, `reserve`, the echo cap in the day branch).

---

## 6. Voting at a trial

The verdict is decided in this order; the first rule that applies wins.

1. **The accused is a teammate.**
   - A Mason votes innocent on a fellow Mason.
   - A family seat reads the case against its brother (with the ally discount, so it is usually deeply negative). If the case is 2.2 or worse, mercy is pointless: guilty with probability 0.55 plus 0.35 times its sacrifice appetite, otherwise abstain. If the case is under 1.4 and the family is at least 18 percent of the voting room and the sacrifice roll fails, it votes innocent. Anything else: abstain (guilty with probability 0.4 times the sacrifice appetite). An abstention lowers the bar without putting a name beside mercy.
2. An Executioner votes guilty on its target.
3. **Any family seat votes guilty on any non-brother**, whatever the evidence.
4. A scum Jester votes innocent if the accused has hard evidence of 1.5 or is proven evil, guilty if the evidence is under 0.8, and flips a coin otherwise. A clown Jester votes guilty with probability 0.35 plus half its push appetite.
5. A Survivor votes guilty at three seats left, whenever the town is losing, and (if hurried) from day four with probability 0.8.
6. **Certain reads.** Belief odds of 0.85 or more: guilty. Odds of 0.12 or less: innocent, unless today's rope decides the game.
7. **At the bell** (no mistakes left): guilty, unless some other living seat's evidence beats the accused's by more than 0.3.
8. **Reasonable doubt.** If nothing hard stands against the accused, with probability (0.45 minus a quarter of the clock pressure) times (1 minus half the herd) times how thin the case is (1 minus evidence over 3), it votes innocent.
9. Evidence under 0.3 with a comfortable clock: innocent.
10. Otherwise the case is evidence plus 0.3 for having been brought to trial, minus the strength of the defence. The bar is 0.7, minus 0.45 times the pressure (the clock, or 0.6 times the bot's own push appetite, whichever is larger), minus 0.4 times (herd minus 0.5). The chance of guilty is a smooth curve around that bar. If the case is a toss-up (chance within 0.12 of a half), nothing hard stands, and the clock is comfortable, it abstains.

**What a defence is worth.** Only what the accused said today counts. An unbroken role claim: 0.4 if the role is unique, 0.08 otherwise; a claim of an evil role zeroes the whole defence. An account of the night, if not contradicted: 0.45 for "I visited 4", 0.2 for "I stayed home". Each finding read out (up to two): 0.25. A promise to prove itself tonight: 0.8. An ailment: 0.15. Being pushed by a voter whose voice is worth nothing: 0.45. A human defendant's total is multiplied by 1.2.

**The last-minute switch.** The late-switch quirk lowers the margin needed to move a placed accusation from 0.75 to 0.75 times (1 minus the quirk). On a live table the second look happens at 72 to 90 percent of the day and whenever a human line stirs the table. Bots have the quirk at zero, so in practice a bot moves its vote only for a real gain of 0.75. It does not affect the guilty or innocent verdict.

**Parity.** The clock described in section 9 changes votes in three ways: at one mistake left the town refuses to skip and stops asking for skips; at no mistakes left every town seat votes for its top suspect no matter how thin, votes guilty unless it holds a better name, and never abstains.

*Where in the code:* `sim/policies.ts` (`decideBallot`, `defenceStrength`, `steadyVote`, `SWITCH_MARGIN`, `DOOMED_BROTHER`, `SAVABLE_BROTHER`, `FAMILY_SWING`), `apps/back/src/mafia/bots.ts` (the `revote` task).

---

## 7. Night behaviour

### Rules that apply to every night action

- **A proven Veteran's porch is off every list.** If the record has proved seat 4 is the Veteran, no bot heals, kills, watches or visits 4 while any other house is legal.
- **The knife slips.** Killers walk down their ranked list: at each step they take the current name unless a roll says to slip one further. The slip chance is 0.25 for a calm killer and falls to 0.05 as its push appetite rises (a cornered killer goes straight for the biggest threat).
- **The target survived.** If a killer's target from last night is still alive, then half of the time it drops that house from tonight's list and goes around the protection, and half of the time it stubbornly tries again. It does not know or care why the kill failed.
- **Friends are spared.** A killer removes from its list the seats that have been doing its work: seats that voted innocent on a brother (2.5), cleared a brother (1.5), voted with the family on the same target (0.9 per day), keep hanging their own side (up to 3), or are a proven or claimed Jester, Executioner, Judge or Scumbag (3.2 or 2.6). A seat scoring at least 2.4 is spared, unless nobody else is left.
- **Doing nothing** is a real outcome: a Veteran that does not alert, a Vigilante below its bar, a Jailor below its bar, an Amnesiac or Auditor with nothing worth doing, or a Witch or Bus Driver with no valid second house.

### Mafia, Triad, Cult killers

The hit list, in order, deduplicated:

1. A living seat that accused one of us, if any (the Sheriff who found us).
2. A revealed Mayor.
3. Anyone the family's exact role results (Consigliere) show as Jailor, Sheriff, Doctor, Vigilante, Bodyguard, Escort or Marshall.
4. The loudest living accusers, ranked by how many accusations they have made, skipping voices worth nothing.
5. The protectors: people the family's watchers saw visiting the loud houses, who are not family.
6. Everyone the room trusts at 1.5 or more, most trusted first: tomorrow's guilty votes.

Then the knife slips down that list. If the list is empty, a random legal house.

**Coordination.** There is no plan shared between family bots. The engine carries one kill per family: the leader's order if the leader gave one, otherwise the first executor's. When an executor decides after its leader has already ordered, its legal list collapses to the leader's target and it falls in behind. When the executor orders first, the leader is not dragged along, and the engine carries the leader's order anyway. Support roles read the same order: the Janitor follows the knife; the Kidnapper, Blackmailer, Consort, Framer, Consigliere and Heartbreaker avoid the knife's house, and the knife in turn avoids the houses those roles are already working on tonight and the family's own captive. When a human teammate asks for a target in the family chat, the knife holder heeds it with probability 0.25 plus 0.2 times herd, doubled for a human asker, adjusted by the asker's track record, and never if the asker has a bad private record. Whether a bot Consigliere tells the family room its findings is (unverified).

### Serial Killer, Poisoner, Mass Murderer

Half the nights it picks among the loudest accusers (with the 0.25 slip), the other half a random house. Its friends (seats that defended it) are spared as above, and the survived-target rule applies.

**Worked example.** Night 3, the bot is Serial Killer. Seat 5 claimed Sheriff on day 2 and has accused two seats, more than anyone else. With probability one half the bot picks from the loud list, where seat 5 is first (taken with probability 0.75, seat 5 slipping to the second loudest otherwise); with probability one half it attacks a random house. Suppose it attacks seat 5 and a Doctor saves seat 5. On night 4, seat 5 is still alive, so with probability one half the bot strikes seat 5 off tonight's list and goes elsewhere, and with probability one half seat 5 stays on the list and may be attacked again. The bot does not reason that "a Doctor is on 5".

### Arsonist and Electromaniac

Ignite when two or more living houses are prepared (with probability 0.8 per night), or when one is prepared and it is day eight or later. Otherwise douse a fresh house: the loudest accusers first, then one random quiet house (so that house 1 does not get the petrol on night one just for having joined first), with slip 0.35.

### Vigilante

No shot on night one (the engine forbids it). Then, in order:

1. If the count leaves one seat that could have made last night's attack (odds 0.93), shoot it.
2. A seat tried and acquitted whose suspicion is at least 1.8 minus half the courage: shoot it.
3. Otherwise rank everybody by suspicion (minus 0.6 for a seat that had two or more votes on it yesterday, since the town is already on it). The top must reach 2.2 minus 0.7 times courage, minus 0.35 per bullet beyond what the remaining nights can use, minus 0.4 times the clock, and never below 1.2. It must also be corroborated: two independent instruments pointing at it, or hard evidence of 1.5, or the town has no mistakes left. Otherwise hold the bullet.

### Veteran

Alerts with a chance built from: hunted today (a vote or an acquittal) 0.45, accused yesterday or today 0.3, has claimed Veteran 0.35, the table is down to (charges plus 2) seats or four, whichever is larger, 0.4; plus 0.35 times courage plus a quarter of its push appetite; plus 0.15 from day three and 0.3 from day five; capped at 0.85. On days one and two the reasons count at half and the nerve is not added.

### Survivor

Wears the vest with a chance of 1.5 times the observed knives-per-night divided by seats (capped at 0.6), plus 0.3 minus 0.2 times courage, plus 0.25 if its role was outed, 0.2 if hunted, 0.45 in the endgame; capped at 0.9.

### Jailor, Kidnapper, Interrogator

**Whom to jail** is decided by day: the seat the count singles out at odds 0.7 or more; failing that, once the clock is at 0.35 or from day four, the top suspect if its suspicion is at least 0.8; failing that, a random quiet seat (no claims, trust between minus 1 and 1, not cleared by its own checks); failing that, the top suspect. The cell is never left empty when anyone is eligible.

**Whether to execute.** A Jailor executes when the prisoner's suspicion plus what the cell proved reaches 2.3 minus courage. The cell proves 1.8 if the prisoner was held on one night the killing stopped, 3.2 if on two such nights, but only 0.6 per quiet night if the board goes quiet on its own half the time when the cell is empty. A Kidnapper or Interrogator executes when the prisoner is worth it to the family: 1.2 for an undisputed badge, 1.2 for a proven town role, half the prisoner's positive trust, plus 1.6 times the clock, against a bar of 1.2 minus 0.4 times courage. On a live table the prisoner's answer in the cell also counts: a claimed badge that another living seat also wears, or that the graveyard has already filled, is executed with probability 0.9; a prisoner who said nothing is executed with probability 0.8.

**Worked example.** Day 4, the bot is Jailor with courage 0.5. It jailed seat 7 on night 2 (someone died) and seat 5 on night 3 (nobody died). Night 1 the cell was empty and someone died. Tonight it holds seat 5 again. One held night was quiet, and of the two nights seat 5 was free, none was quiet, so the cell proves 1.8. The room has nothing on seat 5, so its suspicion is about 0 to 0.3. The bar is 2.3 minus 0.5, which is 1.8. The Jailor executes seat 5 on the strength of that one quiet night. Had one of the free nights also been quiet, the cell would prove only 0.6 and it would hold.

### Doctor, Bodyguard, Witch Doctor

1. A Doctor, seeing a living seat that said it was poisoned yesterday or today, heals it with probability 0.55 (slipping 0.2 down the list of the dying).
2. Both remove any seat the count believes at 0.6 or more to be the attacker, unless that empties the list.
3. Then they stand where the knife is going, using the same public model a thoughtful townsperson could do out loud: a revealed Mayor or Marshall 3.2, a proven town role with a night power 2.4 (1.2 without), a working investigator 1.6, loudness (2 for the loudest, falling by 0.5 per rank, floor 0.4), up to 1.5 for a good trust record; minus 0.6 per distinct accuser (tomorrow's rope is free), minus up to 2 for a seat that keeps hanging its own side. The 0.25 slip applies. With nothing on the board, a random house.

The Doctor keeps no memory of last night's patient.

### Roleblockers and gags

A Consort, Liaison, Blackmailer or Silencer picks the loudest accusers (with slip), away from the knife's house. An Escort picks the most suspicious seat if its suspicion reaches 1, skipping seats its own checks cleared; otherwise the seat the room trusts least.

### Investigative roles

A Sheriff, Investigator, Detective, Consigliere, Administrator, Agent or Informant checks an unchecked seat, preferring the most suspicious, with a full point of random noise added, so early nights are close to random and later nights follow the board. A Lookout watches the revealed Mayor first, then the loudest accusers. A Coroner examines unnamed corpses first. A Spy has no target.

### Other roles

- **Framer, Forger**: rank by running votes, which are always empty at night, so in practice a random house.
- **Janitor, Incense Master**: the loudest accusers, or the knife's own target when the knife has already been ordered.
- **Witch**: returns to a puppet whose redirected visit produced a corpse (probability 0.8), else tries an untried seat, else one that was not idle; the puppet is sent to the loudest accuser (slip 0.3).
- **Bus Driver**: swaps the house the knife is most likely headed for with the most suspicious other seat if that suspicion reaches 1.2, else a random other. With an empty board the first stop can be its own house.
- **Amnesiac**: remembers a dead town role with a night power with probability 0.8; otherwise a coin flip between a random corpse and nothing.
- **Auditor**: audits the top suspect if it reaches 1.5; otherwise a random house 40 percent of the time.
- **Cultist, Mason Leader**: a random legal house not already refused.
- **Lover, Beguiler, Deceiver, Disguiser, Actress, Diva, Heartbreaker**: a random house.

*Where in the code:* `sim/policies.ts` (`decideNightTarget`, `decideSecondTarget`, `pickRanked`, `credibleClaimersRanked`, `likelyTargets`, `friendlySeats`, `unclashedTargets`, `familyKnife`, `familySpent`, `FAMILY_AIM`, `alertTonight`, `vestTonight`, `cellProves`, the keeper block of `decideDay`), `sim/beliefs.ts` (`surestSuspect`), `engine.ts` (`legalNightAction`, the family kill resolution), `apps/back/src/mafia/bots.ts` (`familyAsk`, the jail-execute block of `scripted`), `apps/back/src/mafia/bot-mind.ts` (`willHeed`).

---

## 8. Deductions

The bot only draws conclusions that are certain, never probable. Each is a fact the whole room could check, and each has a fixed weight. The total against one seat is capped at 3.2.

| Situation | Conclusion | Weight |
| --- | --- | --- |
| A seat says it visited a house whose owner was already dead that night, and no Amnesiac, Coroner, Janitor or Incense Master could be alive to have a reason | It lied about its night | 2.5 |
| A seat that has ever claimed Coroner, Janitor or Incense Master says it visited a living house | A morgue badge cannot visit the living | 2.5 |
| A seat says it was guarded on a night when nobody died | A Bodyguard who steps in leaves a corpse | 2.5 |
| A seat says it was jailed on a night and also says it visited somebody that night | Nobody acts from the cell | 2.5 |
| A seat promised to prove itself tonight and produced nothing the next day | A broken promise | 2.5 |
| A seat claims a role that is not in the role list | Impossible | 3 |
| A seat claims a role the identified graveyard leaves no slot for | Impossible | 3 |
| More living seats claim badges than the list has slots for, and this seat is one of the two or three whose removal alone would fix it | One of these is lying | 1.2 |
| A seat says it was poisoned, two days pass, it is alive and nobody healed or visited it | The poison was invented | 2 |
| A seat says something happened to it (poison, douse, silencing, jailing, guarding, healing, blocking, control, bussing) that no living role in this game could have done | Impossible ailment | 2 |
| Two seats say they were jailed on the same night, and there is one Jailor | One of them is lying | 1.2 each |
| A seat repeats a finding "the Sheriff said 3 is clean" and the Sheriff denies having said it | Relay denied | 1.5 |

Examples of what the bot does **not** deduce: "the Doctor was killed but nobody was healed" leads to no conclusion; a seat that was attacked and survived is not cleared, it is only halved in the count of section 4; a quiet Investigator line ("nothing to report") is never treated as clearing anybody.

**How deductions become action.** A deduction is hard evidence: it feeds the vote and the verdict directly, it makes any accusation of that seat count at full weight instead of decaying as a hunch, it flips a Vigilante's corroboration test, and it appears in the public ranking that the belief count starts from. In the benchmark no deduction is turned into a spoken accusation on its own; the seat is voted, not called out. On a live table the reason a bot gives when it votes reads the strongest deduction first, so a caught seat hears why. The one deduction that is always spoken is the private one: a town seat that can prove another seat's badge impossible using its own role claims its role and accuses that seat (section 3).

**Worked example.** Day 5, roster has one investigative slot and one random town slot, and seat 4 has already died as an Escort (filling the random town slot). Seats 1 and 2 both claim Sheriff. Two Sheriffs cannot fit, and removing either claim makes the rest fit, so each of 1 and 2 is charged 1.2 by every bot at the table. If seat 1 is the real Sheriff and has not yet claimed, seat 1 already knew this the day before: adding its own badge silently made seat 2's claim impossible, so seat 1 claimed Sheriff and accused seat 2 without a roll.

*Where in the code:* `sim/deduce.ts` (`deductions`, `WORTH`, `deductionWeight`, `strongest`, `crowdedBadges`, `privateFindings`, `nobodyCouldHave`), `sim/slots.ts` (`possibleRoles`, `roomForAll`), `sim/policies.ts` (`suspicionParts`, `grounded`), `sim/visits.ts` (`record-broken`), `apps/back/src/mafia/bots.ts` (`why`).

---

## 9. Endgame and desperation

### The clock, in the player's words

Each dawn every bot counts, from the published role list and the identified graveyard:

- **Knives left**: how many killers the list says were dealt, minus the identified dead ones, per camp (Mafia, Triad, Cult, solo). A camp that made a corpse in the last two nights is counted at least one whatever the graveyard says. If every knife is accounted for and nobody died last night, the clock stops and there is no hurry.
- **The bloc**: the biggest family still standing. Solo killers are never the bloc; nobody wins by standing next to the last townsperson.
- **The margin**: heads between the town and losing, whichever comes first: the bloc reaching half the room, or the room falling to two seats (at two, nobody can be hanged, so whoever holds a knife wins).
- **The nightly cost**: how many heads a wasted afternoon costs. From the third dawn it is the observed deaths per night plus one for the rope, capped between 2 and 4; before that it is the number of camps plus one.
- **Mistakes left**: how many wrong ropes fit in the margin, each costing the nightly amount. A correct rope costs nothing, because it takes a knife with it.
- **Skips left**: how many thrown-away afternoons fit, each costing one less head than a mistake. Skipping is always cheaper than hanging the wrong person.
- **Pressure**: no mistakes left 1, one left 0.6, two left 0.3, otherwise 0.

### What the town does as the clock runs

- **Pressure 0.6** (one mistake left): no town seat votes to skip, nobody asks for a skip, the Mayor's reveal chance rises by 0.3, and every town seat opens its **shortlist**: it strikes off everyone its own checks cleared, everyone credibly cleared in public (clears worth 1.5 together), and every proven town role, and votes only among what is left. A shortlist of three or fewer adds a point to each name on it and removes the evidence floor. The Survivor reads the town as losing and rides the biggest wagon.
- **Pressure 1** (today's rope decides): every town seat votes its top suspect whatever the bars say, even a seat acquitted earlier today; at the trial it votes guilty unless it holds a better name; it never abstains; doubt drops to a fifth of its calm level.
- The desperation floor of every town seat equals the pressure, so a losing town lies about its night more (honesty 1 minus 0.55 times the meter) and pushes harder.

### What the family does as it loses

A family seat's losing clock is not the parity clock: it is how thin the family is (1 minus family alive over everyone else, times 0.75) plus 0.12 per identified evil corpse (up to 0.35). A lone mafioso at six seats sits on a floor of 0.6. Past 0.5 the appetite to feed a brother to the room opens; past 0.6 the "I am the Jester" gambit opens. A rampaging solo killer (two or more corpses signed to a solo weapon) makes the family vote with the town against whoever is accused.

### Small tables

- **Six or fewer seats**: every seat adds 2 to any candidate whose proven role would beat it in a final duel (the code knows that a Witch beats anyone with a night, that a knife beats no knife, and that an armoured knife beats a bare one), and 2 to any house its own knife bounced off, if it has no armour itself.
- **Three seats**: a Survivor rides whatever wagon exists and votes guilty. For town seats the margin is at most one, so the pressure is 1 and the rules above apply.
- **Two seats**: nobody can be hanged (two votes are needed and nobody may vote for themselves), so the day does nothing and the night decides. There is no special two-player rule in the day routine.

### Desperation from the seat's side

Spikes: on trial 0.4, the wagon's share of the bar times 0.35, its real role named by somebody else 0.25, attacked last night 0.12, all times nerve. Decay: 72 percent per dawn. Floor: the losing clock above (for a Jester: how ignored it is, from day three).

**Worked example.** Day 2, six seats, seat 1 is a Mafioso with no living brother, and seats 2, 3 and 4 are voting seat 1. Floor: family alive 1 over others 5 gives thinness 0.8, times 0.75, so 0.6. Spike: the bar is 4 votes, the wagon is 3 out of 4, so 0.75 times 0.35, about 0.26. Desperation lands at about 0.86. With deceit 0.5 that gives a fake-claim appetite of about 0.33, a sacrifice appetite of 0.58 (moot, no brother) and a Jester gambit appetite of about 0.26. Next dawn, if the wagon has moved on, the meter eases to 0.86 times 0.72, but no lower than the 0.6 floor: about 0.62.

*Where in the code:* `sim/clock.ts` (`townClock`, `campsStillKilling`, `soloEndgame`), `sim/policies.ts` (`parityPressure`, `losingClock`, `feelPressure`, `tide`, `possibilitySet`, the endgame block of `pickVote`, the bell branch of `decideBallot`), `roles.ts` (`ENDGAME_SEATS`, `duelBeats`), `social.ts` (`advanceDesperation`).

---

## 10. Other things that change what a bot does

- **Masks** (section 3) and the one-face rule.
- **Agendas and stances** (section 2): every appetite in sections 3 to 7 is scaled by them.
- **The quiet trade.** An Investigator's "nothing to report" line is filed as mixed, never as a clear; it names no roles, and the bot says nothing exonerating on its strength.
- **Monomania.** A voter that closes three days on the same target nobody else ever accused earns 2 points of suspicion. An Executioner tunnelling on its target reads as one.
- **Styles** for the Jester and Survivor (section 2).
- **Whispers** (live table only). A word to a revealed Mayor or Marshall, once per listener, carrying a role only. The gesture is public, the content is private. Whispers never carry night targets. In the benchmark whispers are decided but never delivered.
- **The impostor reflex** (section 3): 0.85 for unique roles.
- **Hoarding**: the patience curve of section 2 keeps investigators quiet early.
- **Promises** (section 3) and their broken counterpart (section 8).
- **Human bonuses.** A human's voice gets a flat lift; a human defendant's defence counts 1.2 times; on a live table a human's request in the family chat is heeded twice as readily as a bot's.
- **Abstentions are priced.** Sitting out a killer's trial costs a third of what voting innocent costs; sitting out a townsperson's trial earns a third of what voting innocent earns.
- **Ailments and fake ailments** (section 5).
- **The Spy's deduction**: the family aimed at a seat and missed, so that seat is probably not family; the Spy clears it with probability half its speak chance.
- **The Escort's hint**: "I held 2 at home the night nobody died" is worth nearly nothing alone and a great deal beside a Sheriff check on 2 (corroboration multiplier, section 4).
- **The buddy read** (section 4).
- **Framing**: a family seat wearing an investigative mask dresses half its days' fake accusations as that instrument's night work.
- **Answering back**: a seat with no case of its own votes the strongest accuser that gave no reason for accusing it.
- **The bus**: a family seat boards a brother's nearly complete wagon to look town (section 5).
- **Live-table pacing** (not part of the brain, but visible at the table): bots' accusation votes are spaced 400 ms apart, a bot waits up to 3.5 seconds for its sentence before its vote lands, a bot named by a human answers about 1 to 2 seconds later, and a first skip of the afternoon is held 15 seconds in case somebody brings a clue.

---

## What the deterministic bot does not do (known gaps)

- It does not reason about **why** a kill failed. "Target still alive" is a coin flip to move on; there is no "a Doctor is on 5" memory, and no Doctor memory of last night's patient either.
- It never **confesses**: no path produces a claim of an evil role. Confessions are priced (plus 4, and the ranking's heaviest weight) only because humans and models make them.
- A **town seat never fake-claims** in the deterministic brain.
- It does not plan the night with its family in words. Coordination is "follow the leader's order" through the engine, and the family's knowledge is pooled only in the benchmark. There is no shared "kill 7 tomorrow" plan.
- The **Framer** effectively frames at random; the Bus Driver may swap its own house when the board is empty.
- **Who opened a wagon** and **who jumped off at the edge** are computed but are not part of the suspicion score; they shape sentences and add a small term (0.383 for leading a rope onto a townsperson, minus 0.45 for leading one onto a killer, zero for jumping off) to the public ranking.
- The public **ranking of suspects** and the "case for" lines never enter the suspicion score. Their only route into a vote is as the starting odds of the count in section 4, which only decides a vote once a seat reaches 0.8.
- The **solo endgame** flag ("a lone knife is all that is left") is computed and read only by the LLM briefing, not by the day routine.
- In the **benchmark**: no vote hysteresis (bots re-cast freely across three rounds, so the late-switch quirk does nothing), a one-line defence, whispers not delivered, no defence-stage reasoning at all, and the routine that would fire while a seat stands accused never runs.
- **Quirks**, **styles** and **herd** have no effect at night.
- It cannot read free text. Every human sentence reaches it as a structured claim filed by a pattern reader or by the model ear, with a confidence discount (0.65 or 0.85) that lowers its weight.
- It has no memory across games and no model of any particular opponent beyond the public record.

---

## Source map

| File | Responsibility |
| --- | --- |
| `packages/mafia-core/src/sim/policies.ts` | The brain: types (`PublicInfo`, `Claim`, `Brain`, `Personality`), trust and credibility (`trustOf`, `claimerWeight`), suspicion (`suspicionParts`), the day routine (`decideDay`, `pickVote`, `steadyVote`), the ballot (`decideBallot`, `defenceStrength`), the night (`decideNightTarget`, `decideSecondTarget`), family coordination helpers (`unclashedTargets`, `familyKnife`), thresholds |
| `packages/mafia-core/src/sim/beliefs.ts` | The count: who could have made last night's attack, per reader, with odds 0.93 / 0.55; multi-night tracking of solo killers |
| `packages/mafia-core/src/sim/deduce.ts` | Certain deductions from the record and their weights; the private badge finding |
| `packages/mafia-core/src/sim/slots.ts` | Which roles the role list can still contain given the identified graveyard; pigeonhole matching |
| `packages/mafia-core/src/sim/ranking.ts` | The public likelihood ranking of suspects (fitted weights), used for speech, briefings and the count's prior |
| `packages/mafia-core/src/sim/visits.ts` | Movement evidence from sightings and accounts, with fitted likelihood ratios |
| `packages/mafia-core/src/sim/tempo.ts` | Reading the order of votes: who opened a wagon, who led a rope onto town or onto a killer |
| `packages/mafia-core/src/sim/clock.ts` | The town clock: knives, bloc, margin, nightly cost, mistakes and skips left, pressure ladder |
| `packages/mafia-core/src/sim/simulate.ts` | The headless benchmark loop: personalities, dawn wills, one speaking pass and three voting rounds, defence, judgement, night |
| `packages/mafia-core/src/social.ts` | Agendas, the desperation meter, the nine daily appetites, the mask lists and the mask picker |
| `packages/mafia-core/src/roles.ts` | Role definitions, families, trade lines, twin masks, stay-at-home roles, duel arithmetic, the six-seat endgame constant |
| `packages/mafia-core/src/setups.ts` | Role list slot tokens and their pools |
| `packages/mafia-core/src/engine.ts` | The rules engine: legal night targets, vote and trial rules, family kill resolution |
| `packages/mafia-core/src/view.ts` | The per-seat projection a live bot is handed (its own intel only) |
| `packages/mafia-core/src/sim/*.test.ts` | Concrete scenarios used to confirm the rules above |
| `apps/back/src/mafia/bots.ts` | The live driver: when each bot takes a turn, the three-round defence, the jail interview, the speech budget, family-chat requests |
| `apps/back/src/mafia/bot-mind.ts` | Per-bot memory on a live table, personality seeding from the bot id, the claims ledger, heeding a teammate's request |

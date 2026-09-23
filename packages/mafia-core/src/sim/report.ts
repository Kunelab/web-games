/* eslint-disable no-console */
import { ROLES, roleDef, type RoleId } from '../roles.js';

/**
 * Counters for the bench's second scoreboard. See `Probe` for what goes in.
 *
 * A flat bag of named numbers rather than a typed record, because the set of
 * things worth counting grows with every question asked of the bots, and a
 * question should cost one line in the probe and one in the printer.
 */
export type Tally = Record<string, number>;

export function add(tally: Tally, key: string, by = 1): void {
  tally[key] = (tally[key] ?? 0) + by;
}

export function merge(into: Tally, from: Tally): void {
  for (const [key, value] of Object.entries(from)) add(into, key, value);
}

const get = (tally: Tally, key: string): number => tally[key] ?? 0;

const pct = (part: number, whole: number): string =>
  whole <= 0 ? '   -  ' : `${((100 * part) / whole).toFixed(1)}%`.padStart(6);

const per = (part: number, whole: number, digits = 2): string => (whole <= 0 ? '-' : (part / whole).toFixed(digits));

/** Town first, then each family, then the neutrals, which is how the role list reads. */
const ORDER = ['town', 'mafia', 'triad', 'cult', 'neutral'];

function roleLine(tally: Tally, role: RoleId): string[] {
  const r = (metric: string) => get(tally, `r:${role}:${metric}`);
  const seats = r('seats');
  const acted = r('acted');
  const aimed = acted - r('self');
  const out: string[] = [];

  if (r('swings') > 0) {
    out.push(
      `coups ${r('swings')}, mortels ${pct(r('killed'), r('swings')).trim()}` +
        ` (mal ${pct(r('victim:evil'), r('killed')).trim()}, ville ${pct(r('victim:town'), r('killed')).trim()},` +
        ` neutre ${pct(r('victim:neutral'), r('killed')).trim()})`
    );
  }
  const action = roleDef(role).nightAction;
  if (action === 'heal' || action === 'guard') out.push(`sauvetages ${r('saves')} (${per(r('saves'), seats)} par siège)`);
  if (action === 'block' || action === 'kidnap' || action === 'silence') {
    out.push(
      `sur un tueur ${pct(r('blockedKiller'), aimed).trim()}, sur un pouvoir de la ville ${pct(r('blockedTownPower'), aimed).trim()}`
    );
  }
  if (r('jailed') > 0) out.push(`emprisonne ${r('jailed')} fois (mal ${pct(r('jailedEvil'), r('jailed')).trim()})`);
  if (action === 'vest') out.push(`gilets ${r('self')}, dont utiles ${r('vestSaves')}`);
  if (action === 'alert') out.push(`alertes ${r('self')}`);
  if (action === 'douse' || action === 'charge') out.push(`prépare ${r('prepare')}, déclenche ${r('ignite')}`);
  if (r('revealed') > 0) {
    out.push(`se révèle ${pct(r('revealed'), seats).trim()} (jour ${per(r('revealDay'), r('revealed'), 1)})`);
  }
  if (r('publishedSeats') > 0) {
    out.push(`publie ${pct(r('publishedSeats'), seats).trim()} des sièges (${per(r('published'), r('publishedSeats'), 1)} rapports)`);
  }
  if (role === 'vigilante') out.push(`balles restantes ${per(r('bulletsLeft'), seats)}`);
  if (roleDef(role).faction !== 'town' && r('fakeClaim') > 0) out.push(`faux rôle ${pct(r('fakeClaim'), seats).trim()}`);
  if (r('ownClaim') > 0) out.push(`se revendique ${pct(r('ownClaim'), seats).trim()}`);
  return out;
}

/** What each role did with its seat and its power, pooled over every game in the run. */
export function printRoles(tally: Tally): void {
  const roles = (Object.keys(ROLES) as RoleId[])
    .filter((role) => get(tally, `r:${role}:seats`) > 0)
    .sort((left, right) => {
      const byFaction = ORDER.indexOf(roleDef(left).faction) - ORDER.indexOf(roleDef(right).faction);
      return byFaction !== 0 ? byFaction : get(tally, `r:${right}:seats`) - get(tally, `r:${left}:seats`);
    });

  console.log('\n=== Rôles : ce que chaque siège a fait de son pouvoir ===');
  console.log(
    'rôle             | sièges | gagne  | survit | pendu  | nuit † | nuits/s | utilisé | cible mal | hasard | ville  | résultats'
  );
  for (const role of roles) {
    const r = (metric: string) => get(tally, `r:${role}:${metric}`);
    const seats = r('seats');
    const aimed = r('acted') - r('self');
    const cells = [
      role.padEnd(16),
      String(seats).padStart(6),
      pct(r('won'), seats),
      pct(r('survived'), seats),
      pct(r('lynched'), seats),
      pct(r('nightDead'), seats),
      per(r('nights'), seats, 1).padStart(7),
      pct(r('acted'), r('nights')).padStart(7),
      pct(r('on:evil'), aimed).padStart(9),
      // What a seat choosing blindly among its legal targets would have hit.
      pct(r('chance'), r('chanceN')),
      pct(r('on:town'), aimed),
      roleLine(tally, role).join(' ; ')
    ];
    console.log(cells.join(' | '));
  }
}

/**
 * The tells, each read as a rule a watching player might apply.
 *
 * "déclenchée" is how often the rule fires; "juste" is how often the seat it
 * points at is really one of the killers; "base" is the same rate over every
 * seat in the same situation, whether or not the rule fired. The ratio is the
 * number to watch: near 1 the rule is noise, well above 1 it is an exploit.
 */
const TELLS: { code: string; label: string }[] = [
  { code: 'coupable-sur-proces-mince', label: 'vote coupable sur un procès sans preuve' },
  { code: 'epargne-un-proces-solide', label: 'vote non coupable sur un procès prouvé' },
  { code: 'vote-sans-preuve', label: 'monte sur un chariot sans preuve publique' },
  { code: 'accuse-sans-raison', label: 'accuse sans rien de vérifiable' },
  { code: 'passer-malgre-un-dossier', label: 'demande de passer alors qu un dossier existe' },
  { code: 'blanchit-un-siege-sous-un-chariot', label: 'blanchit un siège sous un chariot' },
  { code: 'accuse-par-la-victime', label: 'avait été accusé par la victime de la nuit' },
  { code: 'avoue-une-visite-chez-le-mort', label: 'dit avoir visité la maison du mort' }
];

/**
 * Read as a likelihood ratio: how much likelier the rule is to fire on a killer
 * than on anybody else in the same situation. 1 is no information; 2 means a
 * watcher who sees it fire should double the odds on that seat. "juste" is the
 * same fact from the watcher's side, how often the seat it fired on was a killer.
 */
export function printTells(tally: Tally): void {
  console.log('\n=== Signaux lisibles par un joueur (la règle désigne-t-elle un tueur ?) ===');
  console.log(
    'règle                                               | situations | chez les tueurs | chez les autres | rapport | juste'
  );
  for (const { code, label } of TELLS) {
    const pool = get(tally, `tell:${code}:pool`);
    if (pool === 0) continue;
    const fires = get(tally, `tell:${code}:fires`);
    const evilFires = get(tally, `tell:${code}:evil`);
    const evilPool = get(tally, `tell:${code}:poolEvil`);
    const onEvil = evilPool > 0 ? evilFires / evilPool : 0;
    const onOthers = pool - evilPool > 0 ? (fires - evilFires) / (pool - evilPool) : 0;
    const ratio = onOthers > 0 ? `${(onEvil / onOthers).toFixed(2)}x` : onEvil > 0 ? '  inf' : '    -';
    console.log(
      [
        label.padEnd(51),
        String(pool).padStart(10),
        pct(evilFires, evilPool).padStart(15),
        pct(fires - evilFires, pool - evilPool).padStart(15),
        ratio.padStart(7),
        fires > 0 ? pct(evilFires, fires) : '   -  '
      ].join(' | ')
    );
  }
}

const FAULTS: { code: string; label: string }[] = [
  { code: 'un-mal-nomme-la-maison-du-mort', label: 'un tueur nomme la maison de sa victime' },
  { code: 'recit-contraire-a-son-masque', label: 'récit de nuit contraire au rôle revendiqué' },
  { code: 'conteste-le-badge-d-un-frere', label: 'conteste le badge d un coéquipier' },
  { code: 'accuse-un-frere-hors-danger', label: 'accuse un coéquipier qui n est pas en danger' },
  { code: 'blanchit-un-frere-ensuite-pendu', label: 'blanchit un frère pendu dans la journée' },
  { code: 'plus-de-rapports-que-de-nuits', label: 'deux maisons pour une nuit (menteur)' },
  { code: 'plus-de-rapports-ville', label: 'deux maisons pour une nuit (ville)' }
];

export function printFaults(tally: Tally): void {
  const games = get(tally, 'games');
  console.log(`\n=== Fautes visibles (pour 100 parties, sur ${games}) ===`);
  for (const { code, label } of FAULTS) {
    const count = get(tally, `fault:${code}`);
    console.log(`  ${label.padEnd(46)} ${((100 * count) / Math.max(1, games)).toFixed(1).padStart(7)}`);
  }

  console.log('\n=== Cohérence et coordination ===');
  const urge = get(tally, 'urge:vote');
  console.log(`  "il faut voter" suivi d un vote pour passer       ${pct(get(tally, 'urge:voteThenSkip'), urge)} de ${urge}`);
  const cold = get(tally, 'cold:accusations');
  console.log(
    `  accusation inventée sur tableau froid, 1er siège    ${pct(get(tally, 'cold:firstSeat'), cold)} de ${cold}` +
      ` (hasard: ${pct(get(tally, 'cold:expected'), cold).trim()})`
  );
  const bus = get(tally, 'bus:votes');
  console.log(`  votes d un frère sur un frère, dont décisifs        ${pct(get(tally, 'bus:hammer'), bus)} de ${bus}`);
  const covers = get(tally, 'cover:clears');
  console.log(`  frères blanchis en public                           ${covers}`);
  const scanned = get(tally, 'scan:visited');
  console.log(`  "j ai visité X" venant d un rôle à pouvoir          ${pct(get(tally, 'scan:visitedHasPower'), scanned)} de ${scanned}`);
  console.log(
    `  tué par une famille la nuit suivante: a répondu "visité" ${pct(get(tally, 'scan:answeredKnifed'), get(tally, 'scan:answeredTown'))}` +
      ` contre ${pct(get(tally, 'scan:quietKnifed'), get(tally, 'scan:quietTown')).trim()} pour les autres`
  );
  console.log(
    `  procès d un tueur, pendu                            ${pct(get(tally, 'trials:evilHanged'), get(tally, 'trials:evil'))}` +
      ` de ${get(tally, 'trials:evil')} (autres: ${pct(get(tally, 'trials:otherHanged'), get(tally, 'trials:other')).trim()} de ${get(tally, 'trials:other')})`
  );
  const onAcq = get(tally, 'vig:onAcquitted');
  console.log(`  tirs du Justicier sur un acquitté du jour           ${onAcq} (mal ${pct(get(tally, 'vig:onAcquittedEvil'), onAcq).trim()})`);
  const evilPromises = get(tally, 'promise:evil');
  console.log(
    `  promesses d un tueur jugées tenues le lendemain      ${pct(get(tally, 'promise:evilKept'), get(tally, 'promise:evilSettled'))}` +
      ` de ${get(tally, 'promise:evilSettled')} réglées (${evilPromises} faites, ville ${get(tally, 'promise:town')})`
  );
}

/** Forced scenarios: see `Scenarios`. Each prints its own block. */
export function printScenarios(tally: Tally): void {
  const s = (key: string) => get(tally, `scen:${key}`);
  if (!Object.keys(tally).some((key) => key.startsWith('scen:'))) return;
  console.log('\n=== Scénarios forcés ===');

  if (s('famille:demandes') > 0) {
    console.log(
      `  famille: ${s('famille:demandes')} demandes d un coéquipier, accordées ${pct(s('famille:accordees'), s('famille:demandes')).trim()}` +
        ` ; refus expliqués ${pct(s('famille:refusExpliques'), s('famille:demandes') - s('famille:accordees')).trim()}` +
        ` ; la demande visait un pouvoir de la ville ${pct(s('famille:demandeSurPouvoirVille'), s('famille:demandes')).trim()},` +
        ` le choix propre ${pct(s('famille:choixPropreSurPouvoirVille'), s('famille:demandes')).trim()}`
    );
    const reasons = Object.keys(tally)
      .filter((key) => key.startsWith('scen:famille:refus:'))
      .map((key) => `${key.slice('scen:famille:refus:'.length)} ${get(tally, key)}`);
    if (reasons.length > 0) console.log(`           motifs de refus: ${reasons.join(', ')}`);
  }

  for (const kind of ['unique', 'partage']) {
    const made = s(`peche:${kind}:faits`);
    if (made === 0) continue;
    const surfaced = s(`peche:${kind}:titulaireSeMontre`);
    console.log(
      `  pêche (${kind === 'unique' ? 'rôle unique' : 'rôle partagé'}): ${made} faux badges, le vrai titulaire se montre ${pct(surfaced, made).trim()},` +
        ` tué la nuit même ${pct(s(`peche:${kind}:titulaireTue`), made).trim()}` +
        ` (${pct(s(`peche:${kind}:tueApresSEtreMontre`), surfaced).trim()} de ceux qui se sont montrés)`
    );
  }

  if (s('barre:proces') > 0) {
    console.log(
      `  barre: ${s('barre:proces')} tueurs au procès portant le rôle d un juré, pendus ${pct(s('barre:pendus'), s('barre:proces')).trim()} ;` +
        ` le vrai titulaire vote coupable ${s('barre:titulaire:guilty')}, innocent ${s('barre:titulaire:innocent')}, s abstient ${s('barre:titulaire:abstain')}`
    );
  }

  for (const side of ['surTueur', 'surVille']) {
    const calls = s(`meneur:${side}:appels`);
    if (calls === 0) continue;
    console.log(
      `  meneur (${side === 'surTueur' ? 'désigne un tueur' : 'désigne un villageois'}): ${calls} appels, la ville suit` +
        ` ${pct(s(`meneur:${side}:suivis`), s(`meneur:${side}:villeVotante`)).trim()} des voix`
    );
  }
  if (s('meneur:controle:villeVotante') > 0) {
    console.log(
      `  meneur (témoin: un siège tiré au hasard, que personne n a nommé): la ville y vote` +
        ` ${pct(s('meneur:controle:suivis'), s('meneur:controle:villeVotante')).trim()} des voix`
    );
  }

  if (s('muet:lignesTues') > 0) {
    console.log(`  muet: ${s('muet:lignesTues')} lignes de joueurs jamais dites ; voir la table humains et bots`);
  }
  if (s('mal-lu:lignes') > 0) {
    console.log(
      `  mal-lu: ${s('mal-lu:lignes')} lignes de joueurs lues avec doute, dont retournées ${pct(s('mal-lu:retournees'), s('mal-lu:lignes')).trim()} ; voir la table humains et bots`
    );
  }

  if (s('promesse:proces') > 0) {
    console.log(
      `  promesse: ${s('promesse:proces')} tueurs promettent au procès, pendus ${pct(s('promesse:pendus'), s('promesse:proces')).trim()} ;` +
        ` ${s('promesse:survivants')} parlent le lendemain, promesse jugée rompue ${pct(s('promesse:jugeesRompues'), s('promesse:survivants')).trim()}`
    );
  }
}

/** How the booth split, on thin cases and on proven ones. */
export function printJury(tally: Tally): void {
  console.log('\n=== Jurys : comment la salle se partage ===');
  console.log('procès          | n      | acquitté | partagé | écrasant (90%+) | unanime | villageois pendus');
  for (const scope of ['mince', 'solide']) {
    const j = (key: string) => get(tally, `jury:${scope}:${key}`);
    const n = j('trials');
    if (n === 0) continue;
    console.log(
      [
        (scope === 'mince' ? 'sans preuve' : 'avec preuve').padEnd(15),
        String(n).padStart(6),
        pct(j('acquitte'), n).padStart(8),
        pct(j('partage'), n).padStart(7),
        pct(j('ecrasant'), n).padStart(15),
        pct(j('unanime'), n).padStart(7),
        pct(j('townHanged'), n).padStart(17)
      ].join(' | ')
    );
  }
}

/** A person and a bot in the same camp, side by side. Printed only when a run seated people. */
export function printParity(tally: Tally): void {
  if (get(tally, 'par:humain:town:seats') + get(tally, 'par:humain:evil:seats') === 0) return;
  console.log('\n=== Humains et bots, même camp ===');
  console.log('camp    | qui    | sièges | tué la nuit | pendu  | mort avant J4 | votes reçus / jour');
  for (const side of ['town', 'evil', 'neutral']) {
    for (const who of ['humain', 'bot']) {
      const p = (key: string) => get(tally, `par:${who}:${side}:${key}`);
      const seats = p('seats');
      if (seats === 0) continue;
      console.log(
        [
          side.padEnd(7),
          who.padEnd(6),
          String(seats).padStart(6),
          pct(p('nightDead'), seats).padStart(11),
          pct(p('lynched'), seats),
          pct(p('early'), seats).padStart(13),
          per(p('votes'), p('days')).padStart(18)
        ].join(' | ')
      );
    }
  }
}

/** From a killer found at night to a killer hanged. */
export function printInformation(tally: Tally): void {
  const found = get(tally, 'info:found');
  if (found === 0) return;
  const said = get(tally, 'info:said');
  const after = get(tally, 'info:hangedAfterSaid');
  console.log('\n=== De la découverte à la corde ===');
  console.log(`  tueurs découverts la nuit par la ville (vérification, porte d un mort)  ${found}`);
  console.log(
    `  dits en public                   ${pct(said, found)} (après ${per(get(tally, 'info:sayDelay'), said, 1)} jours en moyenne)`
  );
  console.log(`  pendus un jour ou l autre        ${pct(get(tally, 'info:hanged'), found)}`);
  console.log(
    `  pendus après avoir été dits      ${pct(after, said)} des dits (${per(get(tally, 'info:hangDelay'), after, 1)} jours après)`
  );
  console.log(`  encore vivants à la fin          ${pct(get(tally, 'info:aliveAtEnd'), found)}`);
}

/** Whether a trait shows: each split at its middle, bots only. */
export function printPersonality(tally: Tally): void {
  const t = (key: string) => get(tally, `pers:${key}`);
  if (t('aggr:bas:days') + t('aggr:haut:days') === 0) return;
  console.log('\n=== Personnalités : le trait se voit-il ? (bas | haut) ===');
  console.log(
    `  agressivité (ville): accusations par jour   ${per(t('aggr:bas:acc'), t('aggr:bas:days'))} | ${per(t('aggr:haut:acc'), t('aggr:haut:days'))}` +
      ` ; votes par jour ${per(t('aggr:bas:votes'), t('aggr:bas:days'))} | ${per(t('aggr:haut:votes'), t('aggr:haut:days'))}`
  );
  console.log(
    `  suivisme (ville): coupable sur procès mince  ${pct(t('herd:bas:thinGuilty'), t('herd:bas:thin')).trim()} | ${pct(t('herd:haut:thinGuilty'), t('herd:haut:thin')).trim()}`
  );
  console.log(
    `  hâte (enquêteurs): publie                   ${pct(t('haste:bas:published'), t('haste:bas:seats')).trim()} | ${pct(t('haste:haut:published'), t('haste:haut:seats')).trim()}` +
      ` ; premier rapport jour ${per(t('haste:bas:firstDay'), t('haste:bas:published'), 1)} | ${per(t('haste:haut:firstDay'), t('haste:haut:published'), 1)}`
  );
  console.log(
    `  duplicité (tueurs): faux rôle               ${pct(t('deceit:bas:faked'), t('deceit:bas:seats')).trim()} | ${pct(t('deceit:haut:faked'), t('deceit:haut:seats')).trim()}`
  );
}

export function printReport(tally: Tally): void {
  printRoles(tally);
  printTells(tally);
  printFaults(tally);
  printJury(tally);
  printParity(tally);
  printInformation(tally);
  printPersonality(tally);
  printScenarios(tally);
}

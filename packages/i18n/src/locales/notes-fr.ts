import type { Catalogue } from '../index.js';

/**
 * Le fil privé, en français : ce que la nuit vous a dit, à vous et à personne
 * d’autre. Les originaux — ces phrases vivaient en clair dans l’état persisté
 * avant de devenir des clés.
 *
 * Le bloc `mafia.trade.*` est la grille de réponse du Détective privé : deux
 * rôles du même métier doivent se lire *à l’identique*, jamais « presque » — le
 * flou est l’information.
 */
export const notesFr: Catalogue = {
  /* ------------------------------ ce que vous êtes -------------------------- */
  'mafia.note.roleDealt': 'Vous êtes {role}. {description}',
  'mafia.note.obsession': 'Votre obsession : faire pendre {name} (maison {slot}).',
  'mafia.note.jailedNight': 'On vous a traîné en cellule pour la nuit. Le Geôlier vous écoute.',
  'mafia.note.jesterWon': 'Ils vous ont pendu. Vous avez gagné.',
  'mafia.note.execWon': 'Votre obsession se balance. Vous avez gagné.',
  'mafia.note.griefMad': 'Votre obsession est morte sans corde. Le deuil vous rend fou : vous êtes désormais le Bouffon.',
  'mafia.note.remembered': 'Tout vous revient : vous êtes {role}.',
  'mafia.note.audited': 'Un contrôle implacable : vos papiers, vos outils, votre vie d’avant — saisis. Vous êtes {role}.',

  /* -------------------------- ce que vous avez fait ------------------------- */
  'mafia.note.onAlert': 'Vous passez la nuit en alerte, fusil sur les genoux.',
  'mafia.note.vestOn': 'Gilet enfilé pour la nuit.',
  'mafia.note.controlDone': 'Vous avez envoûté {name} et détourné son geste vers {other}.',
  'mafia.note.controlIdle': '{name} n’avait aucun geste à détourner cette nuit.',
  'mafia.note.busDone': 'Vous avez échangé {first} et {second}. Vous seul savez qui dormait où.',
  'mafia.note.silenceDone': '{name} se taira demain.',
  'mafia.note.douseDone': 'La maison de {name} est imbibée.',
  'mafia.note.chargeDone': 'La maison de {name} est câblée.',
  'mafia.note.poisonDone': '{name} est empoisonné : il s’éteindra demain, sauf médecin.',
  'mafia.note.disguised': 'Cette nuit, les curieux vous prendront pour {role}.',
  'mafia.note.hiding': 'Vous passez la nuit caché chez {name}. Ce qui vous visait le trouvera.',
  'mafia.note.charmDone': '{name} vous appartient : si vous tombez, ce cœur s’arrête aussi.',
  'mafia.note.bondDone': 'Votre cœur a choisi {name}. Vivez ensemble, ou mourez ensemble.',
  'mafia.note.cleaned': 'Le cadavre de {name} est méconnaissable. C’était {role}.',
  'mafia.note.initiateDone': '{name} a rejoint la loge.',
  'mafia.note.initiateRefused': '{name} a décliné l’initiation.',
  'mafia.note.convertDone': '{name} a rejoint la Secte.',
  'mafia.note.convertRefused': '{name} a résisté à l’appel.',
  'mafia.note.auditDone': '{name} a été réduit à néant administratif.',
  'mafia.note.auditFailed': '{name} est inattaquable sur le papier.',
  'mafia.note.executedInnocent': 'Vous avez exécuté un innocent. Vos mains tremblent : plus aucune exécution.',

  /* ------------------------ ce qu’on vous a fait, à vous -------------------- */
  'mafia.note.controlled': 'Une volonté étrangère a guidé vos pas cette nuit.',
  'mafia.note.bussed': 'Un bus vous a déposé ailleurs cette nuit.',
  'mafia.note.kidnapped': 'Un sac sur la tête, une cave inconnue : on vous a enlevé pour la nuit.',
  'mafia.note.blocked': 'Quelqu’un vous a retenu toute la nuit. Votre action est tombée à l’eau.',
  'mafia.note.silenced': 'Une lettre sous votre porte : « Un mot demain et tout le monde saura. » Vous voilà muet.',
  'mafia.note.doused': 'Une odeur d’essence imprègne vos murs…',
  'mafia.note.poisoned': 'Un goût amer au fond de la gorge. Vous vous sentez fiévreux…',
  'mafia.note.charmed': 'Un parfum entêtant vous colle à la peau. Votre cœur ne bat plus tout à fait pour vous.',
  'mafia.note.bonded': 'Quelqu’un vous aime à la folie : {name}. Vivez ensemble, ou mourez ensemble.',
  'mafia.note.initiated': 'On vous a initié à la loge. Vos frères vous connaissent désormais.',
  'mafia.note.converted': 'Des voix dans la nuit… et soudain tout est clair. Vous appartenez à la Secte.',

  /* -------------------------------- la violence ----------------------------- */
  'mafia.note.targetMissing': 'Votre cible était introuvable cette nuit.',
  'mafia.note.attackFailed': 'Votre cible a survécu à votre attaque.',
  'mafia.note.survived': 'On vous a attaqué cette nuit, mais vous avez tenu bon.',
  'mafia.note.guarded': 'Quelqu’un est mort pour vous cette nuit.',
  'mafia.note.bodyguardRepelled': 'Un garde du corps vous a repoussé.',
  'mafia.note.purged': 'La fièvre tombe : on vous a purgé le sang à temps.',
  'mafia.note.healed': 'On vous a laissé pour mort, mais des mains expertes vous ont recousu.',
  'mafia.note.healSaved': 'Votre patient a été attaqué cette nuit. Vous l’avez sauvé.',

  /* ------------------------------ ce que vous avez vu ----------------------- */
  'mafia.note.familyAimed': 'La {family} a visé la maison {slot} cette nuit.',
  'mafia.note.sheriffSuspect': '{name} est SUSPECT.',
  'mafia.note.sheriffClear': '{name} n’a rien de suspect.',
  'mafia.note.exactRole': '{name} est {role}.',
  'mafia.note.tradeLine': '{name} {line}.',
  'mafia.note.visitorsSeen': 'Chez {name} cette nuit : {names}.',
  'mafia.note.visitorsNone': 'Personne n’a rendu visite à {name} cette nuit.',
  'mafia.note.trackedTo': '{name} est sorti cette nuit : vu chez {names}.',
  'mafia.note.trackedHome': '{name} n’a pas quitté sa maison cette nuit.',
  'mafia.note.autopsy': 'Sous votre scalpel, {name} livre son secret : c’était {role}.',

  /* ----------------------------- pourquoi on gagne -------------------------- */
  'mafia.win.reason.town': 'Victoire de la Ville',
  'mafia.win.reason.mafia': 'Victoire de la Mafia',
  'mafia.win.reason.triad': 'Victoire de la Triade',
  'mafia.win.reason.cult': 'Victoire de la Secte',
  'mafia.win.reason.jester': 'Bouffon pendu : il gagne seul',
  'mafia.win.reason.executioner': 'Obsession pendue : le Bourreau gagne',
  'mafia.win.reason.survivor': 'A survécu jusqu’au bout',
  'mafia.win.reason.parasite': 'A prospéré dans le malheur',
  'mafia.win.reason.lovers': 'L’amour a survécu à la ville',
  'mafia.win.reason.serial-killer': 'Dernier tueur debout',
  'mafia.win.reason.arsonist': 'Dernière flamme debout',
  'mafia.win.reason.mass-murderer': 'Dernier massacre debout',
  'mafia.win.reason.poisoner': 'Dernière fiole debout',
  'mafia.win.reason.electromaniac': 'Dernier courant debout',

  /* ---------------------- la grille du détective privé ---------------------- */
  'mafia.trade.quiet': 'ne semble pas cacher grand-chose',
  'mafia.trade.snoop': 'fouine dans la vie des autres',
  'mafia.trade.watcher': 'observe les allées et venues',
  'mafia.trade.healer': 'a des mains soignées',
  'mafia.trade.rough': 'a des mains calleuses',
  'mafia.trade.night': 'travaille la nuit',
  'mafia.trade.powder': 'sent la poudre',
  'mafia.trade.keys': 'porte un trousseau de clés',
  'mafia.trade.hands': 'serre beaucoup de mains',
  'mafia.trade.ink': 'a les doigts tachés d’encre',
  'mafia.trade.laugh': 'rit tout seul',
  'mafia.trade.blade': 'affûte quelque chose',
  'mafia.trade.gas': 'sent l’essence',
  'mafia.trade.herbs': 'a des herbes étranges',
  'mafia.trade.wheel': 'a les mains sur un volant',
  'mafia.trade.chalk': 'a de la craie sur les manches',
  'mafia.trade.paint': 'sent le maquillage',
  'mafia.trade.wires': 'a des fils de cuivre plein les poches',
  'mafia.trade.bottle': 'transporte de petites fioles',
  'mafia.trade.rope': 'a de la corde neuve',
  'mafia.trade.charm': 'a un parfum entêtant',
  'mafia.trade.dirt': 'a de la terre sous les ongles'
};

export default notesFr;

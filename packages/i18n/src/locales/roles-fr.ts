import type { Catalogue } from '../index.js';

/**
 * Le casting, en français : les camps, les soixante-trois rôles, le verbe que
 * chaque pouvoir nocturne pose sur un bouton, et les catégories qu’affiche la
 * liste des rôles.
 *
 * Ce sont les originaux — le jeu a été écrit dans cette langue — recopiés depuis
 * `mafia-core/roles.ts`, qui garde sa table française pour les deux lecteurs qui
 * ne sont pas des gens : les prompts des bots et la transcription du simulateur.
 */
export const rolesFr: Catalogue = {
  /* -------------------------------- les camps ------------------------------- */
  'mafia.faction.town': 'Ville',
  'mafia.faction.mafia': 'Mafia',
  'mafia.faction.triad': 'Triade',
  'mafia.faction.cult': 'Secte',
  'mafia.faction.neutral': 'Neutre',

  /* --------------------------------- la Ville ------------------------------- */
  'mafia.role.citizen.name': 'Citoyen',
  'mafia.role.citizen.desc': 'Aucun pouvoir, une voix. Votre arme est le débat.',
  'mafia.role.sheriff.name': 'Shérif',
  'mafia.role.sheriff.desc': 'Chaque nuit, sonde un joueur : suspect ou non.',
  'mafia.role.investigator.name': 'Détective privé',
  'mafia.role.investigator.desc': 'Chaque nuit, examine un joueur et découvre son métier probable.',
  'mafia.role.detective.name': 'Limier',
  'mafia.role.detective.desc': 'Chaque nuit, file un joueur et découvre chez qui il est allé.',
  'mafia.role.lookout.name': 'Guetteur',
  'mafia.role.lookout.desc': 'Chaque nuit, surveille une maison et voit qui la visite.',
  'mafia.role.spy.name': 'Espion',
  'mafia.role.spy.desc':
    'Écoute les conciliabules des familles la nuit — sans jamais voir les visages — et apprend qui elles ont visé.',
  'mafia.role.coroner.name': 'Légiste',
  'mafia.role.coroner.desc': 'Chaque nuit, autopsie un cadavre et découvre son vrai rôle, maquillé ou non.',
  'mafia.role.doctor.name': 'Médecin',
  'mafia.role.doctor.desc': 'Chaque nuit, soigne un joueur et le sauve d’une attaque.',
  'mafia.role.bodyguard.name': 'Garde du corps',
  'mafia.role.bodyguard.desc': 'Protège un joueur ; si on l’attaque, vous tombez avec l’agresseur.',
  'mafia.role.escort.name': 'Hôtesse',
  'mafia.role.escort.desc': 'Chaque nuit, retient un joueur chez lui : son action est annulée.',
  'mafia.role.bus-driver.name': 'Chauffeur de bus',
  'mafia.role.bus-driver.desc': 'Chaque nuit, échange deux maisons : tout ce qui visait l’une arrive chez l’autre.',
  'mafia.role.vigilante.name': 'Justicier',
  'mafia.role.vigilante.desc': 'Trois balles pour rendre justice vous-même. Visez juste.',
  'mafia.role.veteran.name': 'Vétéran',
  'mafia.role.veteran.desc': 'En alerte, abat quiconque lui rend visite cette nuit-là.',
  'mafia.role.jailor.name': 'Geôlier',
  'mafia.role.jailor.desc': 'Le jour, choisit un prisonnier ; la nuit, l’interroge en cellule et peut l’exécuter.',
  'mafia.role.mayor.name': 'Maire',
  'mafia.role.mayor.desc': 'Peut se révéler en plein jour : son vote compte alors triple.',
  'mafia.role.marshall.name': 'Prévôt',
  'mafia.role.marshall.desc':
    'Peut se révéler en plein jour : ce jour-là, la ville juge sans défense et pend à la chaîne.',
  'mafia.role.crier.name': 'Crieur public',
  'mafia.role.crier.desc': 'Sa voix porte même la nuit — anonyme, sur la place du village.',
  'mafia.role.mason.name': 'Franc-maçon',
  'mafia.role.mason.desc': 'Membre de la loge : les frères se connaissent et se parlent la nuit.',
  'mafia.role.mason-leader.name': 'Maître de loge',
  'mafia.role.mason-leader.desc': 'Chaque nuit, peut initier un citoyen à la loge.',
  'mafia.role.stump.name': 'Souche',
  'mafia.role.stump.desc': 'Un arbre a des racines et un avis. Ne parle pas, ne meurt pas la nuit, vote.',

  /* -------------------------------- la Mafia -------------------------------- */
  'mafia.role.godfather.name': 'Parrain',
  'mafia.role.godfather.desc': 'Ordonne le meurtre de la nuit. Insoupçonnable, intouchable chez lui.',
  'mafia.role.mafioso.name': 'Mafioso',
  'mafia.role.mafioso.desc': 'Le bras armé de la famille : exécute l’ordre du Parrain.',
  'mafia.role.caporegime.name': 'Caporegime',
  'mafia.role.caporegime.desc':
    'Lieutenant de la famille. Quand le Parrain tombe, il apprend à sourire comme lui.',
  'mafia.role.soldato.name': 'Soldato',
  'mafia.role.soldato.desc': 'Un soldat de plus dans la famille. Les ordres sont les ordres.',
  'mafia.role.consigliere.name': 'Consigliere',
  'mafia.role.consigliere.desc': 'Chaque nuit, découvre le rôle exact d’un joueur.',
  'mafia.role.consort.name': 'Escorte de la famille',
  'mafia.role.consort.desc': 'Chaque nuit, retient un joueur chez lui : son action est annulée.',
  'mafia.role.framer.name': 'Faussaire',
  'mafia.role.framer.desc': 'Maquille un innocent en suspect pour la nuit.',
  'mafia.role.blackmailer.name': 'Maître chanteur',
  'mafia.role.blackmailer.desc': 'Chaque nuit, bâillonne un joueur : demain, il votera mais ne dira pas un mot.',
  'mafia.role.janitor.name': 'Nettoyeur',
  'mafia.role.janitor.desc':
    'Fait disparaître l’identité du cadavre — la ville enterre un inconnu, la famille apprend son rôle.',
  'mafia.role.agent.name': 'Agent',
  'mafia.role.agent.desc': 'Chaque nuit, piste un joueur : qui l’a visité, et chez qui il est allé.',
  'mafia.role.beguiler.name': 'Enjôleur',
  'mafia.role.beguiler.desc': 'Se cache chez quelqu’un : ce qu’on lui destinait frappe son hôte.',
  'mafia.role.disguiser.name': 'Imposteur',
  'mafia.role.disguiser.desc': 'Vole le profil d’un joueur : les enquêteurs verront l’autre visage.',
  'mafia.role.actress.name': 'Actrice',
  'mafia.role.actress.desc': 'Joue le rôle d’un autre : les enquêteurs applaudissent sans comprendre.',
  'mafia.role.kidnapper.name': 'Ravisseur',
  'mafia.role.kidnapper.desc': 'Enlève un joueur pour la nuit : injoignable, inoffensif, furieux.',
  'mafia.role.heartbreaker.name': 'Bourreau des cœurs',
  'mafia.role.heartbreaker.desc': 'Rend un joueur fou d’amour : si votre cœur s’arrête, le sien aussi.',

  /* -------------------------------- la Triade ------------------------------- */
  'mafia.role.dragon-head.name': 'Tête de Dragon',
  'mafia.role.dragon-head.desc': 'Ordonne le meurtre de la nuit pour la Triade. Insoupçonnable, intouchable.',
  'mafia.role.enforcer.name': 'Exécuteur',
  'mafia.role.enforcer.desc': 'Le bras armé de la Triade.',
  'mafia.role.vanguard.name': 'Avant-garde',
  'mafia.role.vanguard.desc': 'Un soldat de plus pour la Triade.',
  'mafia.role.administrator.name': 'Administrateur',
  'mafia.role.administrator.desc': 'Chaque nuit, découvre le rôle exact d’un joueur.',
  'mafia.role.liaison.name': 'Agente de liaison',
  'mafia.role.liaison.desc': 'Chaque nuit, retient un joueur chez lui : son action est annulée.',
  'mafia.role.forger.name': 'Contrefacteur',
  'mafia.role.forger.desc': 'Maquille un innocent en suspect pour la nuit.',
  'mafia.role.silencer.name': 'Bâillonneur',
  'mafia.role.silencer.desc': 'Chaque nuit, bâillonne un joueur : demain, il votera sans un mot.',
  'mafia.role.incense-master.name': 'Maître de l’encens',
  'mafia.role.incense-master.desc': 'L’encens efface l’identité du cadavre ; la Triade, elle, apprend tout.',
  'mafia.role.informant.name': 'Indicateur',
  'mafia.role.informant.desc': 'Chaque nuit, piste un joueur : visites reçues, visites rendues.',
  'mafia.role.deceiver.name': 'Trompeur',
  'mafia.role.deceiver.desc': 'Se cache chez quelqu’un : ce qu’on lui destinait frappe son hôte.',
  'mafia.role.interrogator.name': 'Interrogateur',
  'mafia.role.interrogator.desc': 'Enlève un joueur pour la nuit : injoignable, inoffensif, terrifié.',
  'mafia.role.diva.name': 'Diva',
  'mafia.role.diva.desc': 'Se pare du visage d’un autre : les enquêteurs n’y verront que du feu.',

  /* ------------------------------- les Neutres ------------------------------ */
  'mafia.role.jester.name': 'Bouffon',
  'mafia.role.jester.desc': 'Vous gagnez si la ville vous pend. Faites-vous détester.',
  'mafia.role.executioner.name': 'Bourreau',
  'mafia.role.executioner.desc':
    'Obsédé par une cible : faites-la pendre de jour et vous gagnez. Si elle meurt la nuit, le deuil vous rend Bouffon.',
  'mafia.role.survivor.name': 'Survivant',
  'mafia.role.survivor.desc': 'Gagne s’il voit la fin, peu importe qui l’emporte. Quatre gilets pare-balles.',
  'mafia.role.amnesiac.name': 'Amnésique',
  'mafia.role.amnesiac.desc': 'Ne se souvient plus qui il est. Une nuit, au cimetière, ça lui reviendra.',
  'mafia.role.scumbag.name': 'Crapule',
  'mafia.role.scumbag.desc':
    'Une sale réputation et aucun pouvoir. Gagne si la ville perd — et qu’il respire encore.',
  'mafia.role.judge.name': 'Juge',
  'mafia.role.judge.desc':
    'Peut convoquer un tribunal d’exception : jugement immédiat, sans défense, et sa voix compte triple. Gagne si la ville perd.',
  'mafia.role.auditor.name': 'Contrôleur fiscal',
  'mafia.role.auditor.desc':
    'Réduit un joueur à néant administratif : son rôle est dissous. Gagne si la ville perd.',
  'mafia.role.witch.name': 'Sorcière',
  'mafia.role.witch.desc':
    'Chaque nuit, envoûte un joueur et détourne son geste vers une autre maison. Gagne si la Ville ne gagne pas — et qu’elle respire encore.',
  'mafia.role.lover.name': 'Amoureux',
  'mafia.role.lover.desc':
    'Choisit l’élu de son cœur. Ils gagnent ensemble s’ils survivent ensemble — et meurent ensemble.',
  'mafia.role.cultist.name': 'Sectateur',
  'mafia.role.cultist.desc':
    'Une nuit sur deux, convertit une âme de la ville. La secte gagne quand elle est majoritaire.',
  'mafia.role.witch-doctor.name': 'Guérisseur vaudou',
  'mafia.role.witch-doctor.desc': 'Le médecin de la secte : soigne les siens comme les autres.',
  'mafia.role.serial-killer.name': 'Tueur en série',
  'mafia.role.serial-killer.desc':
    'Tue chaque nuit — sa lame perce les gilets et même la garde du Parrain. Gagne seul, quand plus personne ne peut l’arrêter.',
  'mafia.role.mass-murderer.name': 'Tueur de masse',
  'mafia.role.mass-murderer.desc': 'Massacre une maison et tous ceux qui s’y trouvent cette nuit-là. Gagne seul.',
  'mafia.role.arsonist.name': 'Incendiaire',
  'mafia.role.arsonist.desc':
    'Arrose une maison d’essence chaque nuit — ou craque l’allumette chez lui et tout ce qui est imbibé s’embrase. Rien n’arrête le feu. Gagne seul.',
  'mafia.role.poisoner.name': 'Empoisonneur',
  'mafia.role.poisoner.desc':
    'Un poison lent : la victime s’éteint la nuit suivante, sauf si un médecin la purge à temps. Gagne seul.',
  'mafia.role.electromaniac.name': 'Électromane',
  'mafia.role.electromaniac.desc':
    'Électrise les maisons en silence — puis, chez lui, abaisse la manette. Gagne seul.',

  /* --------------------------- le verbe sur le bouton ----------------------- */
  'mafia.action.kill': 'Tuer',
  'mafia.action.heal': 'Soigner',
  'mafia.action.guard': 'Protéger',
  'mafia.action.block': 'Occuper',
  'mafia.action.investigate': 'Sonder',
  'mafia.action.examine': 'Examiner',
  'mafia.action.watch': 'Surveiller',
  'mafia.action.track': 'Pister',
  'mafia.action.shadow': 'Suivre',
  'mafia.action.frame': 'Piéger',
  'mafia.action.jail-execute': 'Exécuter',
  'mafia.action.alert': 'Se mettre en alerte',
  'mafia.action.vest': 'Enfiler le gilet',
  'mafia.action.douse': 'Arroser',
  'mafia.action.control': 'Envoûter',
  'mafia.action.silence': 'Faire taire',
  'mafia.action.clean': 'Nettoyer',
  'mafia.action.swap': 'Échanger',
  'mafia.action.kidnap': 'Enlever',
  'mafia.action.recruit': 'Initier',
  'mafia.action.convert': 'Convertir',
  'mafia.action.remember': 'Se souvenir',
  'mafia.action.audit': 'Contrôler',
  'mafia.action.imitate': 'Emprunter le visage',
  'mafia.action.hide': 'Se cacher chez',
  'mafia.action.charm': 'Séduire',
  'mafia.action.bond': 'Aimer',
  'mafia.action.autopsy': 'Autopsier',
  'mafia.action.rampage': 'Massacrer',
  'mafia.action.poison': 'Empoisonner',
  'mafia.action.charge': 'Câbler',

  'mafia.action.douse.self': 'Tout brûler',
  'mafia.action.charge.self': 'Envoyer le courant',

  /* ---------------------------- la liste des rôles -------------------------- */
  'mafia.slot.town-core': 'Ville — Noyau',
  'mafia.slot.town-investigative': 'Ville — Enquête',
  'mafia.slot.town-protective': 'Ville — Protection',
  'mafia.slot.town-killing': 'Ville — Force',
  'mafia.slot.town-power': 'Ville — Pouvoir',
  'mafia.slot.town-support': 'Ville — Soutien',
  'mafia.slot.town-random': 'Ville aléatoire',
  'mafia.slot.mafia-support': 'Mafia — Soutien',
  'mafia.slot.mafia-deception': 'Mafia — Duperie',
  'mafia.slot.mafia-random': 'Mafia aléatoire',
  'mafia.slot.triad-random': 'Triade aléatoire',
  'mafia.slot.neutral-benign': 'Neutre bénin',
  'mafia.slot.neutral-evil': 'Neutre malfaisant',
  'mafia.slot.neutral-killing': 'Neutre tueur',
  'mafia.slot.neutral-random': 'Neutre aléatoire',
  'mafia.slot.any': 'Rôle libre',
  'mafia.slot.pool': 'Tiré au sort au départ parmi : {roles}.'
};

export default rolesFr;

import type { Catalogue } from '../index.js';

/**
 * Les quiz, en français : les cinq types de questions, le calcul des points, et
 * les écrans qui composent et ouvrent un salon. Les originaux.
 *
 * Le *contenu* d’une question n’est jamais ici : la bibliothèque existe pour que
 * chacun écrive ses questions avec ses mots, et ces mots sont les siens dans
 * toutes les langues.
 */
export const quizFr: Catalogue = {
  /* --------------------------- les cinq types de questions ------------------ */
  'quiz.kind.blindtest': 'Blind test',
  'quiz.kind.quiz': 'Question',
  'quiz.kind.estimation': 'Estimation',
  'quiz.kind.image-reveal': 'Image',
  'quiz.kind.image-memory': 'Panel',

  'quiz.kind.blindtest.about':
    'Un extrait joue, vous nommez le titre et l’artiste. Chaque champ est une course à part : trouver l’artiste en premier rapporte, même si quelqu’un d’autre a eu le titre avant vous.',
  'quiz.kind.quiz.about':
    'Une question, avec ou sans propositions. Répondre à l’aveugle, sans faire afficher les choix, rapporte davantage.',
  'quiz.kind.estimation.about':
    'Une question chiffrée. Tout le monde avance un nombre, le plus proche l’emporte, et l’écart décide du reste.',
  'quiz.kind.image-reveal.about':
    'Une image pixelisée se précise seconde après seconde. Le premier à reconnaître marque le maximum.',
  'quiz.kind.image-memory.about':
    'Un panel à mémoriser pendant quelques secondes, puis à réciter. Chaque case est une course indépendante.',

  /* ---------------------------------- le guide ------------------------------ */
  'quiz.guide.title': 'Quiz — règles et types de questions',
  'quiz.guide.lede': 'Cinq façons de faire deviner quelque chose, un seul système de points.',
  'quiz.guide.flow': 'Le déroulé',
  'quiz.guide.flow.1':
    'Un quiz est une suite de questions. Sur une partie organisée, quelqu’un ouvre un salon, choisit le quiz et ouvre l’écran de jeu ; les autres rejoignent avec un code ou un QR. Sur une **partie rapide**, il n’y a pas d’organisateur : le quiz est tiré au sort, la table vote pour le changer, et chaque téléphone est à la fois la scène et le buzzer.',
  'quiz.guide.flow.2':
    'Un quiz marqué **public** par son auteur peut être joué par n’importe qui — c’est aussi la réserve dans laquelle les parties rapides piochent.',
  'quiz.guide.scoring': 'Comment se calcule le score',
  'quiz.guide.scoring.1':
    'Chaque réponse est une course à part. Trois choses entrent dans le calcul : **la place obtenue** sur cette réponse, qui compte le plus ; **le temps restant** au chrono ; et **votre temps par rapport aux autres** qui ont trouvé, ce qui récompense celui qui savait quand la question était difficile pour tout le monde.',
  'quiz.guide.scoring.2':
    'Le retard réseau est compensé : c’est le moment où vous avez appuyé qui compte, pas celui où votre message est arrivé. Les points ont des décimales, c’est normal.',
  'quiz.guide.scoring.3':
    'Deux bonus optionnels, réglés à l’ouverture du salon. Le **combo** multiplie les points de manches gagnées d’affilée, jusqu’à ×2. La **remontée** donne jusqu’à ×1,5 au dernier tiers du classement, s’il est vraiment décroché.',
  'quiz.guide.kinds': 'Les types de questions',
  'quiz.guide.tokens': 'Les jetons',
  'quiz.guide.tokens.1':
    'Chaque point marqué vaut un jeton, crédité en fin de partie. Les jetons ne s’échangent que contre des apparences en boutique : rien de ce qui s’achète ne change une partie.',
  'quiz.guide.back': '← Retour au menu Quiz',

  /* ------------------------------ ouvrir un salon --------------------------- */
  'quiz.create.title': 'Créer un salon',
  'quiz.create.lede':
    'Choisissez le quiz à jouer. L’écran suivant règle la partie — ordre, chrono, points — et décide si le salon est public ou privé.',
  'quiz.create.mine': 'Mes quiz',
  'quiz.create.mineEmpty': 'Vous n’avez pas encore de quiz. Un quiz est un groupe de questions.',
  'quiz.create.makeOne': 'Créer un quiz',
  'quiz.create.public': 'Quiz publics',
  'quiz.create.publicEmpty': 'Personne n’a encore publié de quiz.',
  'quiz.create.untitled': 'Sans titre',
  'quiz.create.playable': '{count} questions jouables',
  'quiz.create.by': '· par {login}',
  'quiz.create.publicBadge': 'Public',

  /* ------------------------------- le guide Mafia --------------------------- */
  'mafia.guide.title': 'Mafia — rôles et règles',
  'mafia.guide.lede':
    'Une ville s’endort chaque nuit et se réveille avec un mort de moins. Quelqu’un autour de la table sait pourquoi.',
  'mafia.guide.idea': 'Le principe',
  'mafia.guide.idea.1':
    'La ville est majoritaire mais aveugle : elle ne sait pas qui est qui. La mafia est minoritaire mais voit clair — ses membres se connaissent, et tuent une fois par nuit. La ville gagne en pendant les derniers coupables ; la mafia gagne le jour où elle égale la ville.',
  'mafia.guide.idea.2':
    'Entre les deux vivent les **neutres**, qui ont chacun leur propre condition de victoire et n’aident personne gratuitement.',
  'mafia.guide.cycle': 'Un jour, une nuit',
  'mafia.guide.cycle.day':
    '**Le jour**, tout le monde parle et la ville met quelqu’un en accusation. L’accusé se défend, puis la ville vote coupable ou non. Trois procès au plus par jour.',
  'mafia.guide.cycle.night':
    '**La nuit**, chaque rôle agit en silence : la mafia choisit sa victime, le docteur choisit qui protéger, le shérif sonde quelqu’un. Tout se résout d’un coup, et au matin la ville découvre le résultat sans savoir ce qui l’a produit.',
  'mafia.guide.cycle.reveal':
    'Ce qu’un cadavre révèle — son rôle complet, son camp seulement, ou rien du tout — est un réglage de la table. Le réglage intermédiaire est le plus intéressant : il garde la forme du jeu tout en donnant du travail au légiste.',
  'mafia.guide.roleCount': '{count} rôles',
  'mafia.guide.unique': 'Un seul par table.',
  'mafia.guide.back': '← Retour au menu Mafia'
};

export default quizFr;

import { Link } from 'react-router';

import { gameEntry } from '../../app/games';
import { kindColor, kindLabel } from '../../app/kinds';
import './menu.css';

/**
 * What the quizzes are, and how a point is earned.
 *
 * The scoring explanation used to live at the bottom of the launch screen, where
 * only the host ever saw it — and the host is the one person who is not being
 * scored. It belongs on a page anyone can open before they play.
 */

const KINDS = [
  {
    kind: 'blindtest',
    text: 'Un extrait joue, vous nommez le titre et l’artiste. Chaque champ est une course à part : trouver l’artiste en premier rapporte, même si quelqu’un d’autre a eu le titre avant vous.'
  },
  {
    kind: 'quiz',
    text: 'Une question, avec ou sans propositions. Répondre à l’aveugle, sans faire afficher les choix, rapporte davantage.'
  },
  {
    kind: 'estimation',
    text: 'Une question chiffrée. Tout le monde avance un nombre, le plus proche l’emporte, et l’écart décide du reste.'
  },
  {
    kind: 'image-reveal',
    text: 'Une image pixelisée se précise seconde après seconde. Le premier à reconnaître marque le maximum.'
  },
  {
    kind: 'image-memory',
    text: 'Un panel à mémoriser pendant quelques secondes, puis à réciter. Chaque case est une course indépendante.'
  }
];

export default function QuizGuide() {
  const entry = gameEntry('quiz');

  return (
    <div className="guide" style={{ '--game-accent': entry.accent } as React.CSSProperties}>
      <header className="guide-head">
        <span className="guide-emoji" aria-hidden="true">
          {entry.emoji}
        </span>
        <div>
          <h1 className="guide-title">Quiz — règles et types de questions</h1>
          <p className="guide-lede">
            Cinq façons de faire deviner quelque chose, un seul système de points.
          </p>
        </div>
      </header>

      <section className="guide-section">
        <h2>Le déroulé</h2>
        <p className="guide-prose">
          Un quiz est une suite de questions. Sur une partie organisée, quelqu’un ouvre un salon, choisit le quiz et
          ouvre l’écran de jeu ; les autres rejoignent avec un code ou un QR. Sur une <strong>partie rapide</strong>, il
          n’y a pas d’organisateur : le quiz est tiré au sort, la table vote pour le changer, et chaque téléphone est à
          la fois la scène et le buzzer.
        </p>
        <p className="guide-prose">
          Un quiz marqué <strong>public</strong> par son auteur peut être joué par n’importe qui — c’est aussi la
          réserve dans laquelle les parties rapides piochent.
        </p>
      </section>

      <section className="guide-section">
        <h2>Comment se calcule le score</h2>
        <p className="guide-prose">
          Chaque réponse est une course à part. Trois choses entrent dans le calcul : <strong>la place obtenue</strong>{' '}
          sur cette réponse, qui compte le plus ; <strong>le temps restant</strong> au chrono ; et{' '}
          <strong>votre temps par rapport aux autres</strong> qui ont trouvé, ce qui récompense celui qui savait quand
          la question était difficile pour tout le monde.
        </p>
        <p className="guide-prose">
          Le retard réseau est compensé : c’est le moment où vous avez appuyé qui compte, pas celui où votre message est
          arrivé. Les points ont des décimales, c’est normal.
        </p>
        <p className="guide-prose">
          Deux bonus optionnels, réglés à l’ouverture du salon. Le <strong>combo</strong> multiplie les points de
          manches gagnées d’affilée, jusqu’à ×2. La <strong>remontée</strong> donne jusqu’à ×1,5 au dernier tiers du
          classement, s’il est vraiment décroché.
        </p>
      </section>

      <section className="guide-section">
        <h2>Les types de questions</h2>
        <div className="guide-cards">
          {KINDS.map((entryKind) => (
            <article
              className="guide-card"
              key={entryKind.kind}
              style={{ borderLeft: `3px solid ${kindColor(entryKind.kind)}` }}
            >
              <div>
                <div className="guide-card-name">{kindLabel(entryKind.kind)}</div>
                <p className="guide-card-note">{entryKind.text}</p>
              </div>
            </article>
          ))}
        </div>
      </section>

      <section className="guide-section">
        <h2>Les jetons</h2>
        <p className="guide-prose">
          Chaque point marqué vaut un jeton, crédité en fin de partie. Les jetons ne s’échangent que contre des
          apparences en boutique : rien de ce qui s’achète ne change une partie.
        </p>
      </section>

      <Link to={entry.path} className="menu-back">
        ← Retour au menu Quiz
      </Link>
    </div>
  );
}

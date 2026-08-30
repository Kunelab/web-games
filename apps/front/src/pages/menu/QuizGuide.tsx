import { msg } from 'i18n';
import { Link } from 'react-router';

import { gameEntry } from '../../app/games';
import { kindColor, kindKey } from '../../app/kinds';
import { useT } from '../../i18n/locale-context';
import { Prose } from '../../ui/Prose';
import './menu.css';

/**
 * What the quizzes are, and how a point is earned.
 *
 * The scoring explanation used to live at the bottom of the launch screen, where
 * only the host ever saw it — and the host is the one person who is not being
 * scored. It belongs on a page anyone can open before they play.
 */

/** The five kinds, in the order a newcomer meets them. Each explains itself. */
const KINDS = ['blindtest', 'quiz', 'estimation', 'image-reveal', 'image-memory'];

export default function QuizGuide() {
  const entry = gameEntry('quiz');
  const t = useT();

  return (
    <div className="guide" style={{ '--game-accent': entry.accent } as React.CSSProperties}>
      <header className="guide-head">
        <span className="guide-emoji" aria-hidden="true">
          {entry.emoji}
        </span>
        <div>
          <h1 className="guide-title">{t(msg('quiz.guide.title'))}</h1>
          <p className="guide-lede">{t(msg('quiz.guide.lede'))}</p>
        </div>
      </header>

      <section className="guide-section">
        <h2>{t(msg('quiz.guide.flow'))}</h2>
        <Prose className="guide-prose" k="quiz.guide.flow.1" />
        <Prose className="guide-prose" k="quiz.guide.flow.2" />
      </section>

      <section className="guide-section">
        <h2>{t(msg('quiz.guide.scoring'))}</h2>
        <Prose className="guide-prose" k="quiz.guide.scoring.1" />
        <Prose className="guide-prose" k="quiz.guide.scoring.2" />
        <Prose className="guide-prose" k="quiz.guide.scoring.3" />
      </section>

      <section className="guide-section">
        <h2>{t(msg('quiz.guide.kinds'))}</h2>
        <div className="guide-cards">
          {KINDS.map((kind) => (
            <article className="guide-card" key={kind} style={{ borderLeft: `3px solid ${kindColor(kind)}` }}>
              <div>
                <div className="guide-card-name">{t(msg(kindKey(kind)))}</div>
                <p className="guide-card-note">{t(msg(`quiz.kind.${kind}.about`))}</p>
              </div>
            </article>
          ))}
        </div>
      </section>

      <section className="guide-section">
        <h2>{t(msg('quiz.guide.tokens'))}</h2>
        <Prose className="guide-prose" k="quiz.guide.tokens.1" />
      </section>

      <Link to={entry.path} className="menu-back">
        {t(msg('quiz.guide.back'))}
      </Link>
    </div>
  );
}

import { RARITY_META, SCENARIO_LABELS, ZOMBIES, type Scenario } from 'coronaz-core';
import { useState } from 'react';
import { Link } from 'react-router';

import { gameEntry } from '../../app/games';
import { zombieSprite } from '../zombie/czAssets';
import './menu.css';

/**
 * The lore, the bestiary and the rules — the three things a new survivor asks
 * for in that order.
 *
 * The bestiary is generated from `coronaz-core`'s own roster, portraits included
 * where the art exists: a creature added to the engine is documented the day it
 * is added, with the numbers it actually fights with rather than the numbers
 * somebody typed into a page once.
 */
export default function CzGuide() {
  const entry = gameEntry('coronaz');
  const bestiary = [...ZOMBIES].sort((left, right) => left.cost - right.cost);

  return (
    <div className="guide" style={{ '--game-accent': entry.accent } as React.CSSProperties}>
      <header className="guide-head">
        <span className="guide-emoji" aria-hidden="true">
          {entry.emoji}
        </span>
        <div>
          <h1 className="guide-title">CoronaZ — le quartier</h1>
          <p className="guide-lede">
            Ce qui est arrivé au quartier, ce qui y vit maintenant, et par où l’on peut encore en sortir.
          </p>
        </div>
      </header>

      <section className="guide-section">
        <h2>Ce qui s’est passé</h2>
        <p className="guide-prose">
          Un virus, une quarantaine, puis plus personne à qui téléphoner. Le quartier a été bouclé en deux jours et
          oublié en trois. Ce qui restait dedans a eu le temps de changer.
        </p>
        <p className="guide-prose">
          Vous êtes trois à cinq à y être encore, chacun avec une raison différente de ne pas être parti à temps. La
          télé montre le plan des rues ; votre téléphone montre ce que vous, vous voyez.
        </p>
      </section>

      <section className="guide-section">
        <h2>Comment on joue</h2>
        <p className="guide-prose">
          Un tour se joue en deux temps. <strong>Les survivants d’abord</strong>, tous en même temps : chacun dépense
          ses points d’action pour se déplacer, fouiller une pièce, tirer, frapper, échanger un objet. Puis{' '}
          <strong>la horde</strong>, qui bouge vers le bruit et frappe ce qu’elle atteint.
        </p>
        <p className="guide-prose">
          Le noir cache tout : une pièce jamais visitée est vide sur votre écran, et une créature n’apparaît que dans
          votre ligne de vue. Une lampe torche est donc une arme, à sa manière.
        </p>
        <p className="guide-prose">
          Fouiller fait du bruit et attire. C’est la tension permanente du jeu : le butin est dans les pièces, et le
          bruit aussi.
        </p>
      </section>

      <section className="guide-section">
        <h2>Les scénarios</h2>
        <div className="guide-cards">
          {(Object.keys(SCENARIO_LABELS) as Scenario[]).map((scenario) => (
            <article className="guide-card" key={scenario}>
              <div>
                <div className="guide-card-name">{SCENARIO_LABELS[scenario].name}</div>
                <p className="guide-card-note">{SCENARIO_LABELS[scenario].goal}</p>
              </div>
            </article>
          ))}
        </div>
      </section>

      <section className="guide-section">
        <h2>Bestiaire</h2>
        <p className="guide-prose">
          Du plus commun au plus cher à faire venir. Un maître du jeu humain paie ces prix pour les poser sur la carte ;
          l’intelligence artificielle, elle, dépense le même budget sans hésiter.
        </p>
        <div className="guide-cards">
          {bestiary.map((zombie) => (
            <article className="guide-card" key={zombie.id}>
              <Portrait src={zombieSprite(zombie.id)} fallback={zombie.emoji} />
              <div>
                <div className="guide-card-name">
                  {zombie.name}
                  {zombie.boss && ' — boss'}
                </div>
                <p className="guide-stats">
                  <span>{zombie.hp} PV</span>
                  <span>{zombie.damage} dégâts</span>
                  <span>{zombie.ap} PA</span>
                  {zombie.armor > 0 && <span>{zombie.armor} armure</span>}
                  <span>{zombie.points} pts</span>
                </p>
                <p className="guide-card-note">{RARITY_META[zombie.rarity]?.label ?? zombie.rarity}</p>
              </div>
            </article>
          ))}
        </div>
      </section>

      <Link to={entry.path} className="menu-back">
        ← Retour au menu CoronaZ
      </Link>
    </div>
  );
}

/**
 * A face, or the emoji that stands in for one.
 *
 * Every art path in this codebase is allowed to 404 — that is what lets the
 * bestiary ship before it is illustrated — so a missing file falls back rather
 * than leaving a broken-image icon in the middle of the page.
 */
function Portrait({ src, fallback }: { src: string | null; fallback: string }) {
  const [broken, setBroken] = useState(false);

  if (!src || broken) {
    return (
      <span className="guide-card-emoji" aria-hidden="true">
        {fallback}
      </span>
    );
  }

  return (
    <img
      className="guide-card-emoji"
      src={src}
      alt=""
      width={44}
      height={44}
      style={{ borderRadius: 'var(--radius-sm)', objectFit: 'cover' }}
      onError={() => setBroken(true)}
    />
  );
}

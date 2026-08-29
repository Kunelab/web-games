import { FACTION_LABELS, ROLES, type RoleDef } from 'mafia-core';
import { Link } from 'react-router';

import { gameEntry } from '../../app/games';
import './menu.css';

/**
 * What Mafia is, before you are dealt a role you have never heard of.
 *
 * The roster is read from `mafia-core` rather than retyped, which is the only
 * way a page like this stays true: a role added to the engine appears here the
 * same day, with its own one-line pitch, and nobody has to remember to update a
 * list of forty.
 */

const ORDER = ['town', 'mafia', 'triad', 'cult', 'neutral'] as const;

export default function MafiaGuide() {
  const entry = gameEntry('mafia');
  const byFaction = new Map<string, RoleDef[]>();

  for (const role of Object.values(ROLES)) {
    const bucket = byFaction.get(role.faction);
    if (bucket) bucket.push(role);
    else byFaction.set(role.faction, [role]);
  }

  return (
    <div className="guide" style={{ '--game-accent': entry.accent } as React.CSSProperties}>
      <header className="guide-head">
        <span className="guide-emoji" aria-hidden="true">
          {entry.emoji}
        </span>
        <div>
          <h1 className="guide-title">Mafia — rôles et règles</h1>
          <p className="guide-lede">
            Une ville s’endort chaque nuit et se réveille avec un mort de moins. Quelqu’un autour de la table sait
            pourquoi.
          </p>
        </div>
      </header>

      <section className="guide-section">
        <h2>Le principe</h2>
        <p className="guide-prose">
          La ville est majoritaire mais aveugle : elle ne sait pas qui est qui. La mafia est minoritaire mais voit
          clair — ses membres se connaissent, et tuent une fois par nuit. La ville gagne en pendant les derniers
          coupables ; la mafia gagne le jour où elle égale la ville.
        </p>
        <p className="guide-prose">
          Entre les deux vivent les <strong>neutres</strong>, qui ont chacun leur propre condition de victoire et
          n’aident personne gratuitement.
        </p>
      </section>

      <section className="guide-section">
        <h2>Un jour, une nuit</h2>
        <p className="guide-prose">
          <strong>Le jour</strong>, tout le monde parle et la ville met quelqu’un en accusation. L’accusé se défend,
          puis la ville vote coupable ou non. Trois procès au plus par jour.
        </p>
        <p className="guide-prose">
          <strong>La nuit</strong>, chaque rôle agit en silence : la mafia choisit sa victime, le docteur choisit qui
          protéger, le shérif sonde quelqu’un. Tout se résout d’un coup, et au matin la ville découvre le résultat sans
          savoir ce qui l’a produit.
        </p>
        <p className="guide-prose">
          Ce qu’un cadavre révèle — son rôle complet, son camp seulement, ou rien du tout — est un réglage de la table.
          Le réglage intermédiaire est le plus intéressant : il garde la forme du jeu tout en donnant du travail au
          légiste.
        </p>
      </section>

      {ORDER.map((faction) => {
        const roles = byFaction.get(faction) ?? [];
        if (roles.length === 0) return null;

        return (
          <section className="guide-section" key={faction}>
            <h2>
              {FACTION_LABELS[faction]} <span className="guide-faction">{roles.length} rôles</span>
            </h2>
            <div className="guide-cards">
              {roles.map((role) => (
                <article className="guide-card" key={role.id}>
                  <div>
                    <div className="guide-card-name">{role.name}</div>
                    <p className="guide-card-note">{role.description}</p>
                    {role.unique && <p className="guide-card-note">Un seul par table.</p>}
                  </div>
                </article>
              ))}
            </div>
          </section>
        );
      })}

      <Link to={entry.path} className="menu-back">
        ← Retour au menu Mafia
      </Link>
    </div>
  );
}

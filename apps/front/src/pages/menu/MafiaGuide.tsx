import { msg } from 'i18n';
import { ROLES, type RoleDef } from 'mafia-core';
import { Link } from 'react-router';

import { gameEntry } from '../../app/games';
import { useT } from '../../i18n/locale-context';
import { Prose } from '../../ui/Prose';
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
  const t = useT();
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
          <h1 className="guide-title">{t(msg('mafia.guide.title'))}</h1>
          <p className="guide-lede">{t(msg('mafia.guide.lede'))}</p>
        </div>
      </header>

      <section className="guide-section">
        <h2>{t(msg('mafia.guide.idea'))}</h2>
        <Prose className="guide-prose" k="mafia.guide.idea.1" />
        <Prose className="guide-prose" k="mafia.guide.idea.2" />
      </section>

      <section className="guide-section">
        <h2>{t(msg('mafia.guide.cycle'))}</h2>
        <Prose className="guide-prose" k="mafia.guide.cycle.day" />
        <Prose className="guide-prose" k="mafia.guide.cycle.night" />
        <Prose className="guide-prose" k="mafia.guide.cycle.reveal" />
      </section>

      {ORDER.map((faction) => {
        const roles = byFaction.get(faction) ?? [];
        if (roles.length === 0) return null;

        return (
          <section className="guide-section" key={faction}>
            <h2>
              {t(msg(`mafia.faction.${faction}`))}{' '}
              <span className="guide-faction">{t(msg('mafia.guide.roleCount', { count: roles.length }))}</span>
            </h2>
            <div className="guide-cards">
              {roles.map((role) => (
                <article className="guide-card" key={role.id}>
                  <div>
                    <div className="guide-card-name">{t(msg(`mafia.role.${role.id}.name`))}</div>
                    <p className="guide-card-note">{t(msg(`mafia.role.${role.id}.desc`))}</p>
                    {role.unique && <p className="guide-card-note">{t(msg('mafia.guide.unique'))}</p>}
                  </div>
                </article>
              ))}
            </div>
          </section>
        );
      })}

      {/*
        How to write a will the board can actually read.

        Here rather than beside the will box, because it is a thing to learn
        once and not a thing to be reminded of while typing under a clock. The
        examples are the shapes the reader genuinely accepts — each one was run
        through it — so this page is a contract rather than advice.
      */}
      <section className="guide-section">
        <h2>{t(msg('mafia.guide.will'))}</h2>
        <Prose className="guide-prose" k="mafia.guide.will.why" />
        <Prose className="guide-prose" k="mafia.guide.will.how" />

        <Prose className="guide-prose" k="mafia.guide.will.claim" />
        <pre className="guide-example">{t(msg('mafia.guide.will.claim.eg'))}</pre>

        <Prose className="guide-prose" k="mafia.guide.will.checks" />
        <pre className="guide-example">{t(msg('mafia.guide.will.checks.eg'))}</pre>
        <Prose className="guide-prose" k="mafia.guide.will.words" />

        <Prose className="guide-prose" k="mafia.guide.will.where" />
        <pre className="guide-example">{t(msg('mafia.guide.will.where.eg'))}</pre>

        <Prose className="guide-prose" k="mafia.guide.will.dont" />
      </section>

      <Link to={entry.path} className="menu-back">
        {t(msg('mafia.guide.back'))}
      </Link>
    </div>
  );
}

import {
  HERO_GLOBAL_PERKS,
  HEROES,
  heroDef,
  itemFor,
  loadoutPerkDef,
  RARITY_META,
  roleDef,
  weaponStats,
  type HeroDef,
  type ItemRole
} from 'coronaz-core';
import { useState } from 'react';

import { heroHue, heroPortrait, itemSprite } from './czAssets';
import { cx } from '../../ui/cx';
import { Button } from '../../ui';

/**
 * The draft screen: pick a survivor, read what they do, then build them.
 *
 * Shaped like a fighting game's roster rather than a list of buttons, because
 * that is what twenty characters need. The grid is nothing but faces, so the
 * whole roster is on screen at once and comparing two of them is a glance rather
 * than a scroll; the panel beside it explains whichever one you are looking at,
 * and it explains it on *hover*, so you can shop the entire roster without
 * committing to anything. Choosing is a click, and only then do the perks below
 * belong to you.
 *
 * On a phone the same two halves stack, which is a better lobby than the list it
 * replaced: a face is quicker to recognise than a name, at any size.
 */
export function CzHeroSelect({
  mine,
  takenBy,
  unlocked,
  rations,
  biome,
  loadout,
  onPick,
  onUnlock,
  onLoadout
}: {
  /** The hero this player currently holds, if any. */
  mine: string | null;
  /** hero id → who has them, for the whole table. */
  takenBy: ReadonlyMap<string, string>;
  unlocked: ReadonlySet<string>;
  rations: number | null;
  /** Which world this raid is set in: it decides what a favourite weapon *is*. */
  biome: string;
  loadout: readonly string[];
  onPick: (heroId: string) => void;
  onUnlock: (heroId: string) => void;
  onLoadout: (perks: string[]) => void;
}) {
  /** What the panel is describing: hover wins, then your pick, then the first. */
  const [preview, setPreview] = useState<string | null>(null);
  const shown = preview ?? mine ?? HEROES[0]?.id ?? 'charles';
  const hero = heroDef(shown);

  const locked = (candidate: HeroDef) => Boolean(candidate.cost) && !unlocked.has(candidate.id);

  return (
    <div className="cz-draft">
      <div className="cz-roster" onMouseLeave={() => setPreview(null)}>
        {HEROES.map((candidate) => {
          const owner = takenBy.get(candidate.id);
          const isMine = mine === candidate.id;
          const isLocked = locked(candidate);
          const unavailable = (Boolean(owner) && !isMine) || isLocked;

          return (
            <button
              key={candidate.id}
              type="button"
              className={cx(
                'cz-face',
                isMine && 'mine',
                shown === candidate.id && 'shown',
                unavailable && 'unavailable'
              )}
              style={{ '--face-hue': heroHue(candidate.id) } as React.CSSProperties}
              onMouseEnter={() => setPreview(candidate.id)}
              onFocus={() => setPreview(candidate.id)}
              onClick={() => {
                setPreview(candidate.id);
                // A locked survivor's tile is where you buy them; the panel's
                // button does it too, for anyone using the keyboard.
                if (isLocked) return;
                if (!owner || isMine) onPick(candidate.id);
              }}
              aria-label={candidate.name}
              title={owner && !isMine ? `${candidate.name} — pris par ${owner}` : candidate.name}
            >
              <HeroPortrait heroId={candidate.id} emoji={candidate.emoji} />
              <span className="cz-face-name">{candidate.name}</span>
              {isLocked && <span className="cz-face-lock">🔒 {candidate.cost} 🥫</span>}
              {owner && !isMine && <span className="cz-face-taken">{owner}</span>}
              {isMine && <span className="cz-face-badge">✓</span>}
            </button>
          );
        })}
      </div>

      <aside className="cz-dossier">
        <div className="cz-dossier-head">
          <span className="cz-dossier-face" style={{ '--face-hue': heroHue(hero.id) } as React.CSSProperties}>
            <HeroPortrait heroId={hero.id} emoji={hero.emoji} />
          </span>
          <div>
            <h3 className="cz-dossier-name">{hero.name}</h3>
            <p className="cz-dossier-blurb">{hero.blurb}</p>
            <p className="cz-dossier-stats">
              <span>❤ {hero.hp} PV</span>
              <FavouriteWeapon biome={biome} role={hero.favoriteWeapon} />
            </p>
          </div>
        </div>

        {locked(hero) ? (
          <Button
            variant="secondary"
            size="sm"
            disabled={(rations ?? 0) < (hero.cost ?? 0)}
            onClick={() => onUnlock(hero.id)}
          >
            Débloquer pour {hero.cost} 🥫
            {rations !== null && ` · vous avez ${rations}`}
          </Button>
        ) : mine === hero.id ? (
          <p className="cz-dossier-mine">Votre survivant.</p>
        ) : takenBy.has(hero.id) ? (
          <p className="play-note">Déjà pris par {takenBy.get(hero.id)}.</p>
        ) : (
          <Button variant="primary" size="sm" onClick={() => onPick(hero.id)}>
            Choisir {hero.name}
          </Button>
        )}

        {/* The build. Only ever your own: a signature perk belongs to a body. */}
        {mine === hero.id ? (
          <PerkPicker heroId={hero.id} loadout={loadout} onChange={onLoadout} />
        ) : (
          <div className="stack-2">
            <span className="cz-slot-label">Atouts signature</span>
            <ul className="cz-perk-preview">
              {hero.personalPerks.map((id) => {
                const perk = loadoutPerkDef(id);
                return (
                  <li key={id}>
                    {perk.emoji} {perk.label}
                  </li>
                );
              })}
            </ul>
          </div>
        )}
      </aside>
    </div>
  );
}

/**
 * A face. The raster when one has been shipped, the emoji medallion until then —
 * which is why a roster of twenty can exist before any of them are drawn.
 */
export function HeroPortrait({ heroId, emoji }: { heroId: string; emoji: string }) {
  const [failed, setFailed] = useState(false);
  if (failed) return <span className="cz-portrait-emoji">{emoji}</span>;
  return (
    <img className="cz-portrait-img" src={heroPortrait(heroId)} alt="" loading="lazy" onError={() => setFailed(true)} />
  );
}

/**
 * The kind of weapon this character grew up with, as this world builds it: the
 * role is the character's, the actual gun belongs to the biome.
 */
function FavouriteWeapon({ biome, role }: { biome: string; role: ItemRole }) {
  const def = itemFor(biome === 'random' ? 'modern' : biome, role);
  const stats = weaponStats(def, def.tier);
  const art = itemSprite(def.id);
  return (
    <span className="cz-favourite" title={`Arme fétiche (${roleDef(role).label}) : +1 dé avec ${def.name}`}>
      {art ? <img className="cz-item-sprite" src={art} alt="" /> : def.emoji} {def.name}
      {stats && (
        <span className="cz-favourite-stats">
          {stats.melee ? '⚔️' : `🎯${stats.range}`} 🎲{stats.dice} 💥{stats.damage}
        </span>
      )}
      <span className="cz-rarity" style={{ color: RARITY_META[def.tier].color }}>
        T{def.tier}
      </span>
    </span>
  );
}

/**
 * The CoD pick: one signature perk from this character's three, up to two from
 * the shared pool. Every tap sends the whole loadout; the server validates it.
 */
function PerkPicker({
  heroId,
  loadout,
  onChange
}: {
  heroId: string;
  loadout: readonly string[];
  onChange: (perks: string[]) => void;
}) {
  const signaturePool = heroDef(heroId).personalPerks as readonly string[];
  const signature = loadout.find((id) => signaturePool.includes(id)) ?? null;
  const globals = loadout.filter((id) => !signaturePool.includes(id));

  return (
    <div className="stack-2">
      <span className="cz-slot-label">Atout signature (1 au choix)</span>
      <div className="cz-perk-grid">
        {signaturePool.map((id) => {
          const perk = loadoutPerkDef(id);
          const picked = signature === id;
          return (
            <button
              key={id}
              type="button"
              className={`cz-perk ${picked ? 'picked' : ''}`}
              onClick={() => onChange([...(picked ? [] : [id]), ...globals])}
            >
              {perk.emoji} {perk.label}
            </button>
          );
        })}
      </div>

      <span className="cz-slot-label">Atouts généraux ({globals.length}/2)</span>
      <div className="cz-perk-grid">
        {HERO_GLOBAL_PERKS.map((id) => {
          const perk = loadoutPerkDef(id);
          const picked = globals.includes(id);
          const full = !picked && globals.length >= 2;
          return (
            <button
              key={id}
              type="button"
              className={`cz-perk ${picked ? 'picked' : ''}`}
              disabled={full}
              onClick={() =>
                onChange([
                  ...(signature ? [signature] : []),
                  ...(picked ? globals.filter((other) => other !== id) : [...globals, id])
                ])
              }
            >
              {perk.emoji} {perk.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

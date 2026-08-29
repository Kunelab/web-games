import { CURRENCIES, shopSlots, type LobbyGame, type LockerView, type ShopItem } from 'lobby-core';
import { useState } from 'react';
import { Link } from 'react-router';

import { api, ApiError } from '../../api/client';
import { gameEntry } from '../../app/games';
import { useAsync } from '../../hooks/useAsync';
import { Button, Loading } from '../../ui';
import './menu.css';

/**
 * The shop and the wardrobe, which are one screen looked at twice.
 *
 * Both list the same catalogue against the same locker; they differ in what a
 * card offers — a price or a hanger — and in what they hide. Writing them as one
 * component keeps the two in step: an item bought in the shop is worn from the
 * moment it appears, and the wardrobe never shows something the shop forgot to
 * sell.
 *
 * Nothing here grants an ability. That is a rule rather than a coincidence: the
 * currencies are earned by playing, and a currency that buys advantage turns
 * every evening into a grind. Loadouts are named in the slot model for the day
 * there is something to load out, and today there is only what you look like.
 */

export interface LockerPageProps {
  game: LobbyGame;
  /** `shop` sells, `locker` dresses. Same data, different verbs. */
  mode: 'shop' | 'locker';
}

export default function Locker({ game, mode }: LockerPageProps) {
  const entry = gameEntry(game);
  const currency = CURRENCIES[game];

  const shop = useAsync(() => api.shop(game), [game]);
  const locker = useAsync(() => api.locker(game), [game]);

  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function act(itemId: string, run: () => Promise<LockerView>) {
    setBusy(itemId);
    setError(null);
    try {
      locker.set(await run());
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : 'L’opération a échoué.');
    } finally {
      setBusy(null);
    }
  }

  if (shop.loading || locker.loading) return <Loading />;

  const items = shop.data?.items ?? [];
  const owned = new Set(locker.data?.owned ?? []);
  const worn = locker.data?.worn ?? {};
  const balance = locker.data?.balance ?? 0;

  const selling = mode === 'shop';
  const visible = selling ? items : items.filter((item) => owned.has(item.id));

  return (
    <div className="locker" style={{ '--game-accent': entry.accent } as React.CSSProperties}>
      <header className="menu-head">
        <span className="menu-emoji" aria-hidden="true">
          {selling ? currency.emoji : '🎽'}
        </span>
        <div>
          <h1 className="menu-title">
            {selling ? 'Boutique' : 'Équipement'} — {entry.name}
          </h1>
          <p className="menu-lede">
            {selling
              ? `${currency.earnedBy} Rien de ce qui est vendu ici ne change une partie : ce sont des apparences, et c’est délibéré.`
              : 'Ce que vous portez, un article par emplacement. Retirez-le pour revenir à l’apparence par défaut.'}
          </p>
        </div>
      </header>

      <p className="locker-balance">
        <strong>{balance}</strong>
        <span>
          {currency.emoji} {currency.name}
        </span>
      </p>

      {error && <p className="field-error">{error}</p>}

      {visible.length === 0 ? (
        <p className="guide-prose">
          {selling
            ? 'La boutique de ce jeu est vide pour l’instant.'
            : 'Vous ne possédez encore rien ici.'}{' '}
          <Link to={selling ? entry.path : `${entry.path}/boutique`}>
            {selling ? 'Retour au menu' : 'Voir la boutique'}
          </Link>
        </p>
      ) : selling ? (
        <div className="locker-grid">
          {visible.map((item) => (
            <ItemCard
              key={item.id}
              item={item}
              owned={owned.has(item.id)}
              worn={worn[item.slot] === item.id}
              action={
                owned.has(item.id) ? (
                  <Button variant="ghost" disabled>
                    Déjà à vous
                  </Button>
                ) : (
                  <Button
                    variant="primary"
                    busy={busy === item.id}
                    disabled={balance < item.price}
                    onClick={() => void act(item.id, () => api.buyItem(game, item.id))}
                  >
                    Acheter — {item.price} {currency.emoji}
                  </Button>
                )
              }
            />
          ))}
        </div>
      ) : (
        shopSlots(game).map((slot) => {
          const inSlot = visible.filter((item) => item.slot === slot);
          if (inSlot.length === 0) return null;

          return (
            <section className="guide-section" key={slot}>
              <h2 className="locker-slot-title">{slotLabel(slot)}</h2>
              <div className="locker-grid">
                {inSlot.map((item) => {
                  const isWorn = worn[slot] === item.id;
                  return (
                    <ItemCard
                      key={item.id}
                      item={item}
                      owned
                      worn={isWorn}
                      action={
                        <Button
                          variant={isWorn ? 'secondary' : 'primary'}
                          busy={busy === item.id}
                          onClick={() =>
                            void act(item.id, () => api.wearItem(game, slot, isWorn ? null : item.id))
                          }
                        >
                          {isWorn ? 'Retirer' : 'Porter'}
                        </Button>
                      }
                    />
                  );
                })}
              </div>
            </section>
          );
        })
      )}

      <Link to={entry.path} className="menu-back">
        ← Retour au menu {entry.name}
      </Link>
    </div>
  );
}

function ItemCard({
  item,
  owned,
  worn,
  action
}: {
  item: ShopItem;
  owned: boolean;
  worn: boolean;
  action: React.ReactNode;
}) {
  return (
    <article className={`locker-item ${owned ? 'owned' : ''} ${worn ? 'worn' : ''}`}>
      {/* The emoji is the art until the art exists; see public/games/README.md. */}
      <div className="locker-item-art" aria-hidden="true">
        {item.emoji}
      </div>
      <span className="locker-item-name">
        {item.name}
        {worn && ' — porté'}
      </span>
      <span className="locker-item-note">{item.description}</span>
      {action}
    </article>
  );
}

function slotLabel(slot: string): string {
  return slot === 'avatar' ? 'Apparence' : slot;
}

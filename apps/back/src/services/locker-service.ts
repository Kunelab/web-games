import { and, eq } from 'drizzle-orm';
import { emptyLocker, shopItem, type LobbyGame, type LockerView } from 'lobby-core';

import { db } from '../db/index.js';
import { cosmetics } from '../db/schema.js';
import { accountKey, czCareerService } from './cz-career-service.js';
import { mafiaCareerService } from './mafia-career-service.js';
import { quizAccountKey, quizCareerService } from './quiz-career-service.js';

/**
 * The shop and the wardrobe, over three wallets that already existed.
 *
 * CoronaZ banks rations, Mafia banks points, and the quizzes now bank tokens —
 * three ledgers with three names, three shapes and three services. Rather than
 * unify them (a migration that would rewrite everybody's roguelite history to
 * sell a hat), this adapts them: one interface with a balance and a debit, and
 * the price checked here so a client can send whatever item id it likes and
 * still be charged the catalogue's number.
 *
 * Ownership is account-scoped. A wallet belongs to a nickname because that is
 * who played; a wardrobe belongs to a login because that is who paid, and a
 * purchase that evaporated when you next typed a different nickname would be a
 * purchase nobody makes twice.
 */

interface Wallet {
  balance: (ledger: string) => Promise<number>;
  spend: (ledger: string, amount: number) => Promise<{ ok: boolean; balance: number }>;
  /** The ledger key a login's money sits under, per that game's convention. */
  key: (login: string) => string;
}

const WALLETS: Record<LobbyGame, Wallet> = {
  quiz: {
    balance: (ledger) => quizCareerService.forName(ledger).then((stats) => stats.tokens),
    spend: async (ledger, amount) => {
      const result = await quizCareerService.debit(ledger, amount);
      return result.ok
        ? { ok: true, balance: result.stats.tokens }
        : { ok: false, balance: (await quizCareerService.forName(ledger)).tokens };
    },
    key: quizAccountKey
  },
  coronaz: {
    balance: (ledger) => czCareerService.balance(ledger),
    spend: (ledger, amount) => czCareerService.spend(ledger, amount),
    key: accountKey
  },
  mafia: {
    balance: (ledger) => mafiaCareerService.balance(ledger),
    spend: (ledger, amount) => mafiaCareerService.spend(ledger, amount),
    key: (login) => `@${login}`
  }
};

interface Stored {
  owned: string[];
  worn: Record<string, string>;
}

async function read(userId: number, game: LobbyGame): Promise<Stored> {
  const [row] = await db
    .select()
    .from(cosmetics)
    .where(and(eq(cosmetics.user_id, userId), eq(cosmetics.game, game)))
    .limit(1);

  if (!row) return { owned: [], worn: {} };

  try {
    return {
      owned: JSON.parse(row.owned) as string[],
      worn: JSON.parse(row.worn) as Record<string, string>
    };
  } catch {
    // A corrupt blob is an empty wardrobe, not a 500: nothing here is load-bearing.
    return { owned: [], worn: {} };
  }
}

async function write(userId: number, game: LobbyGame, stored: Stored): Promise<void> {
  const payload = {
    user_id: userId,
    game,
    owned: JSON.stringify(stored.owned),
    worn: JSON.stringify(stored.worn),
    updated_at: new Date().toISOString()
  };

  await db
    .insert(cosmetics)
    .values(payload)
    .onConflictDoUpdate({
      target: [cosmetics.user_id, cosmetics.game],
      set: { owned: payload.owned, worn: payload.worn, updated_at: payload.updated_at }
    });
}

export type BuyResult = { ok: true; locker: LockerView } | { ok: false; error: string };

export const lockerService = {
  async get(userId: number, login: string, game: LobbyGame): Promise<LockerView> {
    const [stored, balance] = await Promise.all([read(userId, game), WALLETS[game].balance(WALLETS[game].key(login))]);
    return { ...emptyLocker(game), balance, owned: stored.owned, worn: stored.worn };
  },

  /**
   * Buys, and wears it straight away.
   *
   * Equipping on purchase because nobody buys a hat in order to keep it in a box,
   * and the alternative is a screen that congratulates you and visibly changes
   * nothing. The locker can still take it back off.
   */
  async buy(userId: number, login: string, game: LobbyGame, itemId: string): Promise<BuyResult> {
    const item = shopItem(itemId);
    if (!item || item.game !== game) {
      return { ok: false, error: 'Cet article n’existe pas.' };
    }

    const stored = await read(userId, game);
    if (stored.owned.includes(itemId)) {
      return { ok: false, error: 'Vous possédez déjà cet article.' };
    }

    const wallet = WALLETS[game];
    const spent = await wallet.spend(wallet.key(login), item.price);
    if (!spent.ok) {
      return { ok: false, error: `Il vous manque ${item.price - spent.balance} pour cet article.` };
    }

    stored.owned.push(itemId);
    stored.worn[item.slot] = itemId;
    await write(userId, game, stored);

    return { ok: true, locker: { game, balance: spent.balance, owned: stored.owned, worn: stored.worn } };
  },

  /** Wears an owned item, or clears the slot when `itemId` is null. */
  async wear(userId: number, login: string, game: LobbyGame, slot: string, itemId: string | null): Promise<BuyResult> {
    const stored = await read(userId, game);

    if (itemId === null) {
      delete stored.worn[slot];
    } else {
      const item = shopItem(itemId);
      if (!item || item.game !== game || item.slot !== slot) {
        return { ok: false, error: 'Cet article ne va pas dans cet emplacement.' };
      }
      if (!stored.owned.includes(itemId)) {
        return { ok: false, error: 'Vous ne possédez pas cet article.' };
      }
      stored.worn[slot] = itemId;
    }

    await write(userId, game, stored);
    const balance = await WALLETS[game].balance(WALLETS[game].key(login));
    return { ok: true, locker: { game, balance, owned: stored.owned, worn: stored.worn } };
  }
};

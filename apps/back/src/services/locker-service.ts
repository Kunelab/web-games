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

  return parseStored(row);
}

function parseStored(row: { owned: string; worn: string } | undefined): Stored {
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

/**
 * Reads a wardrobe, changes it and writes it back, all inside one transaction.
 *
 * What this closes is the double purchase. Buying used to read the wardrobe,
 * decide the item was not owned, charge for it and then write - four steps with
 * awaits between them, so two taps on the same hat both got past the ownership
 * test, both paid, and only one of the two writes survived. One transaction means
 * the second tap finds the hat already owned and never reaches the till.
 *
 * `change` returns null to refuse, writing nothing.
 */
function mutateLocker<R>(userId: number, game: LobbyGame, change: (stored: Stored) => R | null): R | null {
  return db.transaction((tx) => {
    const [row] = tx
      .select()
      .from(cosmetics)
      .where(and(eq(cosmetics.user_id, userId), eq(cosmetics.game, game)))
      .limit(1)
      .all();

    const stored = parseStored(row);
    const result = change(stored);
    if (result === null) return null;

    const payload = {
      user_id: userId,
      game,
      owned: JSON.stringify(stored.owned),
      worn: JSON.stringify(stored.worn),
      updated_at: new Date().toISOString()
    };

    tx.insert(cosmetics)
      .values(payload)
      .onConflictDoUpdate({
        target: [cosmetics.user_id, cosmetics.game],
        set: { owned: payload.owned, worn: payload.worn, updated_at: payload.updated_at }
      })
      .run();

    return result;
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

    /**
     * The item is claimed first, and paid for second.
     *
     * Both orders can fail badly and this is the one whose failure is survivable.
     * Charging first means a wardrobe write that does not happen leaves somebody
     * paid up with nothing to show for it and nothing to retry: the money is gone.
     * Claiming first means the worst case is an item held for the few milliseconds
     * it takes to find the wallet short, and the claim is handed straight back.
     *
     * It also settles the race. The claim is one transaction, so of two taps on
     * the same hat only the first gets past it, and only the first reaches the till.
     */
    const previouslyWorn = (await read(userId, game)).worn[item.slot];

    const claimed = mutateLocker(userId, game, (stored) => {
      if (stored.owned.includes(itemId)) return null;
      stored.owned.push(itemId);
      stored.worn[item.slot] = itemId;
      return { owned: [...stored.owned], worn: { ...stored.worn } };
    });

    if (!claimed) {
      return { ok: false, error: 'Vous possédez déjà cet article.' };
    }

    const wallet = WALLETS[game];
    const spent = await wallet.spend(wallet.key(login), item.price);

    if (!spent.ok) {
      // Unclaimed: an item that was not paid for must not survive the refusal, and
      // the slot goes back to whatever was in it before.
      mutateLocker(userId, game, (stored) => {
        stored.owned = stored.owned.filter((owned) => owned !== itemId);
        if (previouslyWorn === undefined) delete stored.worn[item.slot];
        else stored.worn[item.slot] = previouslyWorn;
        return true;
      });

      return { ok: false, error: `Il vous manque ${item.price - spent.balance} pour cet article.` };
    }

    return { ok: true, locker: { game, balance: spent.balance, owned: claimed.owned, worn: claimed.worn } };
  },

  /** Wears an owned item, or clears the slot when `itemId` is null. */
  async wear(userId: number, login: string, game: LobbyGame, slot: string, itemId: string | null): Promise<BuyResult> {
    const item = itemId === null ? null : shopItem(itemId);
    if (itemId !== null && (!item || item.game !== game || item.slot !== slot)) {
      return { ok: false, error: 'Cet article ne va pas dans cet emplacement.' };
    }

    // Ownership is tested inside the transaction, so a purchase landing at the same
    // moment cannot be read as absent and then written over.
    const worn = mutateLocker(userId, game, (stored) => {
      if (itemId === null) {
        delete stored.worn[slot];
      } else {
        if (!stored.owned.includes(itemId)) return null;
        stored.worn[slot] = itemId;
      }
      return { owned: [...stored.owned], worn: { ...stored.worn } };
    });

    if (!worn) {
      return { ok: false, error: 'Vous ne possédez pas cet article.' };
    }

    const balance = await WALLETS[game].balance(WALLETS[game].key(login));
    return { ok: true, locker: { game, balance, owned: worn.owned, worn: worn.worn } };
  }
};

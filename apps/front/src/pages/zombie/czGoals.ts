import type { CzView } from 'coronaz-core';

/**
 * Everything the team is being asked to do, as one list.
 *
 * The scenario's own goal and the drawn side quests used to live in different
 * places: the television spelled out the keys in a sentence of its own, the phone
 * showed only the first unfinished *side* quest, and so the keys, the thing that
 * actually gates the exit in an escape, appeared nowhere on the screen the player
 * is holding. One list, one order, both screens.
 */
export interface CzGoal {
  key: string;
  label: string;
  done: boolean;
  /** The main objective of the scenario, as opposed to a drawn side quest. */
  primary?: boolean;
  /** Pays score and gates nothing: a reason to take one more room, not an order. */
  optional?: boolean;
}

export function czGoals(view: CzView): CzGoal[] {
  const goals: CzGoal[] = [];

  if (view.scenario === 'escape') {
    const left = Math.max(0, view.keysTotal - view.keysCollected);
    goals.push({
      key: 'keys',
      primary: true,
      done: left === 0,
      label: left === 0 ? 'Toutes les clés sont ramassées' : `${left} clé${left > 1 ? 's' : ''} à trouver`
    });
  }

  if (view.scenario === 'purge') {
    const left = Math.max(0, view.killTarget - view.killsTotal);
    goals.push({
      key: 'purge',
      primary: true,
      done: left === 0,
      label: left === 0 ? 'Quota atteint' : `${left} victime${left > 1 ? 's' : ''} à faire`
    });
  }

  if (view.scenario === 'survival') {
    const left = Math.max(0, view.survivalTurns - view.turn);
    goals.push({
      key: 'survival',
      primary: true,
      done: left === 0,
      label: left === 0 ? 'L’extraction est là' : `Tenir ${left} tour${left > 1 ? 's' : ''}`
    });
  }

  // The drawn side quests, required first: an optional one must never look like
  // something standing between the table and the door.
  for (const objective of [...view.objectives].sort((a, b) => Number(a.optional) - Number(b.optional))) {
    goals.push({
      key: objective.id,
      done: objective.done,
      optional: objective.optional,
      label:
        (objective.optional ? '★ ' : '') +
        (objective.target > 1 && !objective.done
          ? `${objective.label} (${Math.min(objective.progress, objective.target)}/${objective.target})`
          : objective.label)
    });
  }

  // The way out, last, and only once it is actually open: in an escape the exit is
  // gated by the keys *and* by every side quest, so saying so earlier is a lie.
  if (view.scenario === 'escape') {
    goals.push({
      key: 'exit',
      primary: true,
      done: false,
      label: goals.every((goal) => goal.done || goal.optional)
        ? 'La sortie est ouverte 🚪'
        : 'Puis rejoindre la sortie'
    });
  }

  if (view.scenario === 'endless') {
    goals.push({ key: 'endless', primary: true, done: false, label: 'Personne ne sort. Marquez des points.' });
  }

  return goals;
}

/** What to shout on a small screen: the first thing still to do. */
export function czNextGoal(view: CzView): CzGoal | undefined {
  const goals = czGoals(view);
  // What is actually in the way, not what is merely worth points.
  return goals.find((goal) => !goal.done && !goal.optional) ?? goals.find((goal) => !goal.done);
}

import type { CzView } from 'coronaz-core';
import { msg, type Msg } from 'i18n';

/**
 * Everything the team is being asked to do, as one list.
 *
 * The scenario's own goal and the drawn side quests used to live in different
 * places: the television spelled out the keys in a sentence of its own, the phone
 * showed only the first unfinished *side* quest, and so the keys, the thing that
 * actually gates the exit in an escape, appeared nowhere on the screen the player
 * is holding. One list, one order, both screens.
 *
 * Every line is a `Msg`, including the ones assembled from other `Msg`s: a drawn
 * quest arrives from the server already keyed, and "★ Explore 9 rooms (4/9)" is
 * that key nested inside two more. The alternative was building the sentence here
 * with `+`, which is how a quest label became `[object Object]` the moment the
 * server stopped sending prose.
 */
export interface CzGoal {
  key: string;
  label: Msg;
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
      label: left === 0 ? msg('cz.goal.keysDone') : msg('cz.goal.keysLeft', { count: left })
    });
  }

  if (view.scenario === 'purge') {
    const left = Math.max(0, view.killTarget - view.killsTotal);
    goals.push({
      key: 'purge',
      primary: true,
      done: left === 0,
      label: left === 0 ? msg('cz.goal.quotaDone') : msg('cz.goal.killsLeft', { count: left })
    });
  }

  if (view.scenario === 'survival') {
    const left = Math.max(0, view.survivalTurns - view.turn);
    goals.push({
      key: 'survival',
      primary: true,
      done: left === 0,
      label: left === 0 ? msg('cz.goal.extractionHere') : msg('cz.goal.holdTurns', { count: left })
    });
  }

  // The drawn side quests, required first: an optional one must never look like
  // something standing between the table and the door.
  for (const objective of [...view.objectives].sort((a, b) => Number(a.optional) - Number(b.optional))) {
    const counted =
      objective.target > 1 && !objective.done
        ? msg('cz.goal.progress', {
            label: objective.label,
            done: Math.min(objective.progress, objective.target),
            target: objective.target
          })
        : objective.label;

    goals.push({
      key: objective.id,
      done: objective.done,
      optional: objective.optional,
      label: objective.optional ? msg('cz.goal.optional', { label: counted }) : counted
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
        ? msg('cz.goal.exitOpen')
        : msg('cz.goal.thenExit')
    });
  }

  if (view.scenario === 'endless') {
    goals.push({ key: 'endless', primary: true, done: false, label: msg('cz.goal.endless') });
  }

  return goals;
}

/** What to shout on a small screen: the first thing still to do. */
export function czNextGoal(view: CzView): CzGoal | undefined {
  const goals = czGoals(view);
  // What is actually in the way, not what is merely worth points.
  return goals.find((goal) => !goal.done && !goal.optional) ?? goals.find((goal) => !goal.done);
}

/**
 * Joins a class list, dropping the empty slots.
 *
 * Six components spelled `[...].filter(Boolean).join(' ')` inline, which buries
 * the interesting part — which classes apply when — under the plumbing. Falsy
 * entries are accepted so a condition can read `selected && 'is-selected'`
 * rather than padding itself with an empty string.
 *
 * Its own module rather than a second export from `ui/index.tsx`: that file is
 * components only, which is what keeps fast refresh working.
 */
export function cx(...classes: (string | false | null | undefined)[]): string {
  return classes.filter(Boolean).join(' ');
}

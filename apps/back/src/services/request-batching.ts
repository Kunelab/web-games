/**
 * Asking each question once, and many questions in one request.
 *
 * A catalogue rescoring looks up twenty thousand songs by four thousand
 * artists, and most of what a lookup asks is about the artist: their Deezer
 * fans, their Wikidata item, their Wikipedia readership. Asked song by song,
 * that is every artist's figures fetched once per song, from services that
 * want to be called slowly. These two wrappers keep the questions the same
 * and change only how they travel.
 */

/**
 * One answer per distinct question, shared by everyone who asks it.
 *
 * Kept as the promise, so callers asking at the same moment share one request
 * rather than racing to make it. A failed answer (`undefined`, which the fame
 * lookups read as "unknown") is not kept: the next caller asks again.
 */
export function remembered<A extends unknown[], R>(
  ask: (...args: A) => Promise<R>,
  keyOf: (...args: A) => string
): (...args: A) => Promise<R> {
  const answers = new Map<string, Promise<R>>();
  return (...args) => {
    const key = keyOf(...args);
    const known = answers.get(key);
    if (known) return known;
    const answer = ask(...args);
    answers.set(key, answer);
    answer.then(
      (value) => {
        if (value === undefined) answers.delete(key);
      },
      () => answers.delete(key)
    );
    return answer;
  };
}

/**
 * Single questions, gathered into requests of up to `size`, one request at a time.
 *
 * What arrives while a request is out waits for it and leaves with the next:
 * the service's own answer time is what fills a batch. A timer alone did not,
 * since questions trickle in at the pace of the services asked before this
 * one, and a forty-millisecond wait sent most batches with one key in them.
 * When nothing is out, a batch leaves once full, or `waitMs` after its first
 * question, so a lone caller is not kept waiting for company.
 *
 * `run` answers a batch with a map from key to answer, or `undefined` when the
 * request failed, which fails every question in it. A key the map lacks gets
 * `absent`: the service answered and had nothing for it.
 */
export function batched<K, V>(
  run: (keys: K[]) => Promise<Map<K, V> | undefined>,
  options: { size: number; waitMs: number; absent: V }
): (key: K) => Promise<V | undefined> {
  const pending = new Map<K, ((value: V | undefined) => void)[]>();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let out = false;

  const flush = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    if (out || pending.size === 0) return;
    const batch = new Map([...pending].slice(0, options.size));
    for (const key of batch.keys()) pending.delete(key);
    out = true;
    run([...batch.keys()])
      .then(
        (answers) => {
          for (const [key, waiting] of batch) {
            const value = answers === undefined ? undefined : answers.has(key) ? answers.get(key) : options.absent;
            for (const resolve of waiting) resolve(value);
          }
        },
        () => {
          for (const waiting of batch.values()) for (const resolve of waiting) resolve(undefined);
        }
      )
      .finally(() => {
        out = false;
        flush();
      });
  };

  return (key) =>
    new Promise((resolve) => {
      const waiting = pending.get(key);
      if (waiting) waiting.push(resolve);
      else pending.set(key, [resolve]);
      if (out) return;
      if (pending.size >= options.size) flush();
      else timer ??= setTimeout(flush, options.waitMs);
    });
}

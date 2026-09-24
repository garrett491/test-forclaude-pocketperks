/**
 * Per-request memoisation.
 *
 * The layout and the page both need the site settings and the town list.
 * Before this, every page asked the database for each of them twice. The
 * cache lives on Astro.locals, so it is created fresh for every request and
 * can never leak one visitor's data into another's.
 */
export function memo<T>(locals: App.Locals | undefined, key: string, load: () => Promise<T>): Promise<T> {
  const store = locals?.memo;
  if (!store) return load();
  if (!store.has(key)) {
    const pending = load();
    // A failed load is not remembered, so a retry within the same request
    // (rare, but possible) gets a real second attempt.
    pending.catch(() => store.delete(key));
    store.set(key, pending);
  }
  return store.get(key) as Promise<T>;
}

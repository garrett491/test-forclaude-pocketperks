import { defineMiddleware } from 'astro:middleware';
import { requireAdmin } from './lib/admin';

/**
 * Every /admin route is gated here, before any page code runs.
 *
 * This is defence in depth, not the security boundary — the boundary is RLS,
 * and an unauthenticated request that somehow reached an admin page would
 * still be unable to read or write anything. But failing closed in one place
 * means a new admin page added later is protected by default rather than by
 * the author remembering to check.
 *
 * The old site's "admin" was a `display: none` overlay behind a password
 * compared in the browser. Hiding a route is not access control.
 */
export const onRequest = defineMiddleware(async (context, next) => {
  const { pathname } = context.url;

  if (!pathname.startsWith('/admin')) return next();

  // The login page and the sign-out handler must stay reachable.
  if (pathname === '/admin/login' || pathname === '/admin/logout') return next();

  const session = await requireAdmin(context.cookies, context.request);

  if (!session) {
    const redirectTo = encodeURIComponent(pathname + context.url.search);
    return context.redirect(`/admin/login?next=${redirectTo}`, 302);
  }

  context.locals.db = session.db;
  context.locals.profile = session.profile;

  const response = await next();

  // The admin area is never cached or indexed. Both matter: a CDN-cached
  // admin page could be served to the wrong person.
  response.headers.set('Cache-Control', 'private, no-store, max-age=0');
  response.headers.set('X-Robots-Tag', 'noindex, nofollow');
  return response;
});

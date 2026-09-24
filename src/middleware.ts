import { defineMiddleware } from 'astro:middleware';
import { requireAdmin } from './lib/admin';
import { purgePublicCache } from './lib/purge';
import { getPortalSession } from './lib/portal';

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

  // Fresh for every request. See lib/memo.ts.
  context.locals.memo = new Map();

  const isAdminWrite = context.request.method === 'POST' &&
    (pathname.startsWith('/admin') || pathname.startsWith('/api/admin')) &&
    pathname !== '/admin/login' && pathname !== '/admin/logout';

  // Password pages are personal: never cached, never indexed.
  if (pathname.startsWith('/auth/')) {
    const response = await next();
    response.headers.set('Cache-Control', 'private, no-store, max-age=0');
    response.headers.set('X-Robots-Tag', 'noindex, nofollow');
    return response;
  }

  // The business portal. Same idea as /admin below: every page is closed
  // unless a business login is signed in. The database decides what that
  // login may see and propose; this only picks the page.
  if (pathname === '/portal' || pathname.startsWith('/portal/') || pathname.startsWith('/api/portal/')) {
    const open = pathname === '/portal/login' || pathname === '/portal/logout';
    let response: Response;
    if (open) {
      response = await next();
    } else {
      const { session, missing } = await getPortalSession(context.cookies, context.request);
      if (!session) {
        if (pathname.startsWith('/api/')) {
          return new Response(JSON.stringify({ message: 'Sign in again, then retry.' }), {
            status: 401, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
          });
        }
        const back = encodeURIComponent(pathname + context.url.search);
        return context.redirect(`/portal/login?next=${back}${missing ? '&unavailable=1' : ''}`, 302);
      }
      context.locals.portal = session;
      // Nothing can be sent until the person has chosen a special word.
      if (!session.me.has_secret && pathname !== '/portal/account' && !pathname.startsWith('/api/')) {
        return context.redirect('/portal/account?welcome=1', 302);
      }
      response = await next();
    }
    response.headers.set('Cache-Control', 'private, no-store, max-age=0');
    response.headers.set('X-Robots-Tag', 'noindex, nofollow');
    return response;
  }

  if (!pathname.startsWith('/admin')) {
    const response = await next();
    if (isAdminWrite && response.status < 400) await purgePublicCache();
    return response;
  }

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

  // Anything saved in the dashboard shows on the public site on the very
  // next page view, not after the CDN's cache happens to expire.
  if (isAdminWrite && response.status < 500) await purgePublicCache();

  // The admin area is never cached or indexed. Both matter: a CDN-cached
  // admin page could be served to the wrong person.
  response.headers.set('Cache-Control', 'private, no-store, max-age=0');
  response.headers.set('X-Robots-Tag', 'noindex, nofollow');
  return response;
});

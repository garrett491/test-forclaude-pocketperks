import type { APIRoute } from 'astro';
import { getAuthClient } from '../../lib/admin';

export const prerender = false;

/** POST only, like the admin sign-out. */
export const POST: APIRoute = async ({ cookies, request, redirect }) => {
  await getAuthClient(cookies, request).auth.signOut();
  return redirect('/portal/login', 303);
};

export const GET: APIRoute = ({ redirect }) => redirect('/portal/login', 302);

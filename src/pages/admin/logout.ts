import type { APIRoute } from 'astro';
import { getAuthClient } from '../../lib/admin';

export const prerender = false;

/**
 * POST only. A sign-out reachable by GET can be triggered by any image tag
 * on any site, which is a small but pointless annoyance to allow.
 */
export const POST: APIRoute = async ({ cookies, request, redirect }) => {
  const db = getAuthClient(cookies, request);
  await db.auth.signOut();
  return redirect('/admin/login', 302);
};

export const GET: APIRoute = ({ redirect }) => redirect('/admin/login', 302);

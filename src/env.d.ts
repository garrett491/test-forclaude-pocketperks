/// <reference types="astro/client" />

import type { SupabaseClient } from '@supabase/supabase-js';
import type { AdminProfile } from './lib/admin';

declare global {
  namespace App {
    interface Locals {
      db: SupabaseClient;
      profile: AdminProfile;
      /** Per-request cache. See lib/memo.ts. */
      memo: Map<string, Promise<unknown>>;
    }
  }
}

interface ImportMetaEnv {
  readonly PUBLIC_SUPABASE_URL: string;
  readonly PUBLIC_SUPABASE_ANON_KEY: string;
  readonly PUBLIC_SITE_URL: string;
  readonly PUBLIC_TURNSTILE_SITE_KEY?: string;
}
interface ImportMeta { readonly env: ImportMetaEnv; }

export {};

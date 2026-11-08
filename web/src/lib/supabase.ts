/**
 * Supabase clients. Schema: supabase/schema.sql.
 *
 * - getBrowserSupabase(): anon key, READ-ONLY by RLS (designs, calls, shares) + realtime. Safe in the browser.
 * - getServerSupabase(): service-role key, bypasses RLS. Server routes only; throws in the browser.
 *   The key is read from SUPABASE_SERVICE_ROLE_KEY (no NEXT_PUBLIC_ prefix, so Next never bundles it).
 *
 * Both return null when Supabase is not configured, so the app still runs on mock data.
 * Env (web/.env.local, never committed):
 *   NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { DesignResponse, Home, Locks } from "./types";

// ---------------------------------------------------------------------------
// Row types (match supabase/schema.sql)
// ---------------------------------------------------------------------------
export type CallStatus = "live" | "ended" | "failed" | (string & {});
export interface TranscriptTurn {
  role: "agent" | "customer" | (string & {});
  text: string;
  at?: string;
}
export interface CallRow {
  id: string;
  created_at: string;
  status: CallStatus;
  customer_name: string | null;
  address: string | null;
  facts: Partial<Home>;
  transcript: TranscriptTurn[];
  summary: string | null;
}

export type DesignSource = "voice" | "planner" | "form";
export type DesignStatus = "draft" | "review" | "sent";
export interface DesignRow {
  id: string;
  created_at: string;
  call_id: string | null;
  source: DesignSource;
  status: DesignStatus;
  customer_name: string | null;
  address: string | null;
  home: Home;
  locks: Locks;
  design: DesignResponse | null;
  explanation: string | null;
}

export interface OverrideRow {
  id: string;
  created_at: string;
  design_id: string;
  component: string; // pv | battery | wallbox | heatpump | home.<field>
  from_value: unknown;
  to_value: unknown;
  reason: string | null;
  by: string | null;
}

export interface ShareRow {
  token: string;
  design_id: string;
  allowed_variants: unknown[];
  created_at: string;
}

export type Insert<T extends { id?: string; created_at?: string }> = Omit<T, "id" | "created_at"> &
  Partial<Pick<T, "id" | "created_at">>;

export const TABLES = { calls: "calls", designs: "designs", overrides: "overrides", shares: "shares" } as const;

// ---------------------------------------------------------------------------
// Clients
// ---------------------------------------------------------------------------
const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

export const supabaseConfigured = Boolean(url && anonKey);

let browserClient: SupabaseClient | null | undefined;

/** Anon client (read + realtime). Singleton. null if Supabase env is missing. */
export function getBrowserSupabase(): SupabaseClient | null {
  if (browserClient !== undefined) return browserClient;
  browserClient = url && anonKey ? createClient(url, anonKey, { auth: { persistSession: false } }) : null;
  return browserClient;
}

/** Service-role client for server routes (all writes). null if not configured. Never call from the browser. */
export function getServerSupabase(): SupabaseClient | null {
  if (typeof window !== "undefined") {
    throw new Error("getServerSupabase() is server-only: use getBrowserSupabase() in client components.");
  }
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceKey) return null;
  return createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
}

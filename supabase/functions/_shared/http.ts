import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2";

const allowedOrigin = Deno.env.get("ADMIN_ORIGIN") ?? "*";

export const corsHeaders = {
  "Access-Control-Allow-Origin": allowedOrigin,
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

export function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: corsHeaders });
}

export function fail(message: string, status: number): Response {
  return json({ error: message }, status);
}

/**
 * Returns a client acting as the caller, or a ready error response when the
 * caller is not a signed-in admin. Queries through this client obey RLS.
 */
export async function requireAdmin(
  req: Request,
): Promise<{ client: SupabaseClient } | { error: Response }> {
  const authorization = req.headers.get("Authorization");
  if (!authorization) return { error: fail("Sign in required", 401) };

  const client = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_ANON_KEY")!,
    { global: { headers: { Authorization: authorization } } },
  );

  const token = authorization.replace(/^Bearer\s+/i, "");
  const { data: { user } } = await client.auth.getUser(token);
  if (!user) return { error: fail("Sign in required", 401) };

  const { data: isAdmin, error } = await client.rpc("is_admin");
  if (error) return { error: fail("Could not check access", 500) };
  if (!isAdmin) return { error: fail("Admin access required", 403) };

  return { client };
}

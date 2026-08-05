import { createClient, SupabaseClient } from '@supabase/supabase-js'

/**
 * Service-role client. Bypasses RLS, so this key lives ONLY in GitHub Secrets
 * and must never be shipped to the Lovable front end, which reads as the
 * signed-in user.
 */
export function echoDb(): SupabaseClient {
  const url = process.env.SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) {
    throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required')
  }
  return createClient(url, key, { auth: { persistSession: false } })
}

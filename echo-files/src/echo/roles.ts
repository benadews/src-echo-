import { SupabaseClient } from '@supabase/supabase-js'

export interface OpexPerson {
  teamworkUserId: number
  fullName: string
  email?: string | null
  roleName: string | null
}

/**
 * Roster sync. Two rules here are safety rules, not conveniences.
 *
 * 1. The roster is authoritative from OPEX, never from Teamwork. Teamwork's
 *    user list contains clients and guests alongside staff, and they read as
 *    ordinary team members through the API. Echo DMing a client to ask them to
 *    log time would be a serious incident.
 *
 * 2. Fail closed. Anyone absent from opex has is_staff = false, which means
 *    never messaged, never on the dashboard, excluded from every metric. An
 *    unmapped role resolves to 'internal', which is silent. A misconfiguration
 *    therefore produces silence rather than noise.
 *
 * Runs on EVERY sweep rather than once: people change roles, and a stale role
 * either nags someone whose work is no longer billable delivery or silently
 * ignores someone whose work now is.
 */
export async function syncRoles(db: SupabaseClient, opex: OpexPerson[]): Promise<{
  staff: number
  demoted: number
  unmapped: string[]
}> {
  const { data: map } = await db.from('echo_role_map').select('opex_role_name, role_class')
  const roleFor = new Map((map ?? []).map((r) => [r.opex_role_name, r.role_class]))
  const unmapped: string[] = []

  const inOpex = new Set<number>()
  for (const p of opex) {
    inOpex.add(p.teamworkUserId)
    const cls = (p.roleName && roleFor.get(p.roleName)) || 'internal'
    if (p.roleName && !roleFor.has(p.roleName)) unmapped.push(p.roleName)
    await db
      .from('echo_person')
      .update({
        opex_role_name: p.roleName,
        role_class: cls,
        role_synced_at: new Date().toISOString(),
        is_staff: true,
        is_external: false,
        updated_at: new Date().toISOString(),
      })
      .eq('teamwork_user_id', p.teamworkUserId)
  }

  // Anyone Echo knows about who is NOT in opex loses staff status. This is the
  // fail-closed half: a guest added to Teamwork tomorrow cannot leak in.
  const { data: all } = await db.from('echo_person').select('id, teamwork_user_id, is_staff')
  let demoted = 0
  for (const row of all ?? []) {
    if (!inOpex.has(row.teamwork_user_id) && row.is_staff) {
      await db
        .from('echo_person')
        .update({ is_staff: false, is_external: true, role_class: 'non_billable' })
        .eq('id', row.id)
      demoted++
    }
  }
  return { staff: inOpex.size, demoted, unmapped: [...new Set(unmapped)] }
}

/** Staff only, keyed by Teamwork user id. Everything downstream uses this. */
export async function staffByTeamworkId(db: SupabaseClient) {
  const { data } = await db
    .from('echo_person')
    .select('id, teamwork_user_id, full_name, role_class, is_staff')
    .eq('is_staff', true)
  return new Map((data ?? []).map((p) => [p.teamwork_user_id as number, p]))
}

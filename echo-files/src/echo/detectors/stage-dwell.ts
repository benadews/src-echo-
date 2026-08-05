import { SupabaseClient } from '@supabase/supabase-js'

/**
 * Stage dwell. Uses per-stage tolerances from echo_stage_policy rather than a
 * generic "untouched for N days", because 21 days in Assigned is healthy
 * work-in-progress while 21 days in Triage is a small fire.
 *
 * Two behaviours matter more than the detection itself:
 *
 *  - A breach in "With Client" belongs to the PROJECT MANAGER, not the
 *    assignee. A task sitting 26 days there is the client not replying;
 *    nagging the developer about it is how a bot gets muted.
 *
 *  - Legacy rows (already stale when Echo first ran) are recorded but held out
 *    of DMs. They are the amnesty cohort.
 */
export async function detectStageDwell(db: SupabaseClient): Promise<{
  breaches: number
  unestimated: number
  clientChase: number
  legacySkipped: number
  inserted: number
  errors: number
}> {
  const { data: stale, error } = await db.from('echo_v_stale_tasks').select('*')
  if (error) throw new Error(`Cannot read echo_v_stale_tasks: ${error.message}`)

  let breaches = 0, unestimated = 0, clientChase = 0, legacySkipped = 0
  let inserted = 0, errors = 0
  const today = new Date().toISOString().slice(0, 10)

  for (const t of stale ?? []) {
    // First-sight rows have an inferred entry date. Reporting them is fine;
    // messaging someone "this has been in Estimating for 64 days" when Echo does
    // not actually know that is not.
    const holdBack = t.entered_at_is_estimate === true

    // Use the view's own `unestimated` flag. An earlier version tested
    // t.stage_id, which echo_v_stale_tasks does not expose — so it was always
    // undefined and the highest-precision rule in the system never fired once.
    const kind =
      t.breach_owner === 'project_manager'
        ? 'client_chase'
        : t.unestimated
          ? 'unestimated'
          : 'stage_dwell_breach'

    breaches++
    if (t.is_legacy_backlog) legacySkipped++
    if (kind === 'client_chase') clientChase++
    if (kind === 'unestimated') unestimated++

    if (!t.assignee_person_id) continue   // unassigned: nobody to own it

    const hash = `stage:${t.stage_name}:${t.days_in_stage}`

    // Select-then-insert rather than upsert with on_conflict: the schema's
    // idempotency guard is an EXPRESSION index (coalesce on teamwork_task_id)
    // and PostgREST cannot target one with on_conflict — it errors 42P10, and
    // that error was being swallowed.
    const existing = await db
      .from('echo_finding')
      .select('id')
      .eq('person_id', t.assignee_person_id)
      .eq('work_date', today)
      .eq('kind', kind)
      .eq('teamwork_task_id', t.teamwork_task_id)
      .eq('evidence_hash', hash)
      .maybeSingle()
    if (existing.data) continue

    const r = await db.from('echo_finding').insert({
      person_id: t.assignee_person_id,
      kind,
      work_date: today,
      teamwork_task_id: t.teamwork_task_id,
      teamwork_project_id: t.teamwork_project_id,
      evidence_count: 1,
      evidence_hash: hash,
      confidence: holdBack ? 0.4 : Math.min(1, 0.6 + Number(t.severity) / 10),
      role_class_at_detect: null,
      human_summary:
        kind === 'client_chase'
          ? `${t.task_name} has been with the client ${t.days_in_stage} days — worth chasing?`
          : `${t.task_name} has been in ${t.stage_name} ${t.days_in_stage} days (target ${t.max_dwell_days})`,
    })
    if (r.error) {
      errors++
      if (errors <= 3) console.error(`stage finding insert failed (task ${t.teamwork_task_id}): ${r.error.message}`)
    } else {
      inserted++
    }
  }
  return { breaches, unestimated, clientChase, legacySkipped, inserted, errors }
}

import { SupabaseClient } from '@supabase/supabase-js'

const ESTIMATING_STAGE = 1618

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
 *  - Legacy rows (already stale when Echo first ran) are recorded but excluded
 *    from DM-eligible findings. They are the amnesty cohort.
 */
export async function detectStageDwell(db: SupabaseClient): Promise<{
  breaches: number
  unestimated: number
  clientChase: number
  legacySkipped: number
}> {
  const { data: stale } = await db.from('echo_v_stale_tasks').select('*')

  let breaches = 0, unestimated = 0, clientChase = 0, legacySkipped = 0

  for (const t of stale ?? []) {
    // First-sight rows have an inferred entry date. Reporting them is fine;
    // messaging someone "this has been in Estimating for 64 days" when Echo does
    // not actually know that is not.
    const holdBack = t.entered_at_is_estimate === true

    const kind =
      t.breach_owner === 'project_manager'
        ? 'client_chase'
        : t.stage_id === ESTIMATING_STAGE && t.unestimated
          ? 'unestimated'
          : 'stage_dwell_breach'

    if (t.is_legacy_backlog) legacySkipped++
    if (kind === 'client_chase') clientChase++
    if (kind === 'unestimated') unestimated++
    breaches++

    await db.from('echo_finding').upsert(
      {
        person_id: t.assignee_person_id,
        kind,
        work_date: new Date().toISOString().slice(0, 10),
        teamwork_task_id: t.teamwork_task_id,
        teamwork_project_id: t.teamwork_project_id,
        evidence_count: 1,
        evidence_hash: `stage:${t.stage_id}:${t.days_in_stage}`,
        // Severity, not age: a 4-day Estimating task (target 3) outranks a
        // 25-day Assigned one (target 21).
        confidence: holdBack ? 0.4 : Math.min(1, 0.6 + Number(t.severity) / 10),
        role_class_at_detect: null,
        human_summary:
          kind === 'client_chase'
            ? `${t.task_name} has been with the client ${t.days_in_stage} days — worth chasing?`
            : `${t.task_name} has been in ${t.stage_name} ${t.days_in_stage} days (target ${t.max_dwell_days})`,
      },
      { onConflict: 'person_id,work_date,kind,teamwork_task_id,evidence_hash', ignoreDuplicates: true },
    )
  }
  return { breaches, unestimated, clientChase, legacySkipped }
}

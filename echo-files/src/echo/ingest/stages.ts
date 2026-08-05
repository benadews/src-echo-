import { SupabaseClient } from '@supabase/supabase-js'
import { TeamworkApi } from '../lib/teamwork'

/**
 * Stage-history snapshotter — the heaviest piece of the build, and unavoidable.
 *
 * Teamwork does NOT expose when a task entered its current stage. `get_task`
 * returns workflowStages: [{stageId, workflowId}] and an `updatedAt` that moves
 * on any edit, so updatedAt cannot measure dwell time. Echo therefore records
 * stage per open task on every sweep and maintains its own history.
 *
 * First sight of a task mid-life has no history, so entered_at is seeded from
 * updatedAt and flagged entered_at_is_estimate. Those rows are held out of DMs
 * for the first week — otherwise Echo opens with "this has been in Estimating
 * for 64 days" when it does not actually know that.
 */
export async function snapshotStages(
  db: SupabaseClient,
  api: TeamworkApi,
  staff: Map<number, { id: string }>,
  opts: { seedLegacy: boolean },
): Promise<{ scanned: number; opened: number; moved: number; legacy: number }> {
  const tasks = await api.openTasks()
  const { data: openRows } = await db
    .from('echo_task_stage_history')
    .select('id, teamwork_task_id, stage_id, entered_at')
    .is('exited_at', null)
  const current = new Map((openRows ?? []).map((r) => [r.teamwork_task_id as number, r]))

  const { data: policy } = await db.from('echo_stage_policy').select('workflow_id, stage_id, max_dwell_days')
  const tol = new Map((policy ?? []).map((p) => [`${p.workflow_id}|${p.stage_id}`, p.max_dwell_days as number]))

  let opened = 0, moved = 0, legacy = 0
  const now = new Date().toISOString()

  for (const t of tasks) {
    const ws = t.workflowStages?.[0]
    if (!ws) continue
    const existing = current.get(t.id)
    if (existing && existing.stage_id === ws.stageId) continue

    if (existing) {
      await db.from('echo_task_stage_history').update({ exited_at: now }).eq('id', existing.id)
      moved++
    }

    // On the very first sweep, anything ALREADY past its stage tolerance is the
    // legacy cohort: excluded from recognition metrics and the no-progress
    // alarm, surfaced one item at a time, measured on direction of travel.
    // Without this everyone starts in the red and Echo's first message to Chris
    // is about 110 items that cannot be fixed this week.
    const enteredAt = existing ? now : t.updatedAt
    const isEstimate = !existing
    let isLegacy = false
    if (opts.seedLegacy && isEstimate) {
      const limit = tol.get(`${ws.workflowId}|${ws.stageId}`)
      if (limit != null) {
        const days = (Date.now() - new Date(t.updatedAt).getTime()) / 86_400_000
        isLegacy = days > limit
        if (isLegacy) legacy++
      }
    }

    await db.from('echo_task_stage_history').insert({
      teamwork_task_id: t.id,
      workflow_id: ws.workflowId,
      stage_id: ws.stageId,
      entered_at: enteredAt,
      entered_at_is_estimate: isEstimate,
      is_legacy_backlog: isLegacy,
      assignee_person_id: staff.get(t.assignees?.[0]?.id ?? -1)?.id ?? null,
      task_name: t.name,
      estimate_minutes: t.estimateMinutes,
    })
    opened++
  }
  return { scanned: tasks.length, opened, moved, legacy }
}

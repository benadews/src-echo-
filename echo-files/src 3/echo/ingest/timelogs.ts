import { SupabaseClient } from '@supabase/supabase-js'
import { TeamworkApi } from '../lib/teamwork'
import { londonDay } from '../lib/dates'
import { chunks } from './activities'

/** Marker Echo appends to descriptions of logs it helped create. */
export const ECHO_MARKER = '[sw]'

export async function ingestTimelogs(
  db: SupabaseClient,
  api: TeamworkApi,
  staff: Map<number, { id: string }>,
  fromDay: string,
  toDay: string,
): Promise<{ fetched: number; cached: number }> {
  const raw = await api.timelogs({ start: fromDay, end: toDay })

  const rows = raw
    .filter((t) => staff.has(t.userId))
    .map((t) => ({
      teamwork_timelog_id: t.id,
      person_id: staff.get(t.userId)!.id,
      // ALWAYS timeLogged, never createdAt, and never a summary endpoint's idea
      // of the day. Verified on live data: summarize_timelogs and list_timelogs
      // disagree about which day a backdated log belongs to (a 62-minute log
      // created 5 Aug for work at 13:04 on 4 Aug was excluded from the 4th's
      // total by one endpoint and included by the other). Echo's whole premise
      // is comparing day X against day X, so Echo derives the day itself.
      work_date: londonDay(t.timeLogged),
      minutes: t.minutes,
      teamwork_project_id: t.projectId,
      teamwork_task_id: t.taskId,
      description: t.description,
      is_billable: t.isBillable,
      is_locked: t.isLocked,
      // Echo must never treat its own output as independent evidence, or it
      // detects itself in a loop.
      created_by_echo: (t.description ?? '').includes(ECHO_MARKER),
      logged_at: t.timeLogged,
      created_at_tw: t.createdAt,
      synced_at: new Date().toISOString(),
    }))

  let cached = 0
  for (const chunk of chunks(rows, 500)) {
    const { count } = await db
      .from('echo_timelog_cache')
      .upsert(chunk, { onConflict: 'teamwork_timelog_id', count: 'exact' })
    cached += count ?? 0
  }
  return { fetched: raw.length, cached }
}

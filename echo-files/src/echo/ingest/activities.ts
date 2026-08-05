import { SupabaseClient } from '@supabase/supabase-js'
import { Activity, TeamworkApi } from '../lib/teamwork'
import { londonDay } from '../lib/dates'

/** Activity types that count as tier A evidence — the person acted, visibly. */
const EVIDENCE_TYPES = new Set([
  'task', 'task_comment', 'comment', 'milestone', 'file',
  'notebook', 'notebook_comment', 'file_comment', 'link', 'projectUpdate',
])

/**
 * Minutes an activity can justify on its own. Tier A/B only — and note nothing
 * here is ever shown to a person as a suggested duration. Echo does not
 * estimate; the person supplies the number. These values exist only to order
 * evidence by weight.
 */
function weight(a: Activity): number | null {
  if (a.activityType === 'completed') return 60
  if (a.type.endsWith('comment')) return 30
  return 15
}

export async function ingestActivities(
  db: SupabaseClient,
  api: TeamworkApi,
  staff: Map<number, { id: string }>,
  fromDay: string,
  toDay: string,
): Promise<{ fetched: number; deduped: number; inserted: number }> {
  // The server-side date filter is unreliable, so widen the request and filter
  // on dateTime here. Verified: a query for 4 Aug returns 5 Aug rows.
  const raw = await api.activities({ start: fromDay, end: toDay })

  const rows: Record<string, unknown>[] = []
  const seen = new Set<string>()

  for (const a of raw) {
    const day = londonDay(a.dateTime)
    if (day < fromDay || day > toDay) continue
    if (!a.userId || !staff.has(a.userId)) continue
    if (!EVIDENCE_TYPES.has(a.type)) continue
    if (a.itemId == null) continue
    // A reaction is not evidence of anything. An emoji is how people
    // acknowledge without acting — the opposite of the signal Echo wants.
    if (a.activityType === 'reacted') continue

    // Teamwork emits the same comment repeatedly as separate activity rows —
    // one 'new', then an 'edited' row per revision — with different activity
    // ids but the same itemId. Measured on live data: 55 of 303 rows, 18%.
    // Keying on the ITEM and the DAY collapses the twins while still letting an
    // item genuinely worked on across two days count once on each.
    const key = `tw_activity|${a.itemId}|${day}`
    if (seen.has(key)) continue
    seen.add(key)

    rows.push({
      person_id: staff.get(a.userId)!.id,
      tier: 'A',
      source: 'tw_activity',
      source_item_id: String(a.itemId),
      // Composite: what happened AND to what. Stored because two confirmed
      // false positives (13 task edits in 6 minutes; 25 task edits spread over
      // an afternoon) were both task admin, and were indistinguishable from
      // client comments without this. No schema change needed — the column was
      // free-form text and only ever tested for 'completed'.
      source_activity_type: `${a.activityType}:${a.type}`,
      occurred_at: a.dateTime,
      work_date: day,
      teamwork_project_id: a.projectId,
      teamwork_task_id: taskIdFromLink(a.link),
      summary: (a.extraDescription || a.description || '').trim().slice(0, 500) || null,
      url: a.link ? `${process.env.TEAMWORK_BASE_URL ?? ''}/app/${a.link}` : null,
      suggested_minutes: weight(a),
    })
  }

  // on_conflict ignore is REQUIRED, not defensive: the unique key is
  // (source, source_item_id, work_date) and every sweep re-sees recent items.
  let inserted = 0
  for (const chunk of chunks(rows, 500)) {
    const { count } = await db
      .from('echo_evidence')
      .upsert(chunk, { onConflict: 'source,source_item_id,work_date', ignoreDuplicates: true, count: 'exact' })
    inserted += count ?? 0
  }
  return { fetched: raw.length, deduped: rows.length, inserted }
}

export function taskIdFromLink(link: string | null): number | null {
  const m = (link ?? '').match(/tasks\/(\d+)/)
  return m ? Number(m[1]) : null
}

export function chunks<T>(arr: T[], n: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n))
  return out
}

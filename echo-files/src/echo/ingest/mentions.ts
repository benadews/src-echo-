import { SupabaseClient } from '@supabase/supabase-js'
import { Activity } from '../lib/teamwork'
import { taskIdFromLink } from './activities'

/**
 * Slack/Teamwork @handle -> Teamwork user id.
 *
 * Kept as data rather than inferred, because handles do not derive reliably
 * from names. Extend when someone joins; an unknown handle is simply ignored,
 * which is the safe failure.
 */
export const HANDLES: Record<string, number> = {
  chrisl: 289232,
  bend: 289234,
  davidf: 289262,
  jeremiaha: 291383,
  charlied: 292414,
  harryk: 293154,
  stephans: 293914,
}

/**
 * Who was actually ASKED in this comment.
 *
 * `meta.notifiedUserIds` alone is NOT the answer, and this was the single
 * biggest correction the dry run produced. notifiedUserIds is everyone
 * *notified* — which includes task followers and watchers. Measured on live
 * data: trusting it gave 94 unanswered mentions over three days; intersecting
 * with @handles parsed from the body gave 53. 41 of them (44%) were people
 * merely copied in.
 *
 * WTF's own convention, confirmed by Ben: if you are not @mentioned on a task,
 * you do not need to act on it. So the rule is the INTERSECTION —
 * notified tells you they could have seen it, the @handle tells you they were
 * asked. Both, never either.
 */
export function askedIn(a: Activity): number[] {
  const notified = new Set(a.meta?.notifiedUserIds ?? [])
  if (notified.size === 0) return []
  const body = a.description ?? ''
  const tagged = new Set<number>()
  for (const m of body.matchAll(/@([A-Za-z][A-Za-z0-9_.-]*)/g)) {
    const id = HANDLES[m[1].toLowerCase()]
    if (id) tagged.add(id)
  }
  return [...tagged].filter((id) => notified.has(id) && id !== a.userId)
}

export async function ingestMentions(
  db: SupabaseClient,
  acts: Activity[],
  staff: Map<number, { id: string }>,
): Promise<{ created: number; answered: number }> {
  const byTask = new Map<number, Activity[]>()
  for (const a of acts) {
    const t = taskIdFromLink(a.link)
    if (t) (byTask.get(t) ?? byTask.set(t, []).get(t)!).push(a)
  }

  const rows: Record<string, unknown>[] = []
  for (const a of acts) {
    if (!a.type.endsWith('comment')) continue
    const taskId = taskIdFromLink(a.link)
    if (!taskId) continue
    for (const uid of askedIn(a)) {
      const person = staff.get(uid)
      if (!person) continue
      rows.push({
        teamwork_task_id: taskId,
        comment_item_id: String(a.itemId),
        mentioned_person_id: person.id,
        mentioned_by_person_id: staff.get(a.userId ?? -1)?.id ?? null,
        mentioned_at: a.dateTime,
        comment_excerpt: (a.description ?? '').trim().slice(0, 300),
        url: a.link ? `${process.env.TEAMWORK_BASE_URL ?? ''}/app/${a.link}` : null,
      })
    }
  }

  const { count: created } = await db
    .from('echo_mention')
    .upsert(rows, {
      onConflict: 'comment_item_id,mentioned_person_id',
      ignoreDuplicates: true,
      count: 'exact',
    })

  // Close anything the person has since acted on. "Acted on" is deliberately
  // broad — a comment, a stage move, an estimate, a timelog, a completion all
  // count. Echo is asking "did this get picked up?", not "did you reply
  // politely". A reaction alone does NOT count: a thumbs-up is how people
  // acknowledge without acting, and this detector exists to catch that.
  let answered = 0
  const { data: open } = await db
    .from('echo_mention')
    .select('id, teamwork_task_id, mentioned_person_id, mentioned_at')
    .is('answered_at', null)

  const personToTw = new Map<string, number>()
  for (const [tw, p] of staff) personToTw.set((p as { id: string }).id, tw)

  for (const m of open ?? []) {
    const tw = personToTw.get(m.mentioned_person_id as string)
    if (!tw) continue
    const acted = (byTask.get(m.teamwork_task_id as number) ?? []).some(
      (x) => x.userId === tw && x.dateTime > (m.mentioned_at as string),
    )
    if (acted) {
      await db
        .from('echo_mention')
        .update({ answered_at: new Date().toISOString(), answer_kind: 'activity_on_task' })
        .eq('id', m.id)
      answered++
    }
  }
  return { created: created ?? 0, answered }
}

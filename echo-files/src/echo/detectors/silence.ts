import { SupabaseClient } from '@supabase/supabase-js'
import { londonDay } from '../lib/dates'

/**
 * Silence detector — looks for the ABSENCE of activity rather than its presence.
 *
 * Every other detector needs a signal to react to, which means the person doing
 * the least recording is the one Echo is quietest about. That is exactly
 * backwards, and Stephan is the case that exposed it: 17 open tasks assigned,
 * and in a fortnight zero comments, zero task updates, zero time. Real design
 * work happening in Figma, reported verbally, invisible to Teamwork and
 * therefore invisible to Echo.
 *
 * The rule: has open assigned work, no activity and no time recorded for a
 * week, not on leave, past the onboarding grace.
 *
 * Phrased as a question, never an accusation. "Nothing's come through" is a
 * statement about the record, not about the person — and the answer is useful
 * either way: if they are working, the record is wrong; if they are blocked, you
 * find out sooner than you otherwise would.
 */
export async function detectSilence(
  db: SupabaseClient,
  silenceDays: number,
): Promise<{ checked: number; silent: number; raised: number }> {
  const today = londonDay(new Date())
  const since = londonDay(new Date(Date.now() - silenceDays * 86_400_000))

  const { data: people, error } = await db
    .from('echo_person')
    .select('id, full_name, role_class, onboarded_at')
    .eq('is_staff', true)
  if (error) throw new Error(`Cannot read echo_person: ${error.message}`)

  const { data: policies } = await db
    .from('echo_role_policy')
    .select('role_class, dm_enabled')
  const dmEnabled = new Map((policies ?? []).map((p) => [p.role_class, p.dm_enabled]))

  // Re-ask weekly rather than daily: the hash carries the week, so a person who
  // stays silent is asked once a week, not pestered every afternoon.
  const weekStart = mondayOf(today)

  let checked = 0, silent = 0, raised = 0

  for (const p of people ?? []) {
    // Internal and non-billable roles are not asked anything, so there is
    // nothing to raise for them.
    if (!dmEnabled.get(p.role_class)) continue
    checked++

    // Must have open assigned work, or silence means nothing.
    const openTasks = await db
      .from('echo_task_stage_history')
      .select('teamwork_task_id', { count: 'exact', head: true })
      .eq('assignee_person_id', p.id)
      .is('exited_at', null)
      .is('cleared_at', null)
    const taskCount = openTasks.count ?? 0
    if (taskCount === 0) continue

    const recentEvidence = await db
      .from('echo_evidence')
      .select('id', { count: 'exact', head: true })
      .eq('person_id', p.id)
      .gte('work_date', since)
    if ((recentEvidence.count ?? 0) > 0) continue

    const recentTime = await db
      .from('echo_timelog_cache')
      .select('teamwork_timelog_id', { count: 'exact', head: true })
      .eq('person_id', p.id)
      .gte('work_date', since)
    if ((recentTime.count ?? 0) > 0) continue

    // Away is not silent.
    const away = await db.rpc('echo_is_away', { p_person: p.id, p_date: today })
    if (away.data === true) continue

    // A new starter has not gone quiet; they have not started.
    if (p.onboarded_at) {
      const graceEnd = new Date(new Date(p.onboarded_at as string).getTime() + 14 * 86_400_000)
      if (new Date() < graceEnd) continue
    }

    silent++

    const hash = `silent:${weekStart}`
    const existing = await db
      .from('echo_finding')
      .select('id')
      .eq('person_id', p.id)
      .eq('kind', 'silent')
      .eq('evidence_hash', hash)
      .maybeSingle()
    if (existing.data) continue

    const r = await db.from('echo_finding').insert({
      person_id: p.id,
      kind: 'silent',
      work_date: today,
      evidence_count: 0,
      logged_minutes: 0,
      evidence_hash: hash,
      // Deliberately mid-range. Echo is confident the RECORD is empty; it has no
      // idea whether the person is working, which is the whole reason it asks.
      confidence: 0.6,
      role_class_at_detect: p.role_class,
      human_summary:
        `No Teamwork activity or time recorded in ${silenceDays} days, ` +
        `with ${taskCount} open task${taskCount === 1 ? '' : 's'} assigned`,
    })
    if (r.error) {
      console.error(`silence finding failed for ${p.full_name}: ${r.error.message}`)
      continue
    }
    raised++
    console.log(`silent: ${p.full_name} (${taskCount} open tasks, nothing for ${silenceDays} days)`)
  }
  return { checked, silent, raised }
}

function mondayOf(day: string): string {
  const d = new Date(`${day}T12:00:00Z`)
  const dow = d.getUTCDay() === 0 ? 7 : d.getUTCDay()
  d.setUTCDate(d.getUTCDate() - (dow - 1))
  return d.toISOString().slice(0, 10)
}

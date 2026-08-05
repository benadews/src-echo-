import { SupabaseClient } from '@supabase/supabase-js'
import { isWeekend } from '../lib/dates'
import { chunks } from '../ingest/activities'

const SESSION_GAP_MS = 20 * 60 * 1000
const MIN_SPAN_MINUTES = 30

interface Ev {
  person_id: string
  work_date: string
  occurred_at: string
  source_item_id: string
  teamwork_project_id: number | null
  source_activity_type: string | null
  summary: string | null
}

/**
 * Cluster a day's signals into work sessions.
 *
 * Raw signal count is not enough and the dry run proved it: on 4 August one
 * person produced 6 signals inside 12 minutes — a single bulk action, almost
 * certainly creating a batch of tasks — and raw counting called that a busy
 * day. Requiring either 2+ sessions or a 30+ minute span suppressed 3 of 7
 * candidate findings, all correctly.
 */
export function sessionShape(times: string[]): { sessions: number; spanMinutes: number } {
  const ts = times.map((t) => new Date(t).getTime()).sort((a, b) => a - b)
  let sessions = 1
  for (let i = 1; i < ts.length; i++) {
    if (ts[i] - ts[i - 1] > SESSION_GAP_MS) sessions++
  }
  return { sessions, spanMinutes: (ts[ts.length - 1] - ts[0]) / 60000 }
}

export async function detectActiveDays(
  db: SupabaseClient,
  fromDay: string,
  toDay: string,
): Promise<{ evaluated: number; raised: number; suppressed: number }> {
  const { data: people } = await db
    .from('echo_person')
    .select('id, full_name, role_class')
    .eq('is_staff', true)
  const { data: policies } = await db.from('echo_role_policy').select('*')
  const pol = new Map((policies ?? []).map((p) => [p.role_class, p]))

  const { data: evidence } = await db
    .from('echo_evidence')
    .select('person_id, work_date, occurred_at, source_item_id, teamwork_project_id, source_activity_type, summary')
    .gte('work_date', fromDay)
    .lte('work_date', toDay)
    .in('tier', ['A', 'B'])

  const { data: logs } = await db
    .from('echo_timelog_cache')
    .select('person_id, work_date, minutes, teamwork_project_id, is_locked, created_by_echo')
    .gte('work_date', fromDay)
    .lte('work_date', toDay)

  const dayMins = new Map<string, number>()
  const projMins = new Map<string, number>()
  const locked = new Set<string>()
  for (const l of logs ?? []) {
    const dk = `${l.person_id}|${l.work_date}`
    const pk = `${dk}|${l.teamwork_project_id}`
    dayMins.set(dk, (dayMins.get(dk) ?? 0) + (l.minutes as number))
    projMins.set(pk, (projMins.get(pk) ?? 0) + (l.minutes as number))
    // Invoiced time must never be modified, so never raise a finding against it.
    if (l.is_locked) locked.add(dk)
  }

  const grouped = new Map<string, Ev[]>()
  for (const e of (evidence ?? []) as Ev[]) {
    const k = `${e.person_id}|${e.work_date}`
    ;(grouped.get(k) ?? grouped.set(k, []).get(k)!).push(e)
  }

  let evaluated = 0, raised = 0, suppressed = 0

  for (const [key, rows] of grouped) {
    const [personId, day] = key.split('|')
    const person = (people ?? []).find((p) => p.id === personId)
    if (!person) continue
    const policy = pol.get(person.role_class)
    if (!policy) continue
    evaluated++

    // Suppressions, in order of cheapness.
    if (locked.has(key)) { suppressed++; continue }
    const { data: away } = await db.rpc('echo_is_away', { p_person: personId, p_date: day })
    if (away === true) { suppressed++; continue }

    const shape = sessionShape(rows.map((r) => r.occurred_at))
    if (shape.sessions < 2 && shape.spanMinutes < MIN_SPAN_MINUTES) { suppressed++; continue }

    // Someone working a Saturday should be credited, not chased — but a weekend
    // with real, spread-out activity is still a day worth asking about.
    if (isWeekend(day) && rows.length < policy.min_signals * 2) { suppressed++; continue }

    const minsToday = dayMins.get(key) ?? 0
    const byProject = new Map<number, Ev[]>()
    for (const r of rows) {
      if (r.teamwork_project_id == null) continue
      const pid = r.teamwork_project_id
      ;(byProject.get(pid) ?? byProject.set(pid, []).get(pid)!).push(r)
    }

    const completed = rows.filter((r) => r.source_activity_type === 'completed')
    let kind: string | null = null

    if (minsToday === 0 && rows.length >= policy.min_signals) {
      kind = 'active_day_unlogged'
    } else if (minsToday > 0) {
      // The quietly valuable rule: time recorded somewhere, but a busy project
      // got none of it. Invisible on any total-hours report.
      const untouched = [...byProject.entries()].filter(
        ([pid, evs]) => evs.length >= policy.min_signals && (projMins.get(`${key}|${pid}`) ?? 0) === 0,
      )
      if (untouched.length) kind = 'active_day_partial'
    }
    if (!kind) continue

    // Echo asserts nothing about duration, so there is no suggested_minutes.
    let confidence = 0.5 + (completed.length ? 0.3 : 0) + (policy.confidence_bonus ?? 0)
    confidence = Math.max(0, Math.min(1, confidence))

    const ranked = [...byProject.entries()].sort((a, b) => b[1].length - a[1].length)
    const hash = hashOf(rows.map((r) => r.source_item_id).sort())

    // Select-then-insert rather than upsert with on_conflict. The idempotency
    // guard in the schema is an EXPRESSION index (it wraps teamwork_task_id in
    // coalesce), and PostgREST cannot target an expression index with
    // on_conflict — it errors with 42P10. That error was being swallowed, which
    // is why the first run reported 28 candidates and 0 findings raised.
    const existing = await db
      .from('echo_finding')
      .select('id')
      .eq('person_id', personId)
      .eq('work_date', day)
      .eq('kind', kind)
      .eq('evidence_hash', hash)
      .maybeSingle()
    if (existing.data) continue

    const { data: finding, error } = await db
      .from('echo_finding')
      .insert({
        person_id: personId,
        kind,
        work_date: day,
        logged_minutes: minsToday,
        evidence_count: rows.length,
        project_count: byProject.size,
        has_completed_task: completed.length > 0,
        role_class_at_detect: person.role_class,
        evidence_hash: hash,
        confidence,
        human_summary: summarise(rows.length, completed, ranked.length),
      })
      .select('id')
      .maybeSingle()

    if (error) {
      console.error(`finding insert failed for ${person.full_name} ${day}: ${error.message}`)
      continue
    }
    if (!finding) continue
    raised++

    // The ranked project breakdown IS the content of the nudge.
    const kids = ranked.map(([pid, evs]) => {
      const shape2 = sessionShape(evs.map((e) => e.occurred_at))
      return {
        finding_id: finding.id,
        teamwork_project_id: pid,
        signal_count: evs.length,
        first_signal_at: evs.reduce((a, b) => (a.occurred_at < b.occurred_at ? a : b)).occurred_at,
        last_signal_at: evs.reduce((a, b) => (a.occurred_at > b.occurred_at ? a : b)).occurred_at,
        logged_minutes: projMins.get(`${key}|${pid}`) ?? 0,
        has_completed_task: evs.some((e) => e.source_activity_type === 'completed'),
        session_count: shape2.sessions,
      }
    })
    for (const c of chunks(kids, 200)) {
      const r = await db
        .from('echo_finding_project')
        .insert(c.map(({ session_count, ...rest }) => rest))
      if (r.error) console.error(`finding_project insert failed: ${r.error.message}`)
    }
  }
  return { evaluated, raised, suppressed }
}

function summarise(signals: number, completed: Ev[], projects: number): string {
  const parts: string[] = []
  // A completed task by its own assignee is the strongest signal in the system,
  // so it is named first.
  if (completed.length) {
    parts.push(`Completed ${completed.length === 1 ? '' : `${completed.length} tasks including `}${completed[0].summary ?? 'a task'}`)
  }
  parts.push(`${signals} update${signals === 1 ? '' : 's'} across ${projects} project${projects === 1 ? '' : 's'}`)
  return parts.join(', ')
}

function hashOf(items: string[]): string {
  let h = 0
  for (const s of items.join(',')) h = (Math.imul(31, h) + s.charCodeAt(0)) | 0
  return `e${(h >>> 0).toString(36)}`
}

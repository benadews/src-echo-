import { echoDb } from './lib/supabase'
import { sendDm } from './lib/slack'
import { assertNoPronouns } from './copy'
import { londonDay } from './lib/dates'

/**
 * The alarm bell (spec section 7).
 *
 * Echo stops copying admins in by default. They hear about someone only when
 * Echo has genuinely stopped getting anywhere over a rolling 14 days.
 *
 * Four outcomes, and only two of them reach an admin:
 *
 *   blocked_dependency     answers are mostly "waiting on X" -> raise the
 *                          DEPENDENCY, never a mark against the person waiting
 *   ease_off               ignoring Echo but clearing work and recording time
 *                          -> reduce cadence, tell nobody. Echo being redundant
 *                          for someone is a success, not a failure.
 *   disengaged             not reading Echo AND nothing moving -> tell admins
 *   responding_not_moving  answering every time, clearing nothing -> tell admins
 *
 * That third and fourth pair is the point: the person Echo escalates is the one
 * who replies politely and clears nothing, not the one who ignores it while
 * getting on with the job.
 *
 * ROUTING: every escalation goes to every super admin, including the person it
 * is about. There is no back-channel — nothing is said about someone that is
 * not also said to them. When the recipient is the subject the copy switches to
 * second person; the facts and the trigger are identical either way.
 */

const WINDOW_DAYS = 14

// How long Echo stays quiet on an escalated backlog. This was previously null,
// which read as "until an admin releases it" — but nothing in this file or in
// nudge ever released it, and echo_may_message() blocks on any open escalation.
// The effect was a permanent, silent mute that could only be cleared by hand in
// Supabase. An expiry matching the evaluation window gives a fortnight for the
// conversation to happen and then lets Echo resume on its own.
const SUPPRESS_DAYS = 14

type Admin = { id: string; full_name: string; slack_user_id: string | null }

async function main() {
  const db = echoDb()
  const dryRun = process.env.ECHO_DRY_RUN === 'true'

  const cfg = await db.from('echo_config').select('*').eq('id', 1).maybeSingle()
  if (cfg.error) throw new Error(`Cannot read echo_config: ${cfg.error.message}`)

  const today = londonDay(new Date())
  const windowStart = londonDay(new Date(Date.now() - WINDOW_DAYS * 86_400_000))
  const suppressUntil = londonDay(new Date(Date.now() + SUPPRESS_DAYS * 86_400_000))

  // Resolved once, up front. Previously this used .maybeSingle(), which errors
  // on more than one row — so the day a second super admin was added, the query
  // returned an error, the error was never destructured, admin came back null,
  // and every escalation silently went nowhere while the job still reported
  // success. Fetch the list, check it, and fail loudly if it is empty.
  const adminQ = await db
    .from('echo_person')
    .select('id, full_name, slack_user_id')
    .eq('is_super_admin', true)
  if (adminQ.error) throw new Error(`Cannot read super admins: ${adminQ.error.message}`)

  const admins = (adminQ.data ?? []) as Admin[]
  if (!admins.length) {
    console.log('No super admins found — nothing can be escalated to anyone. Stopping.')
    return
  }
  const unreachable = admins.filter((a) => !a.slack_user_id)
  for (const a of unreachable) {
    console.log(`WARNING: ${a.full_name} is a super admin with no Slack id — will not receive escalations.`)
  }
  console.log(`${admins.length} super admin(s): ${admins.map((a) => a.full_name).join(', ')}`)

  // 1. Build this window's progress row for every member of staff. Nothing else
  //    writes these, so the alarm bell has nothing to evaluate without it.
  const { data: people, error } = await db
    .from('echo_person')
    .select('id, full_name, role_class')
    .eq('is_staff', true)
  if (error) throw new Error(`Cannot read echo_person: ${error.message}`)

  for (const p of people ?? []) {
    const asks = await db
      .from('echo_nudge')
      .select('id, responded_at, response', { count: 'exact' })
      .eq('person_id', p.id)
      .eq('channel', 'slack_dm')
      .gte('sent_at', `${windowStart}T00:00:00Z`)

    const rows = asks.data ?? []
    const answered = rows.filter((r) => r.responded_at).length
    const blocked = rows.filter((r) => r.response === 'blocked').length

    const resolved = await db
      .from('echo_finding')
      .select('id', { count: 'exact', head: true })
      .eq('person_id', p.id)
      .in('resolution', ['logged', 'nothing_to_log', 'mostly_internal', 'already_covered'])
      .gte('resolved_at', `${windowStart}T00:00:00Z`)

    const cleared = await db
      .from('echo_task_stage_history')
      .select('id', { count: 'exact', head: true })
      .eq('assignee_person_id', p.id)
      .not('cleared_at', 'is', null)
      .gte('cleared_at', `${windowStart}T00:00:00Z`)

    const mins = await db
      .from('echo_timelog_cache')
      .select('minutes')
      .eq('person_id', p.id)
      .gte('work_date', windowStart)
    const minutes = (mins.data ?? []).reduce((a, r) => a + (r.minutes as number), 0)

    const legacyOpen = await db
      .from('echo_v_stale_tasks')
      .select('teamwork_task_id', { count: 'exact', head: true })
      .eq('assignee_person_id', p.id)
      .eq('is_legacy_backlog', true)

    await db.from('echo_progress').upsert({
      person_id: p.id,
      window_start: windowStart,
      window_end: today,
      legacy_open_end: legacyOpen.count ?? 0,
      legacy_cleared: cleared.count ?? 0,
      asks_made: asks.count ?? 0,
      asks_answered: answered,
      answers_blocked: blocked,
      items_resolved: resolved.count ?? 0,
      time_recorded_minutes: minutes,
    }, { onConflict: 'person_id,window_start,window_end' })
  }

  // 2. Is Echo itself the problem? If most of the team has stopped answering,
  //    no individual conversation is the right response, and Echo should say so
  //    rather than generating six escalations that look like a people problem.
  const health = await db.from('echo_v_echo_health').select('*').maybeSingle()
  if (health.data?.echo_is_the_problem) {
    const msg =
      `*${health.data.not_engaging} of ${health.data.evaluated} people have stopped answering Echo.*\n\n` +
      `That is Echo, not the team. Recommend pausing nudges and reviewing the copy and ` +
      `thresholds before this trains everyone to ignore it.`
    assertNoPronouns(msg)
    await notifyAdmins(admins, dryRun, () => msg)
    console.log('ECHO_NOT_WORKING raised; individual escalations suppressed.')
    return
  }

  // 3. Individual outcomes.
  const due = await db.from('echo_v_escalation_due').select('*')
  if (due.error) throw new Error(`Cannot read echo_v_escalation_due: ${due.error.message}`)

  let raised = 0, easedOff = 0, blockers = 0
  for (const d of due.data ?? []) {
    if (d.action === 'none') continue

    if (d.action === 'ease_off') {
      // Not a problem to bring an admin. Reduce the cadence and stay quiet.
      easedOff++
      console.log(`${d.full_name}: ease_off — ignoring Echo but doing the work. Nobody told.`)
      continue
    }

    if (d.action === 'raise_blocker') {
      blockers++
      console.log(`${d.full_name}: blocked on someone — dependency, not a personal issue.`)
      continue
    }

    // Stored canonically in the third person. Rendering per recipient happens
    // below; the database keeps one version of the facts.
    const diagnosis =
      d.kind === 'disengaged'
        ? `${d.asks_made} asks over ${WINDOW_DAYS} days, ${d.asks_answered} answered, nothing cleared. ` +
          `Time recorded is ${d.making_progress ? 'steady' : 'flat'} too.`
        : `${d.asks_answered} of ${d.asks_made} asks answered, but nothing cleared and no time recorded.`

    const suggestion =
      d.kind === 'disengaged'
        ? `Most likely too much in the queue to engage with any of it, or the asks aren't landing. ` +
          `A triage session rather than more nudges.`
        : `Answering every time and clearing nothing usually means blocked or underwater — worth asking directly.`

    const ins = await db.from('echo_escalation').insert({
      kind: d.kind,
      person_id: d.person_id,
      window_start: d.window_start,
      window_end: d.window_end,
      asks_made: d.asks_made,
      asks_answered: d.asks_answered,
      items_resolved: d.items_resolved,
      diagnosis,
      suggestion,
      suppresses_until: suppressUntil,
    })
    if (ins.error) { console.error(`escalation insert failed: ${ins.error.message}`); continue }

    await notifyAdmins(admins, dryRun, (recipient) =>
      escalationText({
        recipientIsSubject: recipient.id === d.person_id,
        subjectName: d.full_name as string,
        kind: d.kind as string,
        diagnosis,
        suggestion,
        suppressUntil,
        otherAdmins: admins.filter((a) => a.id !== recipient.id).map((a) => a.full_name),
      }),
    )
    raised++
  }

  console.log(`\nEscalations raised: ${raised}. Eased off: ${easedOff}. Blockers: ${blockers}.`)
}

/**
 * One escalation, rendered for one recipient.
 *
 * The subject receives the same message as everyone else, in second person.
 * Writing about someone in the third person and then delivering it to them is
 * how Monday's message ended up reading as a report filed against its own
 * reader.
 */
function escalationText(o: {
  recipientIsSubject: boolean
  subjectName: string
  kind: string
  diagnosis: string
  suggestion: string
  suppressUntil: string
  otherAdmins: string[]
}): string {
  const until = dayLabel(o.suppressUntil)

  if (!o.recipientIsSubject) {
    return (
      `*Echo isn't getting anywhere with ${o.subjectName}*\n\n` +
      `${o.diagnosis}\n\n` +
      `${o.suggestion}\n\n` +
      `_Echo will stay quiet on this backlog until ${until}. ${o.subjectName} has had this message too._`
    )
  }

  const selfSuggestion =
    o.kind === 'disengaged'
      ? `Most likely too much in the queue to engage with any of it, or the asks aren't landing. ` +
        `A triage session rather than more nudges.`
      : `Answering every time and clearing nothing usually means blocked or underwater.`

  const seenBy = o.otherAdmins.length
    ? ` ${o.otherAdmins.join(' and ')} received the same message.`
    : ''

  return (
    `*Echo hasn't been getting anywhere with your backlog*\n\n` +
    `${o.diagnosis}\n\n` +
    `${selfSuggestion}\n\n` +
    `_Echo will stay quiet on this backlog until ${until}.${seenBy}_`
  )
}

async function notifyAdmins(
  admins: Admin[],
  dryRun: boolean,
  build: (recipient: Admin) => string,
) {
  for (const a of admins) {
    if (!a.slack_user_id) continue
    const text = build(a)
    assertNoPronouns(text)
    if (dryRun) {
      console.log(`\n--- would send to ${a.full_name} ---\n${text}\n`)
      continue
    }
    await sendDm(a.slack_user_id, text)
    console.log(`Escalation sent to ${a.full_name}.`)
  }
}

function dayLabel(day: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/London', weekday: 'short', day: 'numeric', month: 'short',
  }).format(new Date(`${day}T12:00:00Z`))
}

main().catch((e) => {
  console.error('\n=== ESCALATE FAILED ===')
  console.error(e instanceof Error ? e.message : e)
  process.exit(1)
})

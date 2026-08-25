import { echoDb } from './lib/supabase'
import { teamwork } from './lib/teamwork'
import { lookupByEmail, sendDm } from './lib/slack'
import { syncPeopleFromTeamwork } from './roles'
import { timeQuestion, silenceQuestion, footer, assertNoPronouns, ProjectLine, FooterItem } from './copy'
import { londonDay } from './lib/dates'

const OWN_COMPANY_ID = 119378          // We Take Flight in Teamwork
// Every link in every message points at Teamwork, never at Echo — Teamwork is
// the system of record for time, and offering a second place to log it is how
// you end up with time in two systems and trust in neither.
const TW = process.env.TEAMWORK_BASE_URL ?? 'https://wetakeflight.eu.teamwork.com'
// Echo is linked ONLY from the footer, for "see the rest of your list". Never
// for logging time — that always goes to Teamwork.
const ECHO_URL = process.env.ECHO_DASHBOARD_URL ?? ''

// How far back a work day can be and still be worth asking about. Findings
// older than this are left pending but never sent: being asked on the 13th
// about the 3rd is not a nudge, it is an accusation about something nobody
// remembers. Five days covers a long weekend plus a day.
const NUDGE_MAX_AGE_DAYS = 5

// How old an unanswered question can be and still earn a footer slot. Beyond
// this it stops being repeated daily and only counts toward "+N more". Sorting
// oldest-first meant the same two questions held the top slots indefinitely —
// nothing newer could ever displace them, so the footer became wallpaper.
// Something ignored for a fortnight is an escalation, not a nudge.
const FOOTER_MENTION_MAX_DAYS = 14

/**
 * Echo nudge — sends the daily DM.
 *
 * Gating is deliberately paranoid. Nothing sends unless ALL of these hold:
 *   - echo_config.nudges_enabled is true            (the master kill switch)
 *   - echo_person.nudges_enabled is true FOR THAT PERSON
 *   - echo_may_message() returns true               (staff, not a client, not on
 *     leave, past onboarding grace, no open escalation, has a Slack id)
 *   - no DM already sent to that person today       (enforced by a unique index)
 *
 * So enabling one person is how you pilot this. Everyone else stays silent even
 * with the master switch on.
 */
async function main() {
  const db = echoDb()
  const dryRun = process.env.ECHO_DRY_RUN === 'true'

  const cfg = await db.from('echo_config').select('*').eq('id', 1).maybeSingle()
  if (cfg.error) throw new Error(`Cannot read echo_config: ${cfg.error.message}`)
  if (!cfg.data?.nudges_enabled && !dryRun) {
    console.log('nudges_enabled is false — sending nothing. This is the kill switch.')
    return
  }

  // Refresh staff + emails from Teamwork, using Teamwork's own client flag.
  // Dedupe by id: paging can return the same person twice, which made the
  // roster line report 8 staff out of 8 people plus 1 excluded.
  const tp = [...new Map((await teamwork.people()).map((p) => [p.id, p])).values()]
  const sync = await syncPeopleFromTeamwork(db, tp, OWN_COMPANY_ID)
  console.log(`Roster: ${sync.staff} staff, ${sync.excluded} excluded (clients/guests).`)

  const { data: people, error } = await db
    .from('echo_person')
    .select('id, full_name, email, slack_user_id, role_class, nudges_enabled')
    .eq('is_staff', true)
    .eq('nudges_enabled', true)
  if (error) throw new Error(`Cannot read echo_person: ${error.message}`)
  if (!people?.length) {
    console.log('Nobody has nudges_enabled — sending nothing.')
    return
  }
  console.log(`${people.length} person(s) enabled: ${people.map((p) => p.full_name).join(', ')}`)

  const { data: policies } = await db.from('echo_role_policy').select('role_class, tone')
  const toneFor = new Map((policies ?? []).map((p) => [p.role_class, p.tone as string]))

  const today = londonDay(new Date())
  // Floor for how old a work_date can be. Computed once so every person in the
  // run is judged against the same cutoff.
  const oldestWorkDate = londonDay(new Date(Date.now() - NUDGE_MAX_AGE_DAYS * 86_400_000))
  let sent = 0

  for (const person of people) {
    const gate = await db.rpc('echo_may_message', { p_person: person.id, p_date: today })
    if (gate.data !== true && !dryRun) {
      console.log(`${person.full_name}: skipped by echo_may_message`)
      continue
    }

    // Resolve and cache the Slack id from the Teamwork email.
    let slackId: string | null = person.slack_user_id
    if (!slackId && person.email) {
      slackId = await lookupByEmail(person.email)
      if (slackId) await db.from('echo_person').update({ slack_user_id: slackId }).eq('id', person.id)
    }
    if (!slackId) {
      console.log(`${person.full_name}: no Slack account found for ${person.email ?? 'no email'} — skipped`)
      continue
    }

    // Candidate time questions, newest first, nothing older than the cutoff.
    // Taking several rather than one matters: the newest candidate may be a
    // duplicate of a day already asked about, and we want the next best rather
    // than nothing at all.
    const { data: candidates } = await db
      .from('echo_finding')
      .select('id, kind, work_date, evidence_count, has_completed_task, human_summary, single_sitting')
      .eq('person_id', person.id)
      .in('kind', ['active_day_unlogged', 'active_day_partial'])
      .eq('status', 'pending')
      .gte('work_date', oldestWorkDate)
      .order('work_date', { ascending: false })
      .limit(10)

    // Days this person has already been asked about. The sweep can write a
    // second finding for a work_date that was already notified, which is how
    // Mon 3 Aug went out twice with different numbers. One question per day,
    // ever, regardless of how many findings exist for it.
    const { data: alreadyAsked } = await db
      .from('echo_finding')
      .select('work_date')
      .eq('person_id', person.id)
      .in('kind', ['active_day_unlogged', 'active_day_partial'])
      .eq('status', 'notified')
      .gte('work_date', oldestWorkDate)

    const askedDays = new Set((alreadyAsked ?? []).map((f) => f.work_date as string))
    const fresh = (candidates ?? []).filter((f) => !askedDays.has(f.work_date as string))

    if ((candidates?.length ?? 0) > fresh.length) {
      const dupes = (candidates ?? []).length - fresh.length
      console.log(`${person.full_name}: ${dupes} candidate(s) skipped — already asked about that day`)
    }

    let finding = fresh[0]
    let text: string

    if (!finding) {
      // No time question. Is this person silent altogether? That is the one
      // case where having nothing to say IS the thing worth saying.
      const { data: quiet } = await db
        .from('echo_finding')
        .select('id, human_summary')
        .eq('person_id', person.id)
        .eq('kind', 'silent')
        .eq('status', 'pending')
        .order('work_date', { ascending: false })
        .limit(1)

      const s = quiet?.[0]
      if (!s) {
        console.log(`${person.full_name}: nothing to ask about today`)
        continue
      }
      const openTasks = Number((s.human_summary ?? '').match(/with (\d+) open/)?.[1] ?? 0)
      text = silenceQuestion({
        days: cfg.data?.silence_days ?? 7,
        openTasks,
        teamworkBase: TW,
      })
      text += await buildFooter(db, person.id, cfg.data?.footer_max_items ?? 3)
      assertNoPronouns(text)

      if (dryRun) {
        console.log(`\n--- would send to ${person.full_name} (silence) ---\n${text}\n`)
        continue
      }
      const ts = await sendDm(slackId, text)
      const ins = await db.from('echo_nudge').insert({
        person_id: person.id, channel: 'slack_dm', finding_ids: [s.id],
        slack_ts: ts, slack_channel: slackId,
      })
      if (!ins.error) {
        await db.from('echo_finding').update({ status: 'notified' }).eq('id', s.id)
        sent++
        console.log(`${person.full_name}: sent (silence)`)
      }
      continue
    }

    const { data: projects } = await db
      .from('echo_finding_project')
      .select('project_name, teamwork_project_id, signal_count, first_signal_at, last_signal_at, single_sitting')
      .eq('finding_id', finding.id)
      .order('signal_count', { ascending: false })
      .limit(4)

    const lines: ProjectLine[] = (projects ?? []).map((p) => ({
      name: p.project_name ?? `Project ${p.teamwork_project_id}`,
      projectId: p.teamwork_project_id as number,
      signals: p.signal_count as number,
      from: hhmm(p.first_signal_at as string),
      to: hhmm(p.last_signal_at as string),
      singleSitting: p.single_sitting === true,
    }))
    if (!lines.length) {
      console.log(`${person.full_name}: finding has no project breakdown — skipped`)
      continue
    }

    const completed = finding.has_completed_task
      ? (finding.human_summary ?? '').replace(/^Completed\s+/i, '').split(',')[0] || null
      : null

    text = timeQuestion({
      completedTask: completed,
      signals: finding.evidence_count as number,
      projects: lines,
      tone: (toneFor.get(person.role_class) === 'soft' ? 'soft' : 'direct'),
      dayLabel: dayLabel(finding.work_date as string),
      teamworkBase: TW,
      singleSitting: finding.single_sitting === true,
    })

    text += await buildFooter(db, person.id, cfg.data?.footer_max_items ?? 3)

    // Final guard before anything leaves the building.
    assertNoPronouns(text)

    if (dryRun) {
      console.log(`\n--- would send to ${person.full_name} (${finding.work_date}) ---\n${text}\n`)
      continue
    }

    const ts = await sendDm(slackId, text)
    const ins = await db.from('echo_nudge').insert({
      person_id: person.id,
      channel: 'slack_dm',
      finding_ids: [finding.id],
      slack_ts: ts,
      slack_channel: slackId,
    })
    if (ins.error) {
      // The unique index enforces one DM per person per day. Hitting it means
      // something already messaged them today; that is a guard working, not a bug.
      console.log(`${person.full_name}: nudge not recorded (${ins.error.message})`)
    } else {
      await db.from('echo_finding').update({ status: 'notified' }).eq('id', finding.id)
      sent++
      console.log(`${person.full_name}: sent (${finding.work_date})`)
    }
  }
  console.log(`\nDone. ${sent} message(s) sent.`)
}

async function buildFooter(db: ReturnType<typeof echoDb>, personId: string, max: number): Promise<string> {
  const items: FooterItem[] = []

  const { data: stale } = await db
    .from('echo_v_stale_tasks')
    .select('teamwork_task_id, task_name, stage_name, days_in_stage, max_dwell_days, severity, is_legacy_backlog, entered_at_is_estimate')
    .eq('assignee_person_id', personId)
    .eq('breach_owner', 'assignee')
    .eq('is_legacy_backlog', false)
    .eq('entered_at_is_estimate', false)
    .order('severity', { ascending: false })
    .limit(max)

  for (const s of stale ?? []) {
    items.push({
      label: s.stage_name as string,
      title: s.task_name as string,
      detail: `${s.days_in_stage} days (target ${s.max_dwell_days})`,
      taskId: s.teamwork_task_id as number,
    })
  }

  const room = Math.max(0, max - items.length)
  if (room > 0) {
    // Freshest first, and nothing past the cutoff. Ordering oldest-first meant
    // the two longest-unanswered questions occupied the footer permanently:
    // by definition nothing could ever be older than them, so the list could
    // only change when they were answered — which is precisely what was not
    // happening. Newer questions are also the ones most likely to be cleared.
    const { data: mentions } = await db
      .from('echo_v_open_mentions')
      .select('teamwork_task_id, asked_by, days_waiting, comment_excerpt')
      .eq('mentioned_person_id', personId)
      .gte('days_waiting', 2)
      .lte('days_waiting', FOOTER_MENTION_MAX_DAYS)
      .order('days_waiting', { ascending: true })
      .limit(room)

    // echo_mention stores only the task id, so resolve names from the stage
    // history (which holds task_name for every open task). Without this the
    // footer showed the raw comment text as the title, which read as gibberish.
    const ids = (mentions ?? []).map((m) => m.teamwork_task_id as number)
    const names = new Map<number, string>()
    if (ids.length) {
      const { data: tasks } = await db
        .from('echo_task_stage_history')
        .select('teamwork_task_id, task_name')
        .in('teamwork_task_id', ids)
        .is('exited_at', null)
      for (const t of tasks ?? []) {
        if (t.task_name) names.set(t.teamwork_task_id as number, t.task_name as string)
      }
    }

    for (const m of mentions ?? []) {
      const taskId = m.teamwork_task_id as number
      items.push({
        label: 'Awaiting your reply',
        title: names.get(taskId) ?? `Task ${taskId}`,
        detail: `${m.asked_by} asked ${m.days_waiting} days ago`,
        taskId,
      })
    }
  }

  // "+N more" has to count the same population the list is drawn from, or the
  // number is fiction. It previously counted every stale task including legacy
  // backlog and estimated entry dates — rows that can never be displayed — and
  // ignored mentions entirely. Mentions past FOOTER_MENTION_MAX_DAYS still
  // count here even though they are no longer shown: they have not gone away,
  // they have just stopped being worth repeating every morning.
  const { count: staleTotal } = await db
    .from('echo_v_stale_tasks')
    .select('teamwork_task_id', { count: 'exact', head: true })
    .eq('assignee_person_id', personId)
    .eq('breach_owner', 'assignee')
    .eq('is_legacy_backlog', false)
    .eq('entered_at_is_estimate', false)

  const { count: mentionTotal } = await db
    .from('echo_v_open_mentions')
    .select('teamwork_task_id', { count: 'exact', head: true })
    .eq('mentioned_person_id', personId)
    .gte('days_waiting', 2)

  const hidden = Math.max(0, (staleTotal ?? 0) + (mentionTotal ?? 0) - items.length)

  return footer(items.slice(0, max), hidden, TW, ECHO_URL || undefined)
}

function hhmm(iso: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/London', hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(new Date(iso))
}

function dayLabel(day: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/London', weekday: 'short', day: 'numeric', month: 'short',
  }).format(new Date(`${day}T12:00:00Z`))
}

main().catch((e) => {
  console.error('\n=== NUDGE FAILED ===')
  console.error(e instanceof Error ? e.message : e)
  process.exit(1)
})

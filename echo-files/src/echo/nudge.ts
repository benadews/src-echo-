import { echoDb } from './lib/supabase'
import { teamwork } from './lib/teamwork'
import { lookupByEmail, sendDm } from './lib/slack'
import { syncPeopleFromTeamwork } from './roles'
import { timeQuestion, footer, assertNoPronouns, ProjectLine, FooterItem } from './copy'
import { londonDay } from './lib/dates'

const OWN_COMPANY_ID = 119378          // We Take Flight in Teamwork
const DASHBOARD = process.env.ECHO_DASHBOARD_URL ?? 'https://example.com/echo'

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
  const tp = await teamwork.people()
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

    // The most recent unanswered time question.
    const { data: findings } = await db
      .from('echo_finding')
      .select('id, kind, work_date, evidence_count, has_completed_task, human_summary')
      .eq('person_id', person.id)
      .in('kind', ['active_day_unlogged', 'active_day_partial'])
      .in('status', ['pending'])
      .order('work_date', { ascending: false })
      .limit(1)

    const finding = findings?.[0]
    if (!finding) {
      console.log(`${person.full_name}: nothing to ask about today`)
      continue
    }

    const { data: projects } = await db
      .from('echo_finding_project')
      .select('project_name, teamwork_project_id, signal_count, first_signal_at, last_signal_at')
      .eq('finding_id', finding.id)
      .order('signal_count', { ascending: false })
      .limit(4)

    const lines: ProjectLine[] = (projects ?? []).map((p) => ({
      name: p.project_name ?? `Project ${p.teamwork_project_id}`,
      signals: p.signal_count as number,
      from: hhmm(p.first_signal_at as string),
      to: hhmm(p.last_signal_at as string),
    }))
    if (!lines.length) {
      console.log(`${person.full_name}: finding has no project breakdown — skipped`)
      continue
    }

    const completed = finding.has_completed_task
      ? (finding.human_summary ?? '').replace(/^Completed\s+/i, '').split(',')[0] || null
      : null

    let text = timeQuestion({
      completedTask: completed,
      signals: finding.evidence_count as number,
      projects: lines,
      tone: (toneFor.get(person.role_class) === 'soft' ? 'soft' : 'direct'),
      dayLabel: dayLabel(finding.work_date as string),
      dashboardUrl: DASHBOARD,
    })

    text += await buildFooter(db, person.id, cfg.data?.footer_max_items ?? 3)

    // Final guard before anything leaves the building.
    assertNoPronouns(text)

    if (dryRun) {
      console.log(`\n--- would send to ${person.full_name} ---\n${text}\n`)
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
      console.log(`${person.full_name}: sent`)
    }
  }
  console.log(`\nDone. ${sent} message(s) sent.`)
}

async function buildFooter(db: ReturnType<typeof echoDb>, personId: string, max: number): Promise<string> {
  const items: FooterItem[] = []

  const { data: stale } = await db
    .from('echo_v_stale_tasks')
    .select('task_name, stage_name, days_in_stage, max_dwell_days, severity, is_legacy_backlog, entered_at_is_estimate')
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
    })
  }

  const { data: mentions } = await db
    .from('echo_v_open_mentions')
    .select('task_name:comment_excerpt, asked_by, days_waiting')
    .eq('mentioned_person_id', personId)
    .gte('days_waiting', 2)
    .order('days_waiting', { ascending: false })
    .limit(Math.max(0, max - items.length))

  for (const m of mentions ?? []) {
    items.push({
      label: 'Awaiting your reply',
      title: String((m as { task_name?: string }).task_name ?? '').slice(0, 70),
      detail: `${m.asked_by} asked ${m.days_waiting} days ago`,
    })
  }

  const { count } = await db
    .from('echo_v_stale_tasks')
    .select('teamwork_task_id', { count: 'exact', head: true })
    .eq('assignee_person_id', personId)
    .eq('breach_owner', 'assignee')
  const hidden = Math.max(0, (count ?? 0) - items.length)

  return footer(items.slice(0, max), hidden, DASHBOARD)
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

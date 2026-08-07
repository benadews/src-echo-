import { echoDb } from './lib/supabase'
import { teamwork, type Task } from './lib/teamwork'
import { listBotChannels, getHistorySince, getThreadReplies, getPermalink, getLatestMessageTs, sendDm } from './lib/slack'
import { assertNoPronouns } from './copy'
import { londonDay } from './lib/dates'

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY
const ANTHROPIC_MODEL = 'claude-sonnet-4-5' // confirm against whatever Vector's brief analyser uses
const FIRST_SCAN_LOOKBACK_DAYS = 3 // a channel's first-ever scan only looks back this far, not full history
const DORMANT_AFTER_DAYS = 30 // channels silent longer than this are skipped entirely for the run
const TESTING_RECIPIENT_EMAIL = 'ben@wetakeflight.co.uk' // TESTING PHASE: only this person gets triage DMs — remove this filter to restore all super_admins

type SlackMessage = { ts: string; user?: string; text: string; thread_ts?: string; reply_count?: number }
type Conversation = { channelId: string; channelName: string; isExternal: boolean; threadTs: string; messages: SlackMessage[] }
type Classification = {
  isTaskSpecific: boolean
  confidence: 'high' | 'medium' | 'low'
  summary: string
  likelyProjectOrClient: string | null
}
interface TaskCandidate {
  projectId: number | null
  taskId: number
  taskName: string
  projectName: string | null
  updatedAt: string
}

/**
 * Echo triage — reads every channel the bot is in (including external/Slack
 * Connect), groups messages into conversations, asks the AI to judge which
 * ones sound like real task-specific work, cross-checks Teamwork, and DMs
 * findings when confident there's a gap — no task exists, or one exists but
 * has gone stale (reusing sweep's own dwell-breach definition,
 * echo_v_stale_tasks, rather than a separate threshold).
 *
 * CRITICAL ORDERING: the echo_channel_scan row for a channel is created
 * immediately, before any finding for that channel is processed — NOT at the
 * end of the channel's loop iteration as an earlier version did.
 * echo_triage_finding.channel_id has a foreign key against echo_channel_scan,
 * so a channel's first-ever scan could never successfully write a finding
 * under the old ordering; every insert failed silently mid-run and no DM
 * ever went out, while the checkpoint still advanced — meaning those
 * conversations would have been skipped forever without a manual reset.
 *
 * Message copy follows copy.ts's conventions (bold headline + emoji, Slack
 * markdown links, assertNoPronouns) rather than a separate style. Channel is
 * always referenced via Slack's own <#channelId> auto-link — real data, no
 * separate name lookup, present even if the permalink call fails.
 *
 * Participants are the actual message authors (msg.user on each Slack
 * message) matched against echo_person — NOT an AI guess. The model has no
 * way to know a real Slack ID unless it's a literal <@U123> mention in the
 * text, so asking it to invent one always produced "unknown."
 *
 * TESTING PHASE: all findings go only to TESTING_RECIPIENT_EMAIL (Ben),
 * resolved via profiles.role = super_admin -> matched to echo_person by
 * email for a working Slack ID. Chris is super_admin too but deliberately
 * excluded from DMs for now per Ben's instruction — remove the
 * TESTING_RECIPIENT_EMAIL filter below to restore DMs to all super_admins,
 * and swap `superAdmins` for `peopleInvolved` in the send loop to restore
 * direct-to-participant DMs once ready for the wider team.
 *
 * Two cost/noise guards:
 *  - A channel's first-ever scan is bounded to FIRST_SCAN_LOOKBACK_DAYS
 *    rather than full history.
 *  - A channel whose most recent message is older than DORMANT_AFTER_DAYS
 *    is skipped entirely for the run, re-checked fresh every time.
 *
 * Mirrors sweep.ts's error handling: loud, explicit, never swallowed.
 */
async function main() {
  const db = echoDb()
  const dryRun = process.env.ECHO_DRY_RUN === 'true'

  const probe = await db.from('echo_person').select('id').eq('is_staff', true).limit(1)
  if (probe.error) throw new Error(`Cannot read echo_person: ${probe.error.message}`)
  if (!ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY is required — add it as a repo secret before running triage.')

  const runIns = await db
    .from('echo_run')
    .insert({ kind: 'triage', github_run_id: process.env.GITHUB_RUN_ID ?? null })
    .select('id')
    .maybeSingle()
  if (runIns.error) throw new Error(`Cannot write to echo_run: ${runIns.error.message}`)
  const runId: string | null = runIns.data?.id ?? null

  try {
    const { data: staff, error: staffErr } = await db
      .from('echo_person')
      .select('id, full_name, email, slack_user_id, is_staff')
      .eq('is_staff', true)
    if (staffErr) throw new Error(`Cannot read echo_person: ${staffErr.message}`)
    const staffBySlackId = new Map((staff ?? []).filter((p) => p.slack_user_id).map((p) => [p.slack_user_id as string, p]))
    const staffByEmail = new Map((staff ?? []).filter((p) => p.email).map((p) => [p.email!.toLowerCase(), p]))

    const { data: superAdminProfiles, error: adminErr } = await db
      .from('profiles')
      .select('id, full_name, email')
      .eq('role', 'super_admin')
    if (adminErr) throw new Error(`Cannot read profiles for super_admin: ${adminErr.message}`)
    if (!superAdminProfiles?.length) throw new Error('No super_admin found in profiles — nobody would receive triage DMs.')

    const testingRecipients = superAdminProfiles.filter((sa) => sa.email?.toLowerCase() === TESTING_RECIPIENT_EMAIL)
    if (!testingRecipients.length) {
      throw new Error(`TESTING_RECIPIENT_EMAIL (${TESTING_RECIPIENT_EMAIL}) not found among super_admin profiles — check the email matches exactly.`)
    }

    const superAdmins = testingRecipients
      .map((sa) => {
        const echoMatch = sa.email ? staffByEmail.get(sa.email.toLowerCase()) : undefined
        return echoMatch
          ? { full_name: sa.full_name ?? echoMatch.full_name, slack_user_id: echoMatch.slack_user_id as string | null }
          : null
      })
      .filter((sa): sa is { full_name: string; slack_user_id: string | null } => sa !== null)

    if (!superAdmins.length) {
      throw new Error(
        `${TESTING_RECIPIENT_EMAIL} found in profiles as super_admin, but did not match an echo_person by email — ` +
        'check profiles.email lines up with echo_person.email.',
      )
    }
    const missingSlackId = superAdmins.filter((sa) => !sa.slack_user_id)
    if (missingSlackId.length) {
      console.warn(`  warning: ${missingSlackId.map((sa) => sa.full_name).join(', ')} matched but has no slack_user_id in echo_person — will be skipped when sending.`)
    }

    console.log('Loading open tasks and projects for matching...')
    const [openTasks, projectList] = await Promise.all([teamwork.openTasks(), teamwork.projects()])
    const projectNames = new Map(projectList.map((p) => [p.id, p.name]))
    console.log(`${openTasks.length} open task(s) across ${projectList.length} project(s).`)

    console.log('Listing bot channels...')
    const channels = await listBotChannels()
    console.log(`${channels.length} channel(s) visible to the bot.`)

    let conversationsFound = 0
    let classified = 0
    let findingsWritten = 0
    let dmsSent = 0
    let dormantSkipped = 0

    for (const channel of channels) {
      const checkpoint = await db
        .from('echo_channel_scan')
        .select('last_scanned_ts')
        .eq('channel_id', channel.id)
        .maybeSingle()
      if (checkpoint.error) throw new Error(`Cannot read echo_channel_scan: ${checkpoint.error.message}`)

      let latestTs: string | null
      try {
        latestTs = await getLatestMessageTs(channel.id)
      } catch (err) {
        console.error(`  ${channel.name}: latest-message check failed — ${err instanceof Error ? err.message : err}`)
        continue
      }

      if (!latestTs) {
        await db.from('echo_channel_scan').upsert({
          channel_id: channel.id,
          channel_name: channel.name,
          is_external: channel.is_ext_shared,
          last_run_at: new Date().toISOString(),
        })
        continue
      }

      const daysSinceLastMessage = (Date.now() / 1000 - Number(latestTs)) / 86_400
      if (daysSinceLastMessage > DORMANT_AFTER_DAYS) {
        console.log(`  ${channel.name}: dormant (last message ${Math.round(daysSinceLastMessage)} days ago) — skipped`)
        dormantSkipped++
        await db.from('echo_channel_scan').upsert({
          channel_id: channel.id,
          channel_name: channel.name,
          is_external: channel.is_ext_shared,
          last_run_at: new Date().toISOString(),
        })
        continue
      }

      // CRITICAL: create/update the checkpoint row NOW, before any finding
      // for this channel is inserted. echo_triage_finding.channel_id has a
      // foreign key against this table — without this row existing first,
      // a channel's first-ever scan can never write a finding successfully.
      const { error: checkpointErr } = await db.from('echo_channel_scan').upsert({
        channel_id: channel.id,
        channel_name: channel.name,
        is_external: channel.is_ext_shared,
        last_run_at: new Date().toISOString(),
      })
      if (checkpointErr) {
        console.error(`  ${channel.name}: could not create checkpoint row — ${checkpointErr.message} — skipping to avoid FK failures on findings`)
        continue
      }

      const since = checkpoint.data?.last_scanned_ts ?? slackTsFromDaysAgo(FIRST_SCAN_LOOKBACK_DAYS)

      let messages: SlackMessage[]
      try {
        messages = await getHistorySince(channel.id, since)
      } catch (err) {
        console.error(`  ${channel.name}: history fetch failed — ${err instanceof Error ? err.message : err}`)
        continue
      }

      if (!messages.length) continue

      const conversations: Conversation[] = []
      for (const msg of messages) {
        if (msg.thread_ts && msg.thread_ts !== msg.ts) continue
        let thread = [msg]
        if (msg.reply_count && msg.reply_count > 0) {
          try {
            thread = await getThreadReplies(channel.id, msg.ts)
          } catch {
            // fall back to just the parent message
          }
        }
        conversations.push({
          channelId: channel.id,
          channelName: channel.name,
          isExternal: channel.is_ext_shared,
          threadTs: msg.ts,
          messages: thread,
        })
      }
      conversationsFound += conversations.length

      for (const convo of conversations) {
        const already = await db
          .from('echo_triage_finding')
          .select('id')
          .eq('channel_id', convo.channelId)
          .eq('thread_ts', convo.threadTs)
          .maybeSingle()
        if (already.data) continue

        let result: Classification
        try {
          result = await classifyConversation(convo)
        } catch (err) {
          console.error(`  ${channel.name} thread ${convo.threadTs}: classification failed — ${err instanceof Error ? err.message : err}`)
          continue
        }
        classified++

        if (!result.isTaskSpecific || result.confidence === 'low') continue

        const teamworkMatch = findMatchingTask(openTasks, projectNames, result.summary, result.likelyProjectOrClient)
        const verdict = teamworkMatch
          ? await assessStaleness(db, teamworkMatch.taskId, teamworkMatch.updatedAt)
          : 'no_task_exists'
        if (verdict === 'task_current') continue

        const teamworkTaskUrl = teamworkMatch ? `${process.env.TEAMWORK_BASE_URL}/#/tasks/${teamworkMatch.taskId}` : null

        let permalink: string | null = null
        try {
          permalink = await getPermalink(convo.channelId, convo.threadTs)
        } catch (err) {
          console.warn(`  ${channel.name} thread ${convo.threadTs}: permalink fetch failed — ${err instanceof Error ? err.message : err}`)
        }

        const authorIds = [...new Set(convo.messages.map((m) => m.user).filter((u): u is string => Boolean(u)))]
        const peopleInvolved = authorIds

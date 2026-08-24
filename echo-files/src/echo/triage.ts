import { echoDb } from './lib/supabase'
import { teamwork, type Task } from './lib/teamwork'
import { listBotChannels, getHistorySince, getThreadReplies, getPermalink, getLatestMessageTs, sendDm } from './lib/slack'
import { assertNoPronouns } from './copy'
import { londonDay } from './lib/dates'

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY
const ANTHROPIC_MODEL = 'claude-sonnet-4-5'
const FIRST_SCAN_LOOKBACK_DAYS = 3
const DORMANT_AFTER_DAYS = 30

// Who receives the triage digest. Everyone listed must be a super_admin in
// profiles AND match an echo_person by email. Adding someone here is additive —
// nothing is redirected, each recipient gets an identical copy.
// Override without a deploy: ECHO_TRIAGE_RECIPIENTS="a@x.co.uk,b@x.co.uk"
const TRIAGE_RECIPIENT_EMAILS = (
  process.env.ECHO_TRIAGE_RECIPIENTS ?? 'ben@wetakeflight.co.uk,chris@wetakeflight.co.uk'
)
  .split(',')
  .map((e) => e.trim().toLowerCase())
  .filter(Boolean)

// One DM per run, not one per finding. Six separate DMs inside a minute reads
// as a malfunction even when every finding is correct.
const DIGEST_MAX_ITEMS = 8

const TW = process.env.TEAMWORK_BASE_URL ?? 'https://wetakeflight.eu.teamwork.com'
const ECHO_URL = process.env.ECHO_DASHBOARD_URL ?? ''
// Slack archive URLs are deterministic, so a permalink can always be built even
// when chat.getPermalink returns nothing. A finding with no source link cannot
// be verified, which makes it worse than no finding at all.
const SLACK_WORKSPACE_URL = process.env.SLACK_WORKSPACE_URL ?? 'https://wetakeflight.slack.com'

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
type TriageItem = {
  verdict: string
  channelId: string
  channelName: string
  summary: string
  taskUrl: string | null
  taskName: string | null
  permalink: string | null
  involvedNames: string[]
}

async function main() {
  const db = echoDb()
  const dryRun = process.env.ECHO_DRY_RUN === 'true'

  const probe = await db.from('echo_person').select('id').eq('is_staff', true).limit(1)
  if (probe.error) throw new Error(`Cannot read echo_person: ${probe.error.message}`)
  if (!ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY is required — add it as a repo secret before running triage.')
  if (!TRIAGE_RECIPIENT_EMAILS.length) throw new Error('No triage recipients configured — nobody would receive the digest.')

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

    // Slack id -> human name, used to keep raw ids out of the transcript the
    // model sees. The model can only echo back what it is given, and given
    // "U08LS7J6E4D" it will happily print it into a summary.
    const nameBySlackId = new Map(
      (staff ?? [])
        .filter((p) => p.slack_user_id && p.full_name)
        .map((p) => [p.slack_user_id as string, p.full_name as string]),
    )

    const { data: superAdminProfiles, error: adminErr } = await db
      .from('profiles')
      .select('id, full_name, email')
      .eq('role', 'super_admin')
    if (adminErr) throw new Error(`Cannot read profiles for super_admin: ${adminErr.message}`)
    if (!superAdminProfiles?.length) throw new Error('No super_admin found in profiles — nobody would receive triage DMs.')

    // Resolve each configured recipient independently. One person being
    // misconfigured must not silence everybody else — that failure mode looks
    // identical to "Echo stopped working" from the outside.
    const recipients: { full_name: string; slack_user_id: string | null }[] = []
    for (const email of TRIAGE_RECIPIENT_EMAILS) {
      const profile = superAdminProfiles.find((sa) => sa.email?.toLowerCase() === email)
      if (!profile) {
        console.warn(`  warning: ${email} is not a super_admin in profiles — skipped, no digest will reach this address.`)
        continue
      }
      const echoMatch = staffByEmail.get(email)
      if (!echoMatch) {
        console.warn(`  warning: ${email} is a super_admin but did not match an echo_person by email — skipped.`)
        continue
      }
      if (!echoMatch.slack_user_id) {
        console.warn(`  warning: ${echoMatch.full_name} has no slack_user_id in echo_person — skipped when sending.`)
      }
      recipients.push({
        full_name: profile.full_name ?? echoMatch.full_name,
        slack_user_id: echoMatch.slack_user_id as string | null,
      })
    }

    if (!recipients.length) {
      throw new Error(
        `None of the configured recipients (${TRIAGE_RECIPIENT_EMAILS.join(', ')}) resolved to a super_admin with an ` +
        'echo_person match — check profiles.email lines up with echo_person.email.',
      )
    }
    console.log(`Digest recipients: ${recipients.map((r) => r.full_name).join(', ')}`)

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
    const digestItems: TriageItem[] = []

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
        // limit(1) rather than maybeSingle(): duplicate rows for the same
        // thread would make maybeSingle throw rather than report "seen it".
        const already = await db
          .from('echo_triage_finding')
          .select('id')
          .eq('channel_id', convo.channelId)
          .eq('thread_ts', convo.threadTs)
          .limit(1)
        if (already.data?.length) continue

        let result: Classification
        try {
          result = await classifyConversation(convo, nameBySlackId)
        } catch (err) {
          console.error(`  ${channel.name} thread ${convo.threadTs}: classification failed — ${err instanceof Error ? err.message : err}`)
          continue
        }
        classified++

        if (!result.isTaskSpecific || result.confidence === 'low') continue

        // Belt and braces: even with names in the transcript, a stray id in the
        // raw message text can survive into the summary.
        const summary = scrubSlackIds(result.summary, nameBySlackId)

        const teamworkMatch = findMatchingTask(openTasks, projectNames, summary, result.likelyProjectOrClient)
        const verdict = teamworkMatch
          ? await assessStaleness(db, teamworkMatch.taskId, teamworkMatch.updatedAt)
          : 'no_task_exists'
        if (verdict === 'task_current') continue

        const teamworkTaskUrl = teamworkMatch ? `${TW}/app/tasks/${teamworkMatch.taskId}` : null

        let permalink: string | null = null
        try {
          permalink = await getPermalink(convo.channelId, convo.threadTs)
        } catch (err) {
          console.warn(`  ${channel.name} thread ${convo.threadTs}: permalink fetch failed — ${err instanceof Error ? err.message : err}`)
        }
        if (!permalink) permalink = buildPermalink(convo.channelId, convo.threadTs)

        const authorIds = [...new Set(convo.messages.map((m) => m.user).filter((u): u is string => Boolean(u)))]
        const peopleInvolved = authorIds
          .map((slackId) => staffBySlackId.get(slackId))
          .filter((p): p is NonNullable<typeof p> => Boolean(p))

        if (!dryRun) {
          const ins = await db.from('echo_triage_finding').insert({
            channel_id: convo.channelId,
            channel_name: convo.channelName,
            thread_ts: convo.threadTs,
            slack_permalink: permalink,
            summary,
            verdict,
            confidence: result.confidence,
            teamwork_project_id: teamworkMatch?.projectId ?? null,
            teamwork_task_id: teamworkMatch?.taskId ?? null,
            teamwork_task_url: teamworkTaskUrl,
            people_involved: peopleInvolved.map((p) => ({ slack_user_id: p.slack_user_id, echo_person_id: p.id, dmd_at: null })),
          })
          if (ins.error) {
            console.error(`  could not write finding: ${ins.error.message}`)
            continue
          }
          findingsWritten++
        } else {
          console.log(`\n--- would flag (${verdict}, ${result.confidence}) ---\n${summary}\n`)
        }

        const item: TriageItem = {
          verdict,
          channelId: convo.channelId,
          channelName: convo.channelName,
          summary,
          taskUrl: teamworkTaskUrl,
          taskName: teamworkMatch?.taskName ?? null,
          permalink,
          involvedNames: peopleInvolved.map((p) => p.full_name),
        }

        // Check each item on its own. Batching means one bad summary would
        // otherwise take the whole digest down with it.
        try {
          assertNoPronouns(renderItem(item, 1))
          digestItems.push(item)
        } catch (err) {
          console.warn(`  ${channel.name} thread ${convo.threadTs}: dropped from digest by copy guard — ${err instanceof Error ? err.message : err}`)
          console.warn(`    summary was: ${summary}`)
        }
      }

      const newestTs = messages.reduce((max, m) => (m.ts > max ? m.ts : max), since)
      if (!dryRun) {
        await db.from('echo_channel_scan').upsert({
          channel_id: channel.id,
          channel_name: channel.name,
          is_external: channel.is_ext_shared,
          last_scanned_ts: newestTs,
          last_run_at: new Date().toISOString(),
        })
      }
    }

    // One digest, sent once, after every channel has been scanned.
    if (digestItems.length) {
      const digest = buildDigest(digestItems, DIGEST_MAX_ITEMS)
      for (const recipient of recipients) {
        if (!recipient.slack_user_id) continue
        if (dryRun) {
          console.log(`\n--- would DM ${recipient.full_name} ---\n${digest}\n`)
          continue
        }
        try {
          await sendDm(recipient.slack_user_id, digest)
          dmsSent++
          console.log(`Digest sent to ${recipient.full_name} (${digestItems.length} item(s)).`)
        } catch (err) {
          console.error(`  DM to ${recipient.full_name} failed: ${err instanceof Error ? err.message : err}`)
        }
      }
    } else {
      console.log('Nothing worth flagging this run — no digest sent.')
    }

    console.log(JSON.stringify(
      { channelsScanned: channels.length, dormantSkipped, conversationsFound, classified, findingsWritten, digestItems: digestItems.length, dmsSent },
      null, 2,
    ))

    if (runId) {
      await db.from('echo_run').update({
        finished_at: new Date().toISOString(),
        ok: true,
        evidence_ingested: conversationsFound,
        findings_created: findingsWritten,
        nudges_sent: dmsSent,
      }).eq('id', runId)
    }
  } catch (err) {
    if (runId) {
      try {
        await db.from('echo_run').update({ finished_at: new Date().toISOString(), ok: false, error: String(err) }).eq('id', runId)
      } catch {
        console.error('(could not record the failure in echo_run)')
      }
    }
    throw err
  }
}

async function classifyConversation(convo: Conversation, nameBySlackId: Map<string, string>): Promise<Classification> {
  // Names, not ids. Everything the model can see, it can repeat.
  const transcript = convo.messages
    .map((m) => {
      const who = (m.user && nameBySlackId.get(m.user)) ?? 'a colleague'
      return `${who}: ${scrubSlackIds(m.text, nameBySlackId)}`
    })
    .join('\n')

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': ANTHROPIC_API_KEY!,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: ANTHROPIC_MODEL,
      max_tokens: 300,
      system:
        'You classify Slack conversations from a Shopify agency to spot GENUINE task-specific work gaps — ' +
        'not general work-adjacent chatter. Only flag a conversation if it contains one of these concrete things:\n' +
        '- A specific resource or time commitment (a named person, a deadline, a piece of work) that should be tracked\n' +
        '- An assignment or ownership gap that puts a deadline at risk\n' +
        '- A client request for new work, a change, or a fix that does not obviously already exist as a task\n' +
        '- Clear evidence someone is ready to act on a task that Teamwork shows as stale or unclear\n\n' +
        'Do NOT flag:\n' +
        '- Status updates or logistics ("missing standup," "will be at my desk," "following up soon")\n' +
        '- Arranging, moving or confirming meetings, calls and availability — scheduling is not a deliverable\n' +
        '- Requests to send, resend, re-upload or re-share something that already exists (files, fonts, videos, ' +
        'links, screenshots, logins) — handing over an existing asset is a two-minute favour, not tracked work\n' +
        '- ANY conversation about Teamwork itself: logging or adjusting time, updating or tidying tasks, chasing ' +
        'someone to use Teamwork, asking where a task lives. This is administration of the system, never a work gap\n' +
        '- Mentions that something is scheduled or pending without a concrete ask ("waiting to present to stakeholders")\n' +
        '- General check-ins or "just letting you know" messages with no decision or commitment attached\n' +
        '- Comments or feedback on a Teamwork task that ALREADY EXISTS and is simply being discussed — the task being ' +
        'referenced directly is itself evidence nothing is missing, even if people are still working out the details\n' +
        '- Internal decisions about how to handle a client (budget, scope, messaging) that produce no new deliverable or ' +
        'task of their own — these are judgment calls, not work gaps\n\n' +
        'Test: would this conversation, if read alone, tell you EXACTLY what task should be created or updated, and why it ' +
        'matters now? If not, it is not task-specific enough to flag, even if it mentions real project names or people.\n\n' +
        'Summary rules — these are hard requirements, not style preferences:\n' +
        '- Name the actual deliverable. If you cannot say WHAT the work is, set isTaskSpecific false. A summary ' +
        'containing "something", "a thing", "some work" or similar is proof the conversation was too vague to flag\n' +
        '- Name the person responsible where the messages make it clear. Do not write "someone" or "a user" as a ' +
        'substitute for a name you were given\n' +
        '- NEVER output a raw Slack user id (anything shaped like U01ABC2DEF) in the summary. If you only have an id ' +
        'and no name, describe the person by role or omit them entirely\n' +
        '- One sentence, plain English, no Slack formatting\n\n' +
        'Respond with ONLY a JSON object, no prose, no markdown fences: ' +
        '{"isTaskSpecific": boolean, "confidence": "high"|"medium"|"low", "summary": string, ' +
        '"likelyProjectOrClient": string|null}. ' +
        'Be conservative: when in doubt, mark isTaskSpecific false rather than low confidence — false negatives are far ' +
        'cheaper here than noise.',
      messages: [{ role: 'user', content: transcript }],
    }),
  })
  if (!res.ok) throw new Error(`Anthropic API ${res.status}: ${await res.text()}`)
  const data = await res.json()
  const text = data.content?.[0]?.text ?? '{}'
  return JSON.parse(text.replace(/```json|```/g, '').trim())
}

/**
 * Replaces Slack user references with names. Handles both the <@U123|name>
 * mention form and bare ids pasted into message text. The digit lookahead stops
 * ordinary shouty words like UNSUBSCRIBE being mangled — every Slack id has at
 * least one number in it.
 */
function scrubSlackIds(text: string, nameBySlackId: Map<string, string>): string {
  return text
    .replace(/<@([UW][A-Z0-9]+)(\|[^>]*)?>/g, (_m, id: string) => nameBySlackId.get(id) ?? 'a colleague')
    .replace(/\b(?=[UW][A-Z0-9]*\d)[UW][A-Z0-9]{6,}\b/g, (m: string) => nameBySlackId.get(m) ?? 'a colleague')
}

function buildPermalink(channelId: string, ts: string): string {
  return `${SLACK_WORKSPACE_URL}/archives/${channelId}/p${ts.replace('.', '')}`
}

function findMatchingTask(
  tasks: Task[],
  projectNames: Map<number, string>,
  summary: string,
  projectHint: string | null,
): TaskCandidate | null {
  const summaryWords = significantWords(summary)
  const hintWords = projectHint ? significantWords(projectHint) : []

  let best: { task: Task; score: number } | null = null

  for (const task of tasks) {
    const taskWords = significantWords(task.name)
    const projName = task.projectId != null ? projectNames.get(task.projectId) ?? '' : ''
    const projWords = significantWords(projName)

    let score = overlapCount(summaryWords, taskWords)
    if (hintWords.length && overlapCount(hintWords, projWords) > 0) score += 3

    if (score > 0 && (!best || score > best.score)) best = { task, score }
  }

  if (!best || best.score < 2) return null

  return {
    projectId: best.task.projectId,
    taskId: best.task.id,
    taskName: best.task.name,
    projectName: best.task.projectId != null ? projectNames.get(best.task.projectId) ?? null : null,
    updatedAt: best.task.updatedAt,
  }
}

function significantWords(text: string): string[] {
  const stop = new Set(['the', 'a', 'an', 'and', 'or', 'for', 'to', 'of', 'in', 'on', 'is', 'are', 'this', 'that', 'with'])
  return text.toLowerCase().match(/[a-z0-9]+/g)?.filter((w) => w.length > 2 && !stop.has(w)) ?? []
}

function overlapCount(a: string[], b: string[]): number {
  const setB = new Set(b)
  return a.filter((w) => setB.has(w)).length
}

async function assessStaleness(
  db: ReturnType<typeof echoDb>,
  taskId: number,
  fallbackUpdatedAt: string,
): Promise<'task_current' | 'task_stale'> {
  const { data, error } = await db
    .from('echo_v_stale_tasks')
    .select('teamwork_task_id')
    .eq('teamwork_task_id', taskId)
    .limit(1)
    .maybeSingle()

  if (error) {
    console.error(`  could not check echo_v_stale_tasks for task ${taskId}: ${error.message}`)
    const daysSince = (Date.now() - new Date(fallbackUpdatedAt).getTime()) / 86_400_000
    return daysSince > 14 ? 'task_stale' : 'task_current'
  }

  return data ? 'task_stale' : 'task_current'
}

function renderItem(item: TriageItem, position: number): string {
  const lines: string[] = []
  const heading = item.verdict === 'no_task_exists' ? 'Possible task gap' : 'Task has not moved in a while'

  lines.push(`*${position}. ${heading}* — <#${item.channelId}>`)
  lines.push(item.summary)
  if (item.taskUrl && item.taskName) lines.push(`<${item.taskUrl}|*${item.taskName}*>`)

  const meta: string[] = []
  if (item.permalink) meta.push(`<${item.permalink}|View the conversation>`)
  if (item.involvedNames.length) meta.push(`Involved: ${item.involvedNames.join(', ')}`)
  if (meta.length) lines.push(`_${meta.join(' · ')}_`)

  return lines.join('\n')
}

function buildDigest(items: TriageItem[], max: number): string {
  const shown = items.slice(0, max)
  const hidden = items.length - shown.length
  const label = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/London', weekday: 'short', day: 'numeric', month: 'short',
  }).format(new Date())

  const lines: string[] = []
  lines.push(`*Echo triage — ${label}* 🔍`)
  lines.push('')
  lines.push(items.length === 1
    ? 'One conversation worth a look from the latest scan.'
    : `${items.length} conversations worth a look from the latest scan.`)

  shown.forEach((item, i) => {
    lines.push('')
    lines.push('───────────')
    lines.push(renderItem(item, i + 1))
  })

  if (hidden > 0) {
    lines.push('')
    lines.push(ECHO_URL ? `_+ ${hidden} more · <${ECHO_URL}|see the full list>_` : `_+ ${hidden} more in Echo._`)
  }

  return lines.join('\n')
}

function slackTsFromDaysAgo(days: number): string {
  return (Date.now() / 1000 - days * 86_400).toFixed(6)
}

main().catch((e) => {
  console.error('\n=== TRIAGE FAILED ===')
  console.error(e instanceof Error ? e.message : e)
  if (e instanceof Error && e.stack) console.error(e.stack.split('\n').slice(1, 4).join('\n'))
  process.exit(1)
})

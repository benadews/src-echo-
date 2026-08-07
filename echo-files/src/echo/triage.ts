import { echoDb } from './lib/supabase'
import { teamwork, type Task } from './lib/teamwork'
import { listBotChannels, getHistorySince, getThreadReplies, getPermalink, sendDm } from './lib/slack'
import { assertNoPronouns } from './copy'
import { londonDay } from './lib/dates'

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY
const ANTHROPIC_MODEL = 'claude-sonnet-4-5' // confirm against whatever Vector's brief analyser uses
const FIRST_SCAN_LOOKBACK_DAYS = 3 // a channel's first-ever scan only looks back this far, not full history

type SlackMessage = { ts: string; user?: string; text: string; thread_ts?: string; reply_count?: number }
type Conversation = { channelId: string; channelName: string; threadTs: string; messages: SlackMessage[] }
type Classification = {
  isTaskSpecific: boolean
  confidence: 'high' | 'medium' | 'low'
  summary: string
  likelyProjectOrClient: string | null
  participantsMentioned: string[]
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
 * ones sound like real task-specific work, cross-checks Teamwork, and DMs the
 * staff involved when confident there's a gap — no task exists, or one
 * exists but has gone stale (reusing sweep's own dwell-breach definition,
 * echo_v_stale_tasks, rather than a separate threshold).
 *
 * A channel's first-ever scan is bounded to FIRST_SCAN_LOOKBACK_DAYS rather
 * than full history — without this, day one on an old channel means reading
 * years of messages and classifying all of them, which is slow and burns
 * API credit on conversations long since resolved.
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
      .select('id, full_name, slack_user_id, is_staff')
      .eq('is_staff', true)
    if (staffErr) throw new Error(`Cannot read echo_person: ${staffErr.message}`)
    const staffBySlackId = new Map((staff ?? []).filter((p) => p.slack_user_id).map((p) => [p.slack_user_id as string, p]))

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

    for (const channel of channels) {
      const checkpoint = await db
        .from('echo_channel_scan')
        .select('last_scanned_ts')
        .eq('channel_id', channel.id)
        .maybeSingle()
      if (checkpoint.error) throw new Error(`Cannot read echo_channel_scan: ${checkpoint.error.message}`)

      const since = checkpoint.data?.last_scanned_ts ?? slackTsFromDaysAgo(FIRST_SCAN_LOOKBACK_DAYS)

      let messages: SlackMessage[]
      try {
        messages = await getHistorySince(channel.id, since)
      } catch (err) {
        console.error(`  ${channel.name}: history fetch failed — ${err instanceof Error ? err.message : err}`)
        continue
      }

      if (!messages.length) {
        await db.from('echo_channel_scan').upsert({
          channel_id: channel.id,
          channel_name: channel.name,
          is_external: channel.is_ext_shared,
          last_run_at: new Date().toISOString(),
        })
        continue
      }

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
        conversations.push({ channelId: channel.id, channelName: channel.name, threadTs: msg.ts, messages: thread })
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
        const permalink = await getPermalink(convo.channelId, convo.threadTs)

        const peopleInvolved = result.participantsMentioned
          .map((slackId) => staffBySlackId.get(slackId))
          .filter((p): p is NonNullable<typeof p> => Boolean(p))

        if (!dryRun) {
          const ins = await db.from('echo_triage_finding').insert({
            channel_id: convo.channelId,
            channel_name: convo.channelName,
            thread_ts: convo.threadTs,
            slack_permalink: permalink,
            summary: result.summary,
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
          console.log(`\n--- would flag (${verdict}, ${result.confidence}) ---\n${result.summary}\n`)
        }

        for (const person of peopleInvolved) {
          if (!person.slack_user_id) continue
          const text = buildTriageMessage(verdict, result.summary, teamworkTaskUrl, permalink)
          assertNoPronouns(text)
          if (dryRun) {
            console.log(`--- would DM ${person.full_name} ---\n${text}\n`)
            continue
          }
          try {
            await sendDm(person.slack_user_id, text)
            dmsSent++
          } catch (err) {
            console.error(`  DM to ${person.full_name} failed: ${err instanceof Error ? err.message : err}`)
          }
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

    console.log(JSON.stringify({ channelsScanned: channels.length, conversationsFound, classified, findingsWritten, dmsSent }, null, 2))

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

async function classifyConversation(convo: Conversation): Promise<Classification> {
  const transcript = convo.messages.map((m) => `${m.user ?? 'unknown'}: ${m.text}`).join('\n')

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': ANTHROPIC_API_KEY!,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: ANTHROPIC_MODEL,
      max_tokens: 400,
      system:
        'You classify Slack conversations from a Shopify agency to spot task-specific work discussion — ' +
        'e.g. a client asking for a change, a bug being discussed, work being agreed — as opposed to general ' +
        'chat, banter, scheduling, or internal admin. Respond with ONLY a JSON object, no prose, no markdown fences: ' +
        '{"isTaskSpecific": boolean, "confidence": "high"|"medium"|"low", "summary": string (one sentence, plain English), ' +
        '"likelyProjectOrClient": string|null, "participantsMentioned": string[] (Slack user IDs of people actually doing/requesting the work, not just present)}. ' +
        'Be conservative: mark confidence "low" for anything ambiguous rather than guessing.',
      messages: [{ role: 'user', content: transcript }],
    }),
  })
  if (!res.ok) throw new Error(`Anthropic API ${res.status}: ${await res.text()}`)
  const data = await res.json()
  const text = data.content?.[0]?.text ?? '{}'
  return JSON.parse(text.replace(/```json|```/g, '').trim())
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

/**
 * Reuses sweep's own dwell-breach view rather than a separate threshold —
 * "stale" means the same thing everywhere in Echo. Falls back to a generous
 * 14-day recency check only if the view itself can't be read.
 */
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

function buildTriageMessage(verdict: string, summary: string, taskUrl: string | null, slackPermalink: string | null): string {
  const lines: string[] = []
  if (verdict === 'no_task_exists') {
    lines.push(`Spotted a conversation that sounds like work with no matching task in Teamwork:`)
    lines.push(summary)
    lines.push(`Worth creating a task for this, or is it already covered somewhere I've missed?`)
  } else {
    lines.push(`Spotted a conversation about a task that hasn't been updated in a while:`)
    lines.push(summary)
    if (taskUrl) lines.push(taskUrl)
  }
  if (slackPermalink) lines.push(`Original conversation: ${slackPermalink}`)
  return lines.join('\n')
}

/** Slack timestamps are seconds.microseconds since epoch, as a string. */
function slackTsFromDaysAgo(days: number): string {
  return (Date.now() / 1000 - days * 86_400).toFixed(6)
}

main().catch((e) => {
  console.error('\n=== TRIAGE FAILED ===')
  console.error(e instanceof Error ? e.message : e)
  if (e instanceof Error && e.stack) console.error(e.stack.split('\n').slice(1, 4).join('\n'))
  process.exit(1)
})

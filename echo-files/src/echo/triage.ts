import { echoDb } from './lib/supabase'
import { teamwork, type Task } from './lib/teamwork'
import { listBotChannels, getHistorySince, getThreadReplies, getPermalink, getLatestMessageTs, sendDm } from './lib/slack'
import { assertNoPronouns } from './copy'
import { londonDay } from './lib/dates'

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY
const ANTHROPIC_MODEL = 'claude-sonnet-4-5'
const FIRST_SCAN_LOOKBACK_DAYS = 3
const DORMANT_AFTER_DAYS = 30
const TESTING_RECIPIENT_EMAIL = 'ben@wetakeflight.co.uk'

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

        const text = buildTriageMessage({
          verdict,
          channelId: convo.channelId,
          summary: result.summary,
          taskUrl: teamworkTaskUrl,
          taskName: teamworkMatch?.taskName ?? null,
          permalink,
          involvedNames: peopleInvolved.map((p) => p.full_name),
        })
        assertNoPronouns(text)

        for (const admin of superAdmins) {
          if (!admin.slack_user_id) continue
          if (dryRun) {
            console.log(`--- would DM ${admin.full_name} ---\n${text}\n`)
            continue
          }
          try {
            await sendDm(admin.slack_user_id, text)
            dmsSent++
          } catch (err) {
            console.error(`  DM to ${admin.full_name} failed: ${err instanceof Error ? err.message : err}`)
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

    console.log(JSON.stringify(
      { channelsScanned: channels.length, dormantSkipped, conversationsFound, classified, findingsWritten, dmsSent },
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
      max_tokens: 300,
      system:
        'You classify Slack conversations from a Shopify agency to spot GENUINE task-specific work gaps — ' +
        'not general work-adjacent chatter. Only flag a conversation if it contains one of these concrete things:\n' +
        '- A specific resource or time commitment (a named person, a deadline, a piece of work) that should be tracked\n' +
        '- An assignment or ownership gap that puts a deadline at risk\n' +
        '- Clear evidence someone is ready to act on a task that Teamwork shows as stale or unclear\n\n' +
        'Do NOT flag:\n' +
        '- Status updates or logistics ("missing standup," "will be at my desk," "following up soon")\n' +
        '- Mentions that something is scheduled or pending without a concrete ask ("waiting to present to stakeholders")\n' +
        '- General check-ins or "just letting you know" messages with no decision or commitment attached\n\n' +
        'Test: would this conversation, if read alone, tell you EXACTLY what task should be created or updated, and why it ' +
        'matters now? If not, it is not task-specific enough to flag, even if it mentions real project names or people.\n\n' +
        'Respond with ONLY a JSON object, no prose, no markdown fences: ' +
        '{"isTaskSpecific": boolean, "confidence": "high"|"medium"|"low", "summary": string (one sentence, plain English), ' +
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

function buildTriageMessage(opts: {
  verdict: string
  channelId: string
  summary: string
  taskUrl: string | null
  taskName: string | null
  permalink: string | null
  involvedNames: string[]
}): string {
  const { verdict, channelId, summary, taskUrl, taskName, permalink, involvedNames } = opts
  const lines: string[] = []

  if (verdict === 'no_task_exists') {
    lines.push(`*Possible task gap spotted* 🔍`)
    lines.push('')
    lines.push(`In <#${channelId}>:`)
    lines.push(summary)
    lines.push('')
    lines.push('Worth creating a task for this, or is it already covered somewhere?')
  } else {
    lines.push(`*Task hasn't moved in a while* 🕓`)
    lines.push('')
    lines.push(`In <#${channelId}>:`)
    lines.push(summary)
    if (taskUrl && taskName) {
      lines.push('')
      lines.push(`<${taskUrl}|*${taskName}*>`)
    }
  }

  if (permalink) {
    lines.push('')
    lines.push(`_<${permalink}|View the conversation>_`)
  }

  if (involvedNames.length) {
    lines.push('')
    lines.push(`_Involved: ${involvedNames.join(', ')}_`)
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

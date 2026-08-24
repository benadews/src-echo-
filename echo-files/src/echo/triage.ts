import { echoDb } from './lib/supabase'
import { teamwork, type Task } from './lib/teamwork'
import { listBotChannels, getHistorySince, getThreadReplies, getPermalink, getLatestMessageTs, sendDm, lookupByEmail } from './lib/slack'
import { assertTriageCopy } from './copy'
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

// One DM per run, not one per finding.
const DIGEST_MAX_ITEMS = 8

// Channels that will never map to a Teamwork project. Suppresses the
// "is this project in Teamwork?" flag only — conversations in them are still
// read and can still raise a task gap.
// Anything containing "internal" is covered by the substring rule below.
const NEVER_A_PROJECT_EXACT = new Set(['general', 'random', 'team-support'])
const NEVER_A_PROJECT_CONTAINS = ['internal', 'loyaltylion', 'getbetter', 'refactor', 'partner', 'clearerio']

const TW = process.env.TEAMWORK_BASE_URL ?? 'https://wetakeflight.eu.teamwork.com'
const ECHO_URL = process.env.ECHO_DASHBOARD_URL ?? ''
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
type Verdict = 'no_task_exists' | 'task_stale' | 'task_current' | 'project_unknown'
type ProjectResolution =
  | { kind: 'resolved'; projectId: number; projectName: string; via: 'override' | 'name' }
  | { kind: 'ambiguous'; candidates: string[] }
  | { kind: 'none' }
type TriageItem = {
  verdict: Verdict
  channelId: string
  channelName: string
  summary: string
  projectName: string | null
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

    // Slack id -> human name, so raw ids never reach the model or a summary.
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

    // Resolve each recipient independently. One person misconfigured must not
    // silence everybody else — from the outside that looks like Echo dying.
    const recipients: { full_name: string; slack_user_id: string | null }[] = []
    for (const email of TRIAGE_RECIPIENT_EMAILS) {
      const profile = superAdminProfiles.find((sa) => sa.email?.toLowerCase() === email)
      if (!profile) {
        console.warn(`  warning: ${email} is not a super_admin in profiles — skipped.`)
        continue
      }
      const echoMatch = staffByEmail.get(email)
      if (!echoMatch) {
        console.warn(`  warning: ${email} is a super_admin but did not match an echo_person by email — skipped.`)
        continue
      }

      // Self-heal a missing Slack id rather than silently skipping. The nudge
      // script has always done this; triage did not, which is how Chris was
      // configured correctly everywhere and still received nothing.
      let slackId = echoMatch.slack_user_id as string | null
      if (!slackId && echoMatch.email) {
        try {
          slackId = await lookupByEmail(echoMatch.email)
          if (slackId) {
            await db.from('echo_person').update({ slack_user_id: slackId }).eq('id', echoMatch.id)
            console.log(`  resolved and cached Slack id for ${echoMatch.full_name}.`)
          }
        } catch (err) {
          console.warn(`  Slack lookup failed for ${echoMatch.email}: ${err instanceof Error ? err.message : err}`)
        }
      }
      if (!slackId) console.warn(`  warning: no Slack account found for ${echoMatch.full_name} — skipped when sending.`)

      recipients.push({ full_name: profile.full_name ?? echoMatch.full_name, slack_user_id: slackId })
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

    // Tasks bucketed by project. Scoring a summary against all 905 open tasks
    // is what produced the Limner task attached to a SHIFT conversation —
    // with a pool that large, any two shared words look like a match.
    const tasksByProject = new Map<number, Task[]>()
    for (const task of openTasks) {
      if (task.projectId == null) continue
      const bucket = tasksByProject.get(task.projectId)
      if (bucket) bucket.push(task)
      else tasksByProject.set(task.projectId, [task])
    }

    const projectKeys = buildProjectKeys(projectList)

    console.log('Listing bot channels...')
    const channels = await listBotChannels()
    console.log(`${channels.length} channel(s) visible to the bot.`)

    let conversationsFound = 0
    let classified = 0
    let findingsWritten = 0
    let dmsSent = 0
    let dormantSkipped = 0
    let notInChannel = 0
    const digestItems: TriageItem[] = []
    // "Is this project in Teamwork?" is an observation about a channel, not
    // about a conversation. Ten live threads in Croft Mill is one question.
    const channelsAlreadyQueried = new Set<string>()

    for (const channel of channels) {
      const checkpoint = await db
        .from('echo_channel_scan')
        .select('last_scanned_ts, teamwork_project_id, is_excluded')
        .eq('channel_id', channel.id)
        .maybeSingle()
      if (checkpoint.error) throw new Error(`Cannot read echo_channel_scan: ${checkpoint.error.message}`)

      let latestTs: string | null
      try {
        latestTs = await getLatestMessageTs(channel.id)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        // The bot is not a member. Nothing to be done in code — someone has to
        // invite it — so log quietly rather than as an error.
        if (msg.includes('not_in_channel')) {
          notInChannel++
          console.log(`  ${channel.name}: bot is not a member — invite it to scan this channel`)
        } else {
          console.error(`  ${channel.name}: latest-message check failed — ${msg}`)
        }
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

      // Work out which project this channel belongs to, once per channel.
      const resolution = resolveProject(channel.name, checkpoint.data?.teamwork_project_id ?? null, projectKeys, projectNames)
      const excluded = checkpoint.data?.is_excluded === true || isNeverAProject(channel.name)
      if (resolution.kind === 'resolved') {
        console.log(`  ${channel.name}: project = ${resolution.projectName} (via ${resolution.via})`)
      } else if (resolution.kind === 'ambiguous') {
        console.log(`  ${channel.name}: matches ${resolution.candidates.length} projects (${resolution.candidates.join(', ')}) — treating as unresolved, set teamwork_project_id to pin it`)
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
        // limit(1) rather than maybeSingle(): duplicate rows for one thread
        // would make maybeSingle throw rather than report "seen it".
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

        const summary = scrubSlackIds(result.summary, nameBySlackId)

        let verdict: Verdict
        let teamworkMatch: TaskCandidate | null = null

        if (resolution.kind === 'resolved') {
          // Search only this project's tasks. Two shared words means something
          // in a pool of forty; it means nothing in a pool of nine hundred.
          const pool = tasksByProject.get(resolution.projectId) ?? []
          teamworkMatch = findMatchingTask(pool, projectNames, summary)
          if (teamworkMatch) {
            const staleness = await assessStaleness(db, teamworkMatch.taskId, teamworkMatch.updatedAt)
            if (staleness === 'task_current') continue
            verdict = 'task_stale'
          } else {
            verdict = 'no_task_exists'
          }
        } else if (excluded) {
          // Internal or partner channel — no project expected, so the only
          // useful question is whether a task should exist.
          verdict = 'no_task_exists'
        } else {
          // Real work, in a client-facing channel, that maps to no active
          // project. Either the project was never created, the channel is
          // named unrecognisably, or work is continuing on something closed.
          if (channelsAlreadyQueried.has(convo.channelId)) continue
          channelsAlreadyQueried.add(convo.channelId)
          verdict = 'project_unknown'
        }

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

        const resolvedProjectId = resolution.kind === 'resolved' ? resolution.projectId : null
        const resolvedProjectName = resolution.kind === 'resolved' ? resolution.projectName : null

        if (!dryRun) {
          const ins = await db.from('echo_triage_finding').insert({
            channel_id: convo.channelId,
            channel_name: convo.channelName,
            thread_ts: convo.threadTs,
            slack_permalink: permalink,
            summary,
            verdict,
            confidence: result.confidence,
            teamwork_project_id: teamworkMatch?.projectId ?? resolvedProjectId,
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
          console.log(`\n--- would flag (${verdict}, ${result.confidence}) in #${convo.channelName} ---\n${summary}\n`)
        }

        const item: TriageItem = {
          verdict,
          channelId: convo.channelId,
          channelName: convo.channelName,
          summary,
          projectName: resolvedProjectName,
          taskUrl: teamworkTaskUrl,
          taskName: teamworkMatch?.taskName ?? null,
          permalink,
          involvedNames: peopleInvolved.map((p) => p.full_name),
        }

        // Check each item alone. Batching means one bad summary would
        // otherwise take the whole digest down with it. Triage uses the
        // reduced rule set — a summary saying a client chased missing images
        // is accurate reporting, not Echo accusing anyone of anything.
        try {
          assertTriageCopy(renderItem(item, 1))
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
      { channelsScanned: channels.length, notInChannel, dormantSkipped, conversationsFound, classified, findingsWritten, digestItems: digestItems.length, dmsSent },
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

/* ------------------------------------------------------------------ *
 * Channel → project resolution
 * ------------------------------------------------------------------ */

/**
 * Reduces a project name to the client part: everything before the first
 * separator. "Saicho - On Going Support" becomes "saicho", "British Bridal :
 * Migrate, Design & Build" becomes "british bridal". Splitting BEFORE
 * normalising matters — normalising first would turn every hyphen into a space
 * and there would be nothing left to split on.
 */
function projectKey(name: string): string[] {
  const head = name.split(/\s+[-:]\s+/)[0] ?? name
  return normaliseTokens(head)
}

/**
 * Lowercases, expands "&" to "and" (so #rose-and-walker reaches "Rose &
 * Walker"), drops apostrophes so PACK'D reaches #packd, then splits on
 * anything that is not alphanumeric.
 */
function normaliseTokens(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/['’]/g, '')
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
}

function channelTokens(channelName: string): string[] {
  // "wtf" is the agency's own prefix and appears in client channels at either
  // end — #wtf-luxus-beds, #travelling-man-wtf. It carries no meaning here.
  return normaliseTokens(channelName).filter((t) => t !== 'wtf')
}

function buildProjectKeys(projects: { id: number; name: string }[]): { id: number; name: string; key: string[] }[] {
  return projects
    .map((p) => ({ id: p.id, name: p.name, key: projectKey(p.name) }))
    .filter((p) => p.key.length > 0)
}

/** Contiguous subsequence test — "flux" matches #flux but not #influx. */
function containsSequence(haystack: string[], needle: string[]): boolean {
  if (!needle.length || needle.length > haystack.length) return false
  for (let i = 0; i <= haystack.length - needle.length; i++) {
    let ok = true
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) { ok = false; break }
    }
    if (ok) return true
  }
  return false
}

function resolveProject(
  channelName: string,
  override: number | null,
  projectKeys: { id: number; name: string; key: string[] }[],
  projectNames: Map<number, string>,
): ProjectResolution {
  if (override != null) {
    const name = projectNames.get(override)
    if (name) return { kind: 'resolved', projectId: override, projectName: name, via: 'override' }
    console.warn(`  ${channelName}: teamwork_project_id ${override} is set but is not an active project — falling back to name matching`)
  }

  const tokens = channelTokens(channelName)
  const hits = projectKeys.filter((p) => containsSequence(tokens, p.key))
  if (!hits.length) return { kind: 'none' }

  // Longest key wins: #wtf-luxus-beds-design-build-morf should resolve to
  // Luxus Beds on two tokens, not to something matching a single token.
  const longest = Math.max(...hits.map((h) => h.key.length))
  const best = hits.filter((h) => h.key.length === longest)

  // A tie between different projects cannot be broken from the name alone —
  // #saicho genuinely matches two Saicho projects, and guessing wrong is the
  // exact failure this whole change exists to prevent.
  if (best.length > 1) return { kind: 'ambiguous', candidates: best.map((b) => b.name) }

  return { kind: 'resolved', projectId: best[0].id, projectName: best[0].name, via: 'name' }
}

function isNeverAProject(channelName: string): boolean {
  const n = channelName.toLowerCase()
  if (NEVER_A_PROJECT_EXACT.has(n)) return true
  return NEVER_A_PROJECT_CONTAINS.some((frag) => n.includes(frag))
}

/* ------------------------------------------------------------------ *
 * Classification
 * ------------------------------------------------------------------ */

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
        '- Never use he, him, his, she, her or hers. Refer to people by name, or by role if no name is available\n' +
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
 * Replaces Slack user references with names. Handles the <@U123|name> mention
 * form and bare ids pasted into text. The digit lookahead stops ordinary shouty
 * words being mangled — every Slack id contains at least one number.
 */
function scrubSlackIds(text: string, nameBySlackId: Map<string, string>): string {
  return text
    .replace(/<@([UW][A-Z0-9]+)(\|[^>]*)?>/g, (_m, id: string) => nameBySlackId.get(id) ?? 'a colleague')
    .replace(/\b(?=[UW][A-Z0-9]*\d)[UW][A-Z0-9]{6,}\b/g, (m: string) => nameBySlackId.get(m) ?? 'a colleague')
}

function buildPermalink(channelId: string, ts: string): string {
  return `${SLACK_WORKSPACE_URL}/archives/${channelId}/p${ts.replace('.', '')}`
}

/* ------------------------------------------------------------------ *
 * Task matching, within a known project
 * ------------------------------------------------------------------ */

function findMatchingTask(
  tasks: Task[],
  projectNames: Map<number, string>,
  summary: string,
): TaskCandidate | null {
  const summaryWords = significantWords(summary)

  let best: { task: Task; score: number } | null = null
  for (const task of tasks) {
    const score = overlapCount(summaryWords, significantWords(task.name))
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

/* ------------------------------------------------------------------ *
 * Digest
 * ------------------------------------------------------------------ */

function headingFor(verdict: Verdict): string {
  if (verdict === 'task_stale') return '🕓 Task has not moved in a while'
  if (verdict === 'project_unknown') return '❓ Is this project in Teamwork?'
  return '🔍 Possible task gap'
}

function renderItem(item: TriageItem, position: number): string {
  const lines: string[] = []
  lines.push(`*${position}. ${headingFor(item.verdict)}* — <#${item.channelId}>`)
  lines.push(item.summary)

  if (item.verdict === 'project_unknown') {
    lines.push('No active Teamwork project matches this channel. Should there be one, or does the channel need mapping?')
  } else if (item.taskUrl && item.taskName) {
    lines.push(`<${item.taskUrl}|*${item.taskName}*>`)
  }

  const meta: string[] = []
  if (item.projectName) meta.push(item.projectName)
  if (item.permalink) meta.push(`<${item.permalink}|View the conversation>`)
  if (item.involvedNames.length) meta.push(`Involved: ${item.involvedNames.join(', ')}`)
  if (meta.length) lines.push(`_${meta.join(' · ')}_`)

  return lines.join('\n')
}

function buildDigest(items: TriageItem[], max: number): string {
  // Project questions last — they are structural, not day-to-day.
  const ordered = [...items].sort((a, b) => {
    const rank = (v: Verdict) => (v === 'project_unknown' ? 1 : 0)
    return rank(a.verdict) - rank(b.verdict)
  })
  const shown = ordered.slice(0, max)
  const hidden = ordered.length - shown.length
  const label = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/London', weekday: 'short', day: 'numeric', month: 'short',
  }).format(new Date())

  const lines: string[] = []
  lines.push(`*Echo triage — ${label}*`)
  lines.push('')
  lines.push(ordered.length === 1
    ? 'One conversation worth a look from the latest scan.'
    : `${ordered.length} conversations worth a look from the latest scan.`)

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

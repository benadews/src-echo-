import { echoDb } from './lib/supabase'
import { teamwork, type Task } from './lib/teamwork'
import { listBotChannels, getHistorySince, getThreadReplies, getPermalink, sendDm } from './lib/slack'
import { assertNoPronouns } from './copy'
import { londonDay } from './lib/dates'

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY
const ANTHROPIC_MODEL = 'claude-sonnet-4-5' // confirm against whatever Vector's brief analyser uses

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

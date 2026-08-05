import { echoDb } from './lib/supabase'
import { teamwork } from './lib/teamwork'
import { staffByTeamworkId } from './roles'
import { ingestActivities } from './ingest/activities'
import { ingestTimelogs } from './ingest/timelogs'
import { ingestMentions } from './ingest/mentions'
import { snapshotStages } from './ingest/stages'
import { detectActiveDays } from './detectors/active-day'
import { detectStageDwell } from './detectors/stage-dwell'
import { detectSilence } from './detectors/silence'
import { daysAgo, today, londonDay } from './lib/dates'

/**
 * Echo sweep — Phase 1. Detection only. Sends nothing.
 *
 * Every database call reports its own error rather than silently returning
 * null. An earlier version crashed while trying to RECORD a failure, which hid
 * the real cause — so error handling here is deliberately loud and explicit.
 */
async function main() {
  const db = echoDb()

  // Prove the connection before anything else, with a message that says what to
  // do rather than just what broke.
  const probe = await db.from('echo_person').select('id, full_name, is_staff').eq('is_staff', true)
  if (probe.error) {
    throw new Error(
      `Cannot read echo_person: ${probe.error.message}\n` +
      `  -> Either the schema has not been run in Supabase, or SUPABASE_SERVICE_ROLE_KEY is not the secret key.`,
    )
  }
  console.log(`Connected. ${probe.data?.length ?? 0} staff found.`)
  if (!probe.data?.length) {
    throw new Error('No staff rows in echo_person — did the schema seed run?')
  }

  const cfg = await db.from('echo_config').select('*').eq('id', 1).maybeSingle()
  if (cfg.error) throw new Error(`Cannot read echo_config: ${cfg.error.message}`)
  const windowDays: number = cfg.data?.window_days ?? 14

  // Write test. If this fails the key is readable but not writable, which means
  // it is the publishable key rather than the secret one.
  const runIns = await db
    .from('echo_run')
    .insert({ kind: 'sweep', github_run_id: process.env.GITHUB_RUN_ID ?? null })
    .select('id')
    .maybeSingle()
  if (runIns.error) {
    throw new Error(
      `Cannot write to echo_run: ${runIns.error.message}\n` +
      `  -> The key can read but not write. Use the SECRET key from Supabase (the one hidden behind Reveal), not the publishable one.`,
    )
  }
  const runId: string | null = runIns.data?.id ?? null
  if (!runId) console.warn('echo_run insert returned no row; continuing without run tracking.')

  // Today is excluded: a day still in progress always looks unlogged.
  const toDay = londonDay(new Date(Date.now() - 86_400_000))
  const fromDay = daysAgo(windowDays)

  try {
    const staff = await staffByTeamworkId(db)

    const priorRuns = await db
      .from('echo_run')
      .select('id', { count: 'exact', head: true })
      .eq('kind', 'sweep')
      .eq('ok', true)
    const firstRun = (priorRuns.count ?? 0) === 0

    console.log(`Window ${fromDay}..${toDay}. First run: ${firstRun}.`)

    const acts = await teamwork.activities({ start: fromDay, end: today() })
    console.log(`Teamwork activity rows: ${acts.length}`)

    const projectList = await teamwork.projects()
    const projectNames = new Map(projectList.map((p) => [p.id, p.name]))
    console.log(`Projects: ${projectNames.size}`)

    const ev = await ingestActivities(db, teamwork, staff, fromDay, toDay)
    const tl = await ingestTimelogs(db, teamwork, staff, fromDay, toDay)
    const mn = await ingestMentions(db, acts, staff)
    const st = await snapshotStages(db, teamwork, staff, { seedLegacy: firstRun })
    const ad = await detectActiveDays(db, fromDay, toDay, projectNames)
    const sd = await detectStageDwell(db)
    // Absence, not presence: catches whoever is working outside Teamwork
    // entirely, who every other detector is blind to by definition.
    const si = await detectSilence(db, cfg.data?.silence_days ?? 7)

    console.log(JSON.stringify(
      { window: `${fromDay}..${toDay}`, firstRun, activity: ev, timelogs: tl,
        mentions: mn, stages: st, activeDays: ad, stageDwell: sd, silence: si }, null, 2))

    if (runId) {
      await db.from('echo_run').update({
        finished_at: new Date().toISOString(),
        ok: true,
        evidence_ingested: ev.inserted,
        findings_created: ad.raised + sd.breaches,
        nudges_sent: 0,
      }).eq('id', runId)
    }
  } catch (err) {
    // Record the failure if we can, but NEVER let that reporting hide the
    // original error — which is exactly the bug this replaces.
    if (runId) {
      try {
        await db.from('echo_run').update({
          finished_at: new Date().toISOString(), ok: false, error: String(err),
        }).eq('id', runId)
      } catch {
        console.error('(could not record the failure in echo_run)')
      }
    }
    throw err
  }
}

main().catch((e) => {
  console.error('\n=== SWEEP FAILED ===')
  console.error(e instanceof Error ? e.message : e)
  if (e instanceof Error && e.stack) console.error(e.stack.split('\n').slice(1, 4).join('\n'))
  process.exit(1)
})

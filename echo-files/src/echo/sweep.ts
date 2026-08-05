import { echoDb } from './lib/supabase'
import { teamwork } from './lib/teamwork'
import { staffByTeamworkId } from './roles'
import { ingestActivities } from './ingest/activities'
import { ingestTimelogs } from './ingest/timelogs'
import { ingestMentions } from './ingest/mentions'
import { snapshotStages } from './ingest/stages'
import { detectActiveDays } from './detectors/active-day'
import { detectStageDwell } from './detectors/stage-dwell'
import { daysAgo, today, londonDay } from './lib/dates'

/**
 * Echo sweep — Phase 1. Detection only.
 *
 * Sends nothing. echo_config.nudges_enabled ships false and the nudge composer
 * is a separate workflow, so this can run for a fortnight while the findings
 * are reviewed against the under-10%-false-positive gate before anyone is
 * messaged.
 */
async function main() {
  const db = echoDb()
  const startedAt = new Date().toISOString()

  const { data: cfg } = await db.from('echo_config').select('*').eq('id', 1).single()
  const windowDays: number = cfg?.window_days ?? 14

  // Today is excluded: a day still in progress always looks unlogged.
  const toDay = londonDay(new Date(Date.now() - 86_400_000))
  const fromDay = daysAgo(windowDays)

  const { data: run } = await db
    .from('echo_run')
    .insert({ kind: 'sweep', started_at: startedAt, github_run_id: process.env.GITHUB_RUN_ID ?? null })
    .select('id')
    .single()

  try {
    const staff = await staffByTeamworkId(db)
    if (staff.size === 0) throw new Error('no staff in echo_person — run the opex role sync first')

    // Is this the first ever sweep? If so, anything already past its stage
    // tolerance becomes the legacy amnesty cohort.
    const { count: priorRuns } = await db
      .from('echo_run')
      .select('id', { count: 'exact', head: true })
      .eq('kind', 'sweep')
      .eq('ok', true)
    const firstRun = (priorRuns ?? 0) === 0

    const acts = await teamwork.activities({ start: fromDay, end: today() })
    const ev = await ingestActivities(db, teamwork, staff, fromDay, toDay)
    const tl = await ingestTimelogs(db, teamwork, staff, fromDay, toDay)
    const mn = await ingestMentions(db, acts, staff)
    const st = await snapshotStages(db, teamwork, staff, { seedLegacy: firstRun })

    const ad = await detectActiveDays(db, fromDay, toDay)
    const sd = await detectStageDwell(db)

    const summary = {
      window: `${fromDay}..${toDay}`,
      firstRun,
      activity: ev,
      timelogs: tl,
      mentions: mn,
      stages: st,
      activeDays: ad,
      stageDwell: sd,
    }
    console.log(JSON.stringify(summary, null, 2))

    await db
      .from('echo_run')
      .update({
        finished_at: new Date().toISOString(),
        ok: true,
        evidence_ingested: ev.inserted,
        findings_created: ad.raised + sd.breaches,
        nudges_sent: 0,
      })
      .eq('id', run!.id)
  } catch (err) {
    await db
      .from('echo_run')
      .update({ finished_at: new Date().toISOString(), ok: false, error: String(err) })
      .eq('id', run!.id)
    throw err
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})

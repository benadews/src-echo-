/**
 * Every "day" in Echo is a Europe/London calendar day.
 *
 * This module exists because getting it wrong is silent and corrupting. The
 * crons run in UTC, the Teamwork API returns UTC timestamps, and the question
 * Echo asks is "was there activity on day X with no time recorded on day X".
 * A naive `.slice(0,10)` on a UTC string puts 00:30 BST activity on the
 * previous day and Echo then asks about a day the person did not work.
 */

const LONDON = 'Europe/London'

const dayFmt = new Intl.DateTimeFormat('en-CA', {
  timeZone: LONDON,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
})

/** ISO date (YYYY-MM-DD) of an instant, in London local time. */
export function londonDay(iso: string | Date): string {
  const d = typeof iso === 'string' ? new Date(iso) : d0(iso)
  return dayFmt.format(d)
}

function d0(d: Date) {
  return d
}

/** ISO weekday, 1 = Monday .. 7 = Sunday, in London local time. */
export function londonWeekday(day: string): number {
  // Parse as noon UTC to stay clear of DST edges either side of midnight.
  const d = new Date(`${day}T12:00:00Z`)
  const wd = d.getUTCDay()
  return wd === 0 ? 7 : wd
}

export function isWeekend(day: string): boolean {
  return londonWeekday(day) >= 6
}

/** Inclusive list of ISO days, oldest first. */
export function dayRange(fromDay: string, toDay: string): string[] {
  const out: string[] = []
  const cur = new Date(`${fromDay}T12:00:00Z`)
  const end = new Date(`${toDay}T12:00:00Z`)
  while (cur <= end) {
    out.push(cur.toISOString().slice(0, 10))
    cur.setUTCDate(cur.getUTCDate() + 1)
  }
  return out
}

export function daysAgo(n: number): string {
  const d = new Date()
  d.setUTCDate(d.getUTCDate() - n)
  return londonDay(d)
}

export function today(): string {
  return londonDay(new Date())
}

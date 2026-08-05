/**
 * Message composition.
 *
 * Two rules from the communication model are enforced here rather than left to
 * whoever edits the strings:
 *
 *  1. NO THIRD-PERSON PRONOUNS, EVER. Echo has no gender data and must not
 *     infer it from a name. In a DM it is always "you"; a third party is always
 *     named. `assertNoPronouns` is run over every composed message and in CI.
 *
 *  2. Echo never states a duration. It reports what happened and asks.
 */

export interface ProjectLine {
  name: string
  signals: number
  from: string   // HH:MM
  to: string     // HH:MM
}

export interface FooterItem {
  label: string       // e.g. "Estimating" or "Awaiting your reply"
  title: string
  detail: string
}

const BANNED = [
  'he', 'him', 'his', 'she', 'her', 'hers',
  'missing', 'failed', 'owed', 'outstanding', 'overdue',
  'violation', 'compliance', 'offender', 'guys',
]

/** Throws if a message breaks the copy rules. Used at send time and in CI. */
export function assertNoPronouns(text: string): void {
  const words = text.toLowerCase().match(/[a-z']+/g) ?? []
  const hits = [...new Set(words.filter((w) => BANNED.includes(w)))]
  if (hits.length) {
    throw new Error(`Copy rule violation — banned words present: ${hits.join(', ')}\n${text}`)
  }
}

export function timeQuestion(opts: {
  completedTask: string | null
  signals: number
  projects: ProjectLine[]
  tone: 'direct' | 'soft'
  dayLabel: string
  dashboardUrl: string
}): string {
  const { completedTask, signals, projects, tone, dayLabel, dashboardUrl } = opts
  const lines: string[] = []

  if (tone === 'soft') {
    lines.push(`*You were active across ${projects.length} project${projects.length === 1 ? '' : 's'} on ${dayLabel}*`)
    lines.push('')
    for (const p of projects) lines.push(`• *${p.name}* — ${p.signals} update${p.signals === 1 ? '' : 's'}, ${p.from}–${p.to}`)
    lines.push('')
    lines.push('Anything there worth logging, or was it mostly internal?')
  } else {
    lines.push(`*Busy day on Teamwork — ${dayLabel}* 👋`)
    lines.push('')
    // A completed task by its own assignee is the strongest signal, so it leads.
    if (completedTask) {
      lines.push(`You completed *${completedTask}* and posted ${signals} update${signals === 1 ? '' : 's'}, mostly across:`)
    } else {
      lines.push(`You posted ${signals} update${signals === 1 ? '' : 's'} across:`)
    }
    lines.push('')
    for (const p of projects) lines.push(`• *${p.name}* — ${p.signals} update${p.signals === 1 ? '' : 's'}, ${p.from}–${p.to}`)
    lines.push('')
    lines.push('No time recorded yet. Do you need to log any against these?')
  }

  lines.push('')
  lines.push(`<${dashboardUrl}|Open Echo> · or log it in Teamwork directly`)

  const out = lines.join('\n')
  assertNoPronouns(out)
  return out
}

export function footer(items: FooterItem[], hiddenCount: number, dashboardUrl: string): string {
  if (!items.length) return ''
  const lines = ['', '───────────', '*Needs your attention*', '']
  for (const i of items) lines.push(`• *${i.label}* — ${i.title}\n   ${i.detail}`)
  if (hiddenCount > 0) lines.push('', `_+ ${hiddenCount} more · <${dashboardUrl}|see all>_`)
  const out = lines.join('\n')
  assertNoPronouns(out)
  return out
}

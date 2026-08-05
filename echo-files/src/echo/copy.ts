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
  projectId: number
  signals: number
  from: string   // HH:MM
  to: string     // HH:MM
  /** All of it arrived in one sitting. Worth saying: "13 updates" on a day
   *  someone spent six minutes tidying a task list reads as exaggeration. */
  singleSitting?: boolean
}

export interface FooterItem {
  label: string       // e.g. "Estimating" or "Awaiting your reply"
  title: string
  detail: string
  taskId?: number
}

/**
 * Every link in every message goes to TEAMWORK, never to Echo.
 *
 * Ben's rule, and it's the right one: Echo is where the gaps are reported, but
 * Teamwork is the system of record. Sending people to a dashboard to log time
 * would put a second place to do it in front of them, which is how you end up
 * with time in two systems and trust in neither.
 */
export function projectTimeUrl(base: string, projectId: number): string {
  return `${base.replace(/\/$/, '')}/app/projects/${projectId}/time`
}

export function taskUrl(base: string, taskId: number): string {
  return `${base.replace(/\/$/, '')}/app/tasks/${taskId}`
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
  teamworkBase: string
  /** Whole day arrived in one sitting. Said out loud so a big number never
   *  implies more separate pieces of work than actually happened. */
  singleSitting?: boolean
}): string {
  const { completedTask, signals, projects, tone, dayLabel, teamworkBase } = opts
  const sitting = opts.singleSitting ? ' in one sitting' : ''
  const link = (p: ProjectLine) => `<${projectTimeUrl(teamworkBase, p.projectId)}|*${p.name}*>`
  const count = (p: ProjectLine) =>
    `${p.signals} update${p.signals === 1 ? '' : 's'}` +
    (p.singleSitting ? ' in one sitting' : '') +
    `, ${p.from}–${p.to}`
  const lines: string[] = []

  if (tone === 'soft') {
    lines.push(`*You were active across ${projects.length} project${projects.length === 1 ? '' : 's'} on ${dayLabel}*`)
    lines.push('')
    for (const p of projects) lines.push(`• ${link(p)} — ${count(p)}`)
    lines.push('')
    lines.push('Anything there worth logging, or was it mostly internal?')
  } else {
    lines.push(`*Busy day on Teamwork — ${dayLabel}* 👋`)
    lines.push('')
    // A completed task by its own assignee is the strongest signal, so it leads.
    if (completedTask) {
      lines.push(`You completed *${completedTask}* and posted ${signals} update${signals === 1 ? '' : 's'}${sitting}, mostly across:`)
    } else {
      lines.push(`You posted ${signals} update${signals === 1 ? '' : 's'}${sitting} across:`)
    }
    lines.push('')
    for (const p of projects) lines.push(`• ${link(p)} — ${count(p)}`)
    lines.push('')
    lines.push('No time recorded yet. Do you need to log any against these?')
  }

  lines.push('')
  lines.push('_Tap a project to log time in Teamwork._')

  const out = lines.join('\n')
  assertNoPronouns(out)
  return out
}

export function footer(
  items: FooterItem[],
  hiddenCount: number,
  teamworkBase: string,
  /** Echo link for the attention list only. Time logging always goes to
   *  Teamwork; this is just "see the rest of your list". */
  echoUrl?: string,
): string {
  if (!items.length) return ''
  const lines = ['', '───────────', '*Needs your attention*', '']
  for (const i of items) {
    const title = i.taskId ? `<${taskUrl(teamworkBase, i.taskId)}|${i.title}>` : i.title
    lines.push(`• *${i.label}* — ${title}\n   ${i.detail}`)
  }
  if (hiddenCount > 0) {
    lines.push('', echoUrl
      ? `_+ ${hiddenCount} more · <${echoUrl}|see your list>_`
      : `_+ ${hiddenCount} more_`)
  }
  const out = lines.join('\n')
  assertNoPronouns(out)
  return out
}

/**
 * The silence question.
 *
 * A statement about the RECORD, never about the person. Echo knows Teamwork is
 * empty; it has no idea whether work happened, which is exactly why it asks
 * rather than tells. "Working outside Teamwork" is offered first and treated as
 * a completely acceptable answer.
 */
export function silenceQuestion(opts: {
  days: number
  openTasks: number
  teamworkBase: string
}): string {
  const { days, openTasks, teamworkBase } = opts
  const lines = [
    `*Nothing's come through from you in Teamwork for ${days} days* 👋`,
    '',
    `You've got ${openTasks} task${openTasks === 1 ? '' : 's'} assigned, and there's no ` +
      `activity or time recorded against any of them in that window.`,
    '',
    `Are you working outside Teamwork at the moment, or is something in the way?`,
    '',
    `<${teamworkBase.replace(/\/$/, '')}/app/tasks|See your tasks in Teamwork>`,
  ]
  const out = lines.join('\n')
  assertNoPronouns(out)
  return out
}

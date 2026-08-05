/**
 * Minimal Teamwork client for Echo.
 *
 * If Victor already exposes a client with a rate limiter, delete the fetch
 * implementation below and pass Victor's in — everything downstream only needs
 * the `TeamworkApi` interface.
 */

export interface Activity {
  id: number
  userId: number | null
  projectId: number | null
  itemId: number | null
  type: string
  activityType: string
  dateTime: string
  description: string | null
  extraDescription: string | null
  link: string | null
  meta?: { notifiedUserIds?: number[] } | null
}

export interface Timelog {
  id: number
  userId: number
  projectId: number | null
  taskId: number | null
  minutes: number
  description: string | null
  isBillable: boolean
  isLocked: boolean
  timeLogged: string
  createdAt: string
}

export interface Task {
  id: number
  name: string
  estimateMinutes: number | null
  updatedAt: string
  assignees?: { id: number }[]
  workflowStages?: { stageId: number; workflowId: number }[]
}

export interface Person {
  id: number
  firstName: string
  lastName: string
  email: string | null
  /** Teamwork's own client/guest flag. More trustworthy than any mapping we
   *  maintain: PJ Holdsworth is isClientUser true with a @muffle.co.uk address. */
  isClientUser: boolean
  isServiceAccount: boolean
  companyId: number
  timezone: string | null
}

export interface TeamworkApi {
  activities(opts: { start: string; end: string }): Promise<Activity[]>
  timelogs(opts: { start: string; end: string }): Promise<Timelog[]>
  openTasks(): Promise<Task[]>
  task(id: number): Promise<Task>
  people(): Promise<Person[]>
}

const BASE = process.env.TEAMWORK_BASE_URL ?? 'https://wetakeflight.eu.teamwork.com'

async function tw<T>(path: string, params: Record<string, string | number>): Promise<T> {
  const token = process.env.TEAMWORK_API_TOKEN
  if (!token) throw new Error('TEAMWORK_API_TOKEN is required')
  const qs = new URLSearchParams(
    Object.entries(params).map(([k, v]) => [k, String(v)]),
  )
  const res = await fetch(`${BASE}${path}?${qs}`, {
    headers: {
      Authorization: `Basic ${Buffer.from(`${token}:x`).toString('base64')}`,
      Accept: 'application/json',
    },
  })
  if (res.status === 429) {
    const wait = Number(res.headers.get('retry-after') ?? 5)
    await new Promise((r) => setTimeout(r, wait * 1000))
    return tw<T>(path, params)
  }
  if (!res.ok) throw new Error(`Teamwork ${path} -> ${res.status} ${await res.text()}`)
  return (await res.json()) as T
}

/**
 * Pages until exhausted.
 *
 * NOTE on activities: the server-side date filter is NOT reliable — a query
 * scoped to 4 August returns events stamped 5 August (verified against the live
 * account). Callers must filter on `dateTime` themselves. The date params are
 * still passed to bound the amount of paging, not to trust the result.
 */
async function pageAll<T>(
  path: string,
  key: string,
  params: Record<string, string | number>,
): Promise<T[]> {
  const out: T[] = []
  for (let page = 1; page <= 200; page++) {
    const body = await tw<Record<string, unknown>>(path, { ...params, page, pageSize: 250 })
    const rows = (body[key] ?? []) as T[]
    out.push(...rows)
    const meta = body.meta as { page?: { hasMore?: boolean } } | undefined
    if (!meta?.page?.hasMore) break
  }
  return out
}

export const teamwork: TeamworkApi = {
  activities: ({ start, end }) =>
    pageAll<Activity>('/projects/api/v3/latestactivity.json', 'activities', {
      startDate: start,
      endDate: end,
    }),
  timelogs: ({ start, end }) =>
    pageAll<Timelog>('/projects/api/v3/time.json', 'timelogs', {
      startDate: start,
      endDate: end,
    }),
  openTasks: () =>
    pageAll<Task>('/projects/api/v3/tasks.json', 'tasks', {
      includeCompletedTasks: 'false',
    }),
  task: (id) =>
    tw<{ task: Task }>(`/projects/api/v3/tasks/${id}.json`, {}).then((r) => r.task),
  people: () =>
    pageAll<Person>('/projects/api/v3/people.json', 'people', { type: 'account' }),
}

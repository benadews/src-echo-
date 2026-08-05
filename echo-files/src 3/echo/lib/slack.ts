/** Minimal Slack client. Bot token only — no user tokens, no OAuth dance. */

const API = 'https://slack.com/api'

async function slack<T>(method: string, body: unknown): Promise<T> {
  const token = process.env.SLACK_BOT_TOKEN
  if (!token) throw new Error('SLACK_BOT_TOKEN is required')
  const res = await fetch(`${API}/${method}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json; charset=utf-8',
    },
    body: JSON.stringify(body),
  })
  const json = (await res.json()) as { ok: boolean; error?: string } & T
  if (!json.ok) throw new Error(`Slack ${method} failed: ${json.error}`)
  return json
}

/** Resolve a Slack user by email. Requires the users:read.email scope. */
export async function lookupByEmail(email: string): Promise<string | null> {
  try {
    const r = await slack<{ user: { id: string } }>('users.lookupByEmail', { email })
    return r.user.id
  } catch {
    return null   // not found, or a different address in Slack
  }
}

/** DM a user. Passing a user id as `channel` opens the DM implicitly. */
export async function sendDm(userId: string, text: string): Promise<string> {
  const r = await slack<{ ts: string }>('chat.postMessage', {
    channel: userId,
    text,
    unfurl_links: false,
    unfurl_media: false,
  })
  return r.ts
}

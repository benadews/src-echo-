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
    return null // not found, or a different address in Slack
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

/** List every channel the bot is a member of — public, private, and Slack Connect. */
export async function listBotChannels(): Promise<Array<{ id: string; name: string; is_private: boolean; is_ext_shared: boolean }>> {
  const channels: Array<{ id: string; name: string; is_private: boolean; is_ext_shared: boolean }> = []
  let cursor: string | undefined
  do {
    const r = await slack<{ channels: typeof channels; response_metadata?: { next_cursor?: string } }>(
      'conversations.list',
      { types: 'public_channel,private_channel', exclude_archived: true, limit: 200, cursor },
    )
    channels.push(...r.channels)
    cursor = r.response_metadata?.next_cursor || undefined
  } while (cursor)
  return channels
}

/** New top-level messages in a channel since a given ts (exclusive). */
export async function getHistorySince(
  channelId: string,
  oldestTs: string | null,
): Promise<Array<{ ts: string; user?: string; text: string; thread_ts?: string; reply_count?: number }>> {
  const messages: Array<{ ts: string; user?: string; text: string; thread_ts?: string; reply_count?: number }> = []
  let cursor: string | undefined
  do {
    const r = await slack<{ messages: typeof messages; has_more: boolean; response_metadata?: { next_cursor?: string } }>(
      'conversations.history',
      { channel: channelId, oldest: oldestTs ?? undefined, limit: 200, cursor },
    )
    messages.push(...r.messages)
    cursor = r.has_more ? r.response_metadata?.next_cursor : undefined
  } while (cursor)
  return messages
}

/** All replies in a thread, including the parent message. */
export async function getThreadReplies(
  channelId: string,
  threadTs: string,
): Promise<Array<{ ts: string; user?: string; text: string }>> {
  const r = await slack<{ messages: Array<{ ts: string; user?: string; text: string }> }>(
    'conversations.replies',
    { channel: channelId, ts: threadTs, limit: 200 },
  )
  return r.messages
}

/** A clickable link back to the exact message, for the dashboard and any DM. */
export async function getPermalink(channelId: string, messageTs: string): Promise<string | null> {
  try {
    const r = await slack<{ permalink: string }>('chat.getPermalink', { channel: channelId, message_ts: messageTs })
    return r.permalink
  } catch {
    return null
  }
}

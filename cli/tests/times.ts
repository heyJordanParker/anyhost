export const LIVE_MS = 9000
export const PING_MS = 3000
export const PONG_MS = 8000
export const ANSWER_MS = 14_000
export const TELL_MS = 12_000
export const EXIT_MS = 3000

export const TIMES: Record<string, string> = {
  ANYHOST_LIVE_MS: String(LIVE_MS),
  ANYHOST_PING_MS: String(PING_MS),
  ANYHOST_PONG_MS: String(PONG_MS),
  ANYHOST_ANSWER_MS: String(ANSWER_MS),
  ANYHOST_TELL_MS: String(TELL_MS),
  ANYHOST_EXIT_MS: String(EXIT_MS),
}

Object.assign(process.env, TIMES)

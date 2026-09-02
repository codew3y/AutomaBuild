/**
 * Talking to the AutomaBuild server.
 *
 * Every call goes through here for one reason: the control API can require a
 * key, and a `fetch` written anywhere else would silently not send it. A 401
 * that only happens on the one endpoint someone forgot is the kind of bug that
 * survives a long time.
 *
 * The key lives in `localStorage`, which is the honest choice for what this is:
 * a shared secret for a single-operator tool, typed once on the machine that
 * uses it. It is not a session, there is no user behind it, and pretending
 * otherwise with a login form would suggest guarantees that do not exist.
 */

const KEY_STORAGE = 'automabuild:apiKey'
export const API_KEY_HEADER = 'x-automabuild-key'

export function readApiKey(): string | null {
  try {
    const stored = localStorage.getItem(KEY_STORAGE)
    return stored === null || stored === '' ? null : stored
  } catch {
    // Private mode, or storage disabled. Not having a key is a state the
    // caller already handles; a thrown exception here is not.
    return null
  }
}

export function writeApiKey(key: string | null): void {
  try {
    if (key === null || key === '') localStorage.removeItem(KEY_STORAGE)
    else localStorage.setItem(KEY_STORAGE, key)
  } catch {
    // Nothing to do. The key simply will not persist across a reload.
  }
}

export class UnauthorizedError extends Error {
  override readonly name = 'UnauthorizedError'
  constructor() {
    super('the server rejected this key')
  }
}

/**
 * Fetch, with the key attached and a 401 turned into something catchable.
 *
 * A 401 is thrown rather than returned because every caller has to handle it
 * the same way — ask for a key — and a status code that has to be checked at
 * each call site is a status code that eventually is not.
 */
export async function apiFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const key = readApiKey()
  const headers = new Headers(init.headers)
  if (key !== null) headers.set(API_KEY_HEADER, key)

  const response = await fetch(path, { ...init, headers })
  if (response.status === 401) throw new UnauthorizedError()
  return response
}

/** JSON, or null for any response that does not carry it. */
export async function apiJson<T>(path: string, init?: RequestInit): Promise<T | null> {
  const response = await apiFetch(path, init)
  if (!response.ok) return null
  return (await response.json()) as T
}

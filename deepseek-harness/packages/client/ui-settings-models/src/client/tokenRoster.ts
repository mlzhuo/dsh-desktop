/**
 * Per-provider API-key roster for the Models settings card.
 *
 * A provider's credential store holds one key under its resolved reference, so
 * "switching token" means writing the picked key into that reference through
 * the existing `credentials.set` wire call. The roster itself — the saved
 * keys plus the name (备注) each one carries and the active pick — is a
 * browser-side convenience list, persisted in `localStorage` keyed by provider
 * route. It is deliberately not a Host settings namespace: the values are
 * secrets the settings document must not carry, the active pick is exactly
 * the key the credential store already holds (the harness stays the single
 * fact source for what a request uses), and the roster is a per-machine
 * convenience a single-user desktop keeps locally.
 *
 * All mutations are pure functions over an immutable {@link TokenRoster}, so
 * the storage round-trip and the selection rules are unit-testable without a
 * DOM; the component owns `localStorage` and the wire writes.
 * @module @deepseek-ai/dsh-client-ui-settings-models/tokenRoster
 */

/** One saved token: the name the user gave it (备注) and the key itself. */
export interface TokenEntry {
  /** Stable id within the roster; opaque to the user. */
  id: string
  /** The name the user gave this token. */
  name: string
  /** The API key value. */
  key: string
}

/** One provider's saved tokens and the active pick. */
export interface TokenRoster {
  entries: TokenEntry[]
  /** Id of the entry whose key is currently written to the credential store. */
  activeId: string | undefined
}

/** The `localStorage`-shaped face the roster persists through (fakes in tests). */
export interface TokenRosterStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

/** Storage key prefix; the provider route id is appended. */
const KEY_PREFIX = 'dsh.ui-settings-models.tokenRoster.v1.'

/** The storage key of one provider's roster. */
export function rosterKey(provider: string): string {
  return `${KEY_PREFIX}${provider}`
}

/** An empty roster: no tokens, nothing active. */
export function emptyRoster(): TokenRoster {
  return { entries: [], activeId: undefined }
}

function isEntry(value: unknown): value is TokenEntry {
  if (typeof value !== 'object' || value === null) return false
  const entry = value as Record<string, unknown>
  return typeof entry.id === 'string'
    && typeof entry.name === 'string'
    && typeof entry.key === 'string'
}

function isRoster(value: unknown): value is TokenRoster {
  if (typeof value !== 'object' || value === null) return false
  const roster = value as Record<string, unknown>
  if (!Array.isArray(roster.entries) || !roster.entries.every(isEntry)) return false
  if (roster.activeId !== undefined && typeof roster.activeId !== 'string') return false
  // A dangling active id (the active entry was removed by an older build)
  // reads as no active token rather than as a broken pick.
  return roster.activeId === undefined
    || roster.entries.some(entry => entry.id === roster.activeId)
}

/**
 * Read one provider's roster. A missing or unreadable entry (never written,
 * corrupted JSON, a shape this build does not recognize) reads as empty: the
 * roster is a convenience list, so a bad read must not block the card.
 * @param provider - provider route id (e.g. `deepseek-official`).
 * @param storage - the browser storage face.
 * @returns the stored roster, or an empty one.
 */
export function loadRoster(provider: string, storage: TokenRosterStorage): TokenRoster {
  const raw = storage.getItem(rosterKey(provider))
  if (raw === null) return emptyRoster()
  try {
    const parsed = JSON.parse(raw) as unknown
    return isRoster(parsed) ? parsed : emptyRoster()
  } catch {
    return emptyRoster()
  }
}

/**
 * Persist one provider's roster. An empty roster removes the key so the
 * browser does not keep a stale blob after the last token is deleted.
 * @param provider - provider route id.
 * @param roster - the roster to persist.
 * @param storage - the browser storage face.
 */
export function saveRoster(provider: string, roster: TokenRoster, storage: TokenRosterStorage): void {
  const key = rosterKey(provider)
  if (roster.entries.length === 0) {
    storage.removeItem(key)
    return
  }
  storage.setItem(key, JSON.stringify(roster))
}

/** The active entry of a roster, if its id still names one. */
export function activeEntry(roster: TokenRoster): TokenEntry | undefined {
  return roster.entries.find(entry => entry.id === roster.activeId)
}

let idCounter = 0

/** A process-unique id; the roster is a single-browser store, so time + counter suffices. */
function nextId(): string {
  idCounter += 1
  return `t${Date.now().toString(36)}${idCounter.toString(36)}`
}

/**
 * Add one token and activate it: a token the user just saved is the token in
 * use, so the returned roster names it active.
 * @param roster - the current roster.
 * @param name - the user-given name; leading/trailing whitespace is the caller's concern.
 * @param key - the API key value.
 * @returns the next roster plus the appended entry.
 */
export function addToken(
  roster: TokenRoster,
  name: string,
  key: string,
): { roster: TokenRoster; entry: TokenEntry } {
  const entry: TokenEntry = { id: nextId(), name, key }
  return {
    roster: { entries: [...roster.entries, entry], activeId: entry.id },
    entry,
  }
}

/**
 * Rename one token, keeping its position and its active status.
 * @param roster - the current roster.
 * @param id - the entry to rename.
 * @param name - the new name.
 * @returns the next roster; an unknown id returns the roster unchanged.
 */
export function renameToken(roster: TokenRoster, id: string, name: string): TokenRoster {
  if (!roster.entries.some(entry => entry.id === id)) return roster
  return {
    ...roster,
    entries: roster.entries.map(entry => entry.id === id ? { ...entry, name } : entry),
  }
}

/**
 * Remove one token from the roster. The credential store is untouched: the
 * key a request uses stays exactly where the harness keeps it, so deleting a
 * roster entry never breaks the running configuration.
 * @param roster - the current roster.
 * @param id - the entry to remove.
 * @returns the next roster; removing the active entry clears the active pick.
 */
export function removeToken(roster: TokenRoster, id: string): TokenRoster {
  return {
    entries: roster.entries.filter(entry => entry.id !== id),
    activeId: roster.activeId === id ? undefined : roster.activeId,
  }
}

/**
 * Mark one token active (the key the harness credential store holds).
 * @param roster - the current roster.
 * @param id - the entry to activate; `undefined` clears the pick.
 * @returns the next roster; an unknown id clears the pick like `undefined`.
 */
export function activateToken(roster: TokenRoster, id: string | undefined): TokenRoster {
  const known = id !== undefined && roster.entries.some(entry => entry.id === id)
  return { ...roster, activeId: known ? id : undefined }
}

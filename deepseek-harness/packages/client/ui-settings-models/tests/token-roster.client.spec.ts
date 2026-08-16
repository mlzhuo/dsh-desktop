/** Token-roster store: storage round-trips, selection rules, and the pure mutations. */
import { describe, expect, it } from 'vitest'
import {
  activateToken, activeEntry, addToken, emptyRoster, loadRoster, removeToken, renameToken,
  rosterKey, saveRoster, type TokenRoster, type TokenRosterStorage,
} from '../src/client/tokenRoster.ts'

/** An in-memory `localStorage` face with the same semantics as the browser's. */
function memoryStorage(initial: Record<string, string> = {}): TokenRosterStorage & { data: Map<string, string> } {
  const data = new Map(Object.entries(initial))
  return {
    data,
    getItem: key => data.get(key) ?? null,
    setItem: (key, value) => { data.set(key, value) },
    removeItem: (key) => { data.delete(key) },
  }
}

/** A stored roster whose ids and keys are fixed, so expectations can name them. */
function seeded(): { roster: TokenRoster; storage: ReturnType<typeof memoryStorage> } {
  const storage = memoryStorage()
  const roster = { entries: [
    { id: 'a', name: '工作号', key: 'sk-a' },
    { id: 'b', name: 'Backup', key: 'sk-b' },
  ], activeId: 'a' }
  saveRoster('deepseek-official', roster, storage)
  return { roster, storage }
}

describe('loadRoster / saveRoster', () => {
  it('reads nothing for a provider that never saved a roster', () => {
    expect(loadRoster('deepseek-official', memoryStorage())).toEqual(emptyRoster())
  })

  it('round-trips a stored roster through its provider key', () => {
    const { roster, storage } = seeded()
    expect(loadRoster('deepseek-official', storage)).toEqual(roster)
    // The provider scoping: another provider's roster stays empty.
    expect(loadRoster('minimax-cn', storage)).toEqual(emptyRoster())
  })

  it('keys storage by provider route, namespaced against other uses', () => {
    expect(rosterKey('deepseek-official')).toMatch(/^dsh\.ui-settings-models\.tokenRoster\.v1\.deepseek-official$/)
    expect(rosterKey('deepseek-official')).not.toBe(rosterKey('deepseek-official-2'))
  })

  it('reads a corrupted blob as empty rather than throwing', () => {
    const storage = memoryStorage({ [rosterKey('deepseek-official')]: '{not json' })
    expect(loadRoster('deepseek-official', storage)).toEqual(emptyRoster())
  })

  it('reads a well-formed blob of the wrong shape as empty', () => {
    const storage = memoryStorage({ [rosterKey('deepseek-official')]: JSON.stringify({ entries: 'nope' }) })
    expect(loadRoster('deepseek-official', storage)).toEqual(emptyRoster())
  })

  it('reads a dangling active id as no active token', () => {
    const storage = memoryStorage({
      [rosterKey('deepseek-official')]: JSON.stringify({
        entries: [{ id: 'a', name: 'gone', key: 'sk' }],
        activeId: 'missing',
      }),
    })
    expect(loadRoster('deepseek-official', storage).activeId).toBeUndefined()
  })

  it('removes the storage key when the last token is deleted', () => {
    const { storage } = seeded()
    const roster = loadRoster('deepseek-official', storage)
    // Pure mutations chain onto the previous result, not the original roster.
    const emptied = removeToken(removeToken(roster, 'a'), 'b')
    saveRoster('deepseek-official', emptied, storage)
    expect(storage.data.has(rosterKey('deepseek-official'))).toBe(false)
  })
})

describe('addToken', () => {
  it('appends a token and makes it the active one', () => {
    const { roster: before } = seeded()
    const { roster, entry } = addToken(before, 'New', 'sk-new')
    expect(roster.entries).toHaveLength(3)
    expect(roster.entries[2]).toEqual(entry)
    expect(roster.activeId).toBe(entry.id)
    expect(entry).toMatchObject({ name: 'New', key: 'sk-new' })
  })

  it('gives every added token its own id', () => {
    const first = addToken(emptyRoster(), 'a', 'k1').entry
    const second = addToken(emptyRoster(), 'b', 'k2').entry
    expect(first.id).not.toBe(second.id)
  })
})

describe('renameToken', () => {
  it('renames in place, keeping position and active status', () => {
    const { roster } = seeded()
    const next = renameToken(roster, 'b', '备用')
    expect(next.entries).toEqual([
      { id: 'a', name: '工作号', key: 'sk-a' },
      { id: 'b', name: '备用', key: 'sk-b' },
    ])
    expect(next.activeId).toBe('a')
  })

  it('leaves the roster unchanged for an unknown id', () => {
    const { roster } = seeded()
    expect(renameToken(roster, 'missing', 'x')).toBe(roster)
  })
})

describe('removeToken', () => {
  it('removes one entry and keeps the others', () => {
    const { roster } = seeded()
    const next = removeToken(roster, 'b')
    expect(next.entries.map(entry => entry.id)).toEqual(['a'])
    expect(next.activeId).toBe('a')
  })

  it('clears the active pick when the active token is removed', () => {
    const { roster } = seeded()
    const next = removeToken(roster, 'a')
    expect(next.entries.map(entry => entry.id)).toEqual(['b'])
    expect(next.activeId).toBeUndefined()
  })
})

describe('activateToken / activeEntry', () => {
  it('marks a known entry active', () => {
    const { roster } = seeded()
    expect(activeEntry(activateToken(roster, 'b'))?.id).toBe('b')
  })

  it('treats an unknown id or an explicit clear as no active token', () => {
    const { roster } = seeded()
    expect(activateToken(roster, 'missing').activeId).toBeUndefined()
    expect(activateToken(roster, undefined).activeId).toBeUndefined()
  })

  it('resolves the active entry by id', () => {
    const { roster } = seeded()
    expect(activeEntry(roster)).toMatchObject({ id: 'a', name: '工作号' })
    expect(activeEntry(emptyRoster())).toBeUndefined()
  })
})

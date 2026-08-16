// @vitest-environment jsdom
/** Token switcher: roster rendering, switch/add/rename/delete over the credential wire and localStorage. */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RpcResponse } from '@deepseek-ai/dsh-api-remotes/client'
import { TokenSwitcher } from '../src/client/TokenSwitcher.tsx'
import { en } from '../src/client/locales.ts'
import { rosterKey } from '../src/client/tokenRoster.ts'

afterEach(cleanup)
beforeEach(() => { localStorage.clear() })

type T = (key: keyof typeof en) => string
const t: T = key => en[key]

let nextRpc = 0
function ok<T>(value: T): RpcResponse<T> {
  return { rpcId: `r-${nextRpc++}` as never, result: { ok: true, value } }
}
function fail<T>(message: string): RpcResponse<T> {
  return { rpcId: `r-${nextRpc++}` as never, result: { ok: false, error: { code: 'credential-rejected', message, details: {} } as never } }
}

/** Seed the browser storage the component reads, exactly as saveRoster writes it. */
function seed(provider: string, roster: unknown): void {
  localStorage.setItem(rosterKey(provider), JSON.stringify(roster))
}

function mount(overrides: { set?: ReturnType<typeof vi.fn>; provider?: string } = {}) {
  const set = overrides.set ?? vi.fn(() => Promise.resolve(ok({})))
  const api = { credentials: { set } } as never
  const onActivated = vi.fn()
  render(
    <TokenSwitcher
      provider={overrides.provider ?? 'deepseek-official'}
      keyRef="DEEPSEEK_API_KEY"
      api={api}
      t={t}
      disabled={false}
      onActivated={onActivated}
    />,
  )
  return { set, onActivated }
}

/** The roster select control. */
function select(): HTMLSelectElement {
  const found = screen.getByLabelText(en.tokenSwitch)
  if (!(found instanceof HTMLSelectElement)) throw new Error('token switch is not a select')
  return found
}

/** Click the button whose text is exactly `label`. */
function buttonNamed(label: string): HTMLButtonElement {
  const found = screen.getByText(label)
  if (!(found instanceof HTMLButtonElement)) throw new Error(`"${label}" is not a button`)
  return found
}

describe('TokenSwitcher roster', () => {
  it('renders no tokens with the empty state and an add affordance', () => {
    mount()
    expect(select().value).toBe('')
    expect(screen.getByText(en.tokenNone)).toBeTruthy()
    expect(buttonNamed(en.tokenAdd).disabled).toBe(false)
    // No current-token annotation without an active pick.
    expect(screen.queryByText(new RegExp(en.tokenCurrent.replace('{name}', '.*')))).toBeNull()
  })

  it('lists the saved tokens with the active one selected and annotated', () => {
    seed('deepseek-official', {
      entries: [
        { id: 'a', name: '工作号', key: 'sk-a' },
        { id: 'b', name: 'Backup', key: 'sk-b' },
      ],
      activeId: 'b',
    })
    mount()
    expect(select().value).toBe('b')
    expect([...select().options].map(option => option.textContent)).toEqual(['工作号', 'Backup'])
    expect(screen.getByText(en.tokenCurrent.replace('{name}', 'Backup'))).toBeTruthy()
  })

  it('switching writes the picked key to the credential reference and marks it active', async () => {
    seed('deepseek-official', {
      entries: [
        { id: 'a', name: '工作号', key: 'sk-a' },
        { id: 'b', name: 'Backup', key: 'sk-b' },
      ],
      activeId: 'a',
    })
    const { set, onActivated } = mount()
    fireEvent.change(select(), { target: { value: 'b' } })

    await waitFor(() => { expect(set).toHaveBeenCalledWith({ ref: 'DEEPSEEK_API_KEY', value: 'sk-b' }) })
    expect(select().value).toBe('b')
    expect(onActivated).toHaveBeenCalled()
    const stored = JSON.parse(localStorage.getItem(rosterKey('deepseek-official')) ?? 'null') as { activeId: string }
    expect(stored.activeId).toBe('b')
  })

  it('keeps the previous active pick when the credential write is refused', async () => {
    seed('deepseek-official', {
      entries: [
        { id: 'a', name: '工作号', key: 'sk-a' },
        { id: 'b', name: 'Backup', key: 'sk-b' },
      ],
      activeId: 'a',
    })
    mount({ set: vi.fn(() => Promise.resolve(fail('credential store is read-only'))) })
    fireEvent.change(select(), { target: { value: 'b' } })

    await screen.findByText('credential store is read-only')
    expect(select().value).toBe('a')
    const stored = JSON.parse(localStorage.getItem(rosterKey('deepseek-official')) ?? 'null') as { activeId: string }
    expect(stored.activeId).toBe('a')
  })

  it('shows the unselected placeholder after the active token is gone, and still switches', async () => {
    // Deleting the active token clears the pick (covered below); a roster with
    // no active id renders a disabled placeholder, not a silent first token.
    seed('deepseek-official', {
      entries: [
        { id: 'a', name: '工作号', key: 'sk-a' },
        { id: 'b', name: 'Backup', key: 'sk-b' },
      ],
      activeId: undefined,
    })
    const { set } = mount()
    expect(select().value).toBe('')
    const placeholder = [...select().options].find(option => option.value === '')
    expect(placeholder?.disabled).toBe(true)
    expect(screen.getByText(en.tokenUnselected)).toBeTruthy()

    fireEvent.change(select(), { target: { value: 'a' } })
    await waitFor(() => { expect(set).toHaveBeenCalledWith({ ref: 'DEEPSEEK_API_KEY', value: 'sk-a' }) })
    expect(select().value).toBe('a')
  })
})

describe('TokenSwitcher add flow', () => {
  it('adds a named token: stores the key, activates it, and persists the roster', async () => {
    const { set, onActivated } = mount()
    fireEvent.click(buttonNamed(en.tokenAdd))

    fireEvent.change(screen.getByLabelText(en.tokenName), { target: { value: ' 备用号 ' } })
    fireEvent.change(screen.getByLabelText(en.tokenKey), { target: { value: 'sk-new' } })
    fireEvent.click(buttonNamed(en.tokenSave))

    await waitFor(() => { expect(set).toHaveBeenCalledWith({ ref: 'DEEPSEEK_API_KEY', value: 'sk-new' }) })
    expect(onActivated).toHaveBeenCalled()
    const stored = JSON.parse(localStorage.getItem(rosterKey('deepseek-official')) ?? 'null') as {
      entries: { id: string; name: string; key: string }[]
      activeId: string
    }
    expect(stored.entries[0]).toMatchObject({ name: '备用号', key: 'sk-new' })
    expect(stored.activeId).toBe(stored.entries[0]?.id)
    // The add form closes and the pick shows the new token.
    expect(screen.queryByLabelText(en.tokenName)).toBeNull()
    expect(screen.getByText(en.tokenCurrent.replace('{name}', '备用号'))).toBeTruthy()
  })

  it('trims the typed name and key before storing', async () => {
    const { set } = mount()
    fireEvent.click(buttonNamed(en.tokenAdd))
    fireEvent.change(screen.getByLabelText(en.tokenName), { target: { value: '  A  ' } })
    fireEvent.change(screen.getByLabelText(en.tokenKey), { target: { value: '  sk-x  ' } })
    fireEvent.click(buttonNamed(en.tokenSave))
    await waitFor(() => { expect(set).toHaveBeenCalledWith({ ref: 'DEEPSEEK_API_KEY', value: 'sk-x' }) })
    const stored = JSON.parse(localStorage.getItem(rosterKey('deepseek-official')) ?? 'null') as {
      entries: { name: string }[]
    }
    expect(stored.entries[0]?.name).toBe('A')
  })

  it('refuses an empty name, an empty key, and an illegal key in place', async () => {
    const { set } = mount()
    fireEvent.click(buttonNamed(en.tokenAdd))
    fireEvent.click(buttonNamed(en.tokenSave))
    expect(screen.getByText(en.tokenNameRequired)).toBeTruthy()
    expect(set).not.toHaveBeenCalled()

    fireEvent.change(screen.getByLabelText(en.tokenName), { target: { value: 'A' } })
    fireEvent.click(buttonNamed(en.tokenSave))
    expect(screen.getByText(en.tokenKeyRequired)).toBeTruthy()

    fireEvent.change(screen.getByLabelText(en.tokenKey), { target: { value: 'ENV=value' } })
    fireEvent.click(buttonNamed(en.tokenSave))
    expect(screen.getByText(en.keyIllegalCharacters)).toBeTruthy()
    expect(set).not.toHaveBeenCalled()
  })

  it('reports a refused key write without persisting the roster', async () => {
    mount({ set: vi.fn(() => Promise.resolve(fail('credential store is read-only'))) })
    fireEvent.click(buttonNamed(en.tokenAdd))
    fireEvent.change(screen.getByLabelText(en.tokenName), { target: { value: 'A' } })
    fireEvent.change(screen.getByLabelText(en.tokenKey), { target: { value: 'sk-x' } })
    fireEvent.click(buttonNamed(en.tokenSave))

    await screen.findByText('credential store is read-only')
    expect(localStorage.getItem(rosterKey('deepseek-official'))).toBeNull()
  })
})

describe('TokenSwitcher manage list', () => {
  it('renames a token on blur and keeps its position and active status', () => {
    seed('deepseek-official', {
      entries: [
        { id: 'a', name: '工作号', key: 'sk-a' },
        { id: 'b', name: 'Backup', key: 'sk-b' },
      ],
      activeId: 'a',
    })
    mount()
    const nameInput = screen.getByLabelText(en.tokenRename.replace('{name}', 'Backup'))
    fireEvent.change(nameInput, { target: { value: '备用' } })
    fireEvent.blur(nameInput)

    const stored = JSON.parse(localStorage.getItem(rosterKey('deepseek-official')) ?? 'null') as {
      entries: { id: string; name: string }[]
      activeId: string
    }
    expect(stored.entries[1]).toMatchObject({ id: 'b', name: '备用' })
    expect(stored.activeId).toBe('a')
  })

  it('deletes a token from the roster without touching the credential store', async () => {
    seed('deepseek-official', {
      entries: [
        { id: 'a', name: '工作号', key: 'sk-a' },
        { id: 'b', name: 'Backup', key: 'sk-b' },
      ],
      activeId: 'b',
    })
    const { set } = mount()
    fireEvent.click(screen.getByLabelText(en.tokenRemove.replace('{name}', 'Backup')))

    await waitFor(() => { expect(set).not.toHaveBeenCalled() })
    const stored = JSON.parse(localStorage.getItem(rosterKey('deepseek-official')) ?? 'null') as {
      entries: { id: string }[]
      activeId: string | undefined
    }
    expect(stored.entries.map(entry => entry.id)).toEqual(['a'])
    // Deleting the active entry clears the pick; the harness key stays in place.
    expect(stored.activeId).toBeUndefined()
    expect(screen.queryByText(en.tokenCurrent.replace('{name}', 'Backup'))).toBeNull()
  })

  it('forgets the storage key entirely once every token is deleted', () => {
    seed('deepseek-official', { entries: [{ id: 'a', name: 'only', key: 'sk' }], activeId: 'a' })
    mount()
    fireEvent.click(screen.getByLabelText(en.tokenRemove.replace('{name}', 'only')))
    expect(localStorage.getItem(rosterKey('deepseek-official'))).toBeNull()
  })
})

describe('TokenSwitcher storage portability', () => {
  it('isolates one provider roster from another provider of the same name shape', () => {
    // The storage face is the browser's own; the scoping is the key prefix.
    seed('deepseek-official', { entries: [{ id: 'a', name: '主号', key: 'sk-a' }], activeId: 'a' })
    mount({ provider: 'minimax-cn' })
    expect(select().value).toBe('')
    expect(screen.getByText(en.tokenNone)).toBeTruthy()
  })})

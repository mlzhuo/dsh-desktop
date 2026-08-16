/**
 * Token switcher for one provider's editor card: a roster of named API keys
 * (tokens) kept in browser storage, with the active pick written into the
 * provider's credential reference through the existing `credentials.set`
 * wire call. Switching or saving a token stores the key immediately — the
 * harness resolves the credential per request, so the very next request uses
 * the picked token without an Apply round-trip or a restart.
 *
 * The roster itself (keys + names + the active pick) is a browser-local
 * convenience list (see `tokenRoster.ts`); the harness remains the single
 * fact source for what a request actually uses.
 */

import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import type { IApiClient } from '@deepseek-ai/dsh-api-remotes/client'
import { apiKeyFailure } from './apiKey.ts'
import { messageOf } from './store.ts'
import type { en } from './locales.ts'
import {
  activateToken, addToken, activeEntry, loadRoster, removeToken, renameToken, saveRoster,
  type TokenEntry, type TokenRoster, type TokenRosterStorage,
} from './tokenRoster.ts'
import styles from './ModelsSection.module.css'

/** Browser storage; falls back to a process-local map outside a browser. */
const STORAGE: TokenRosterStorage = typeof localStorage === 'undefined'
  ? (() => {
    const memory = new Map<string, string>()
    return {
      getItem: key => memory.get(key) ?? null,
      setItem: (key, value) => { memory.set(key, value) },
      removeItem: (key) => { memory.delete(key) },
    }
  })()
  : localStorage

/** Props of {@link TokenSwitcher}. */
export interface TokenSwitcherProps {
  /** Provider route id; the roster is stored per provider. */
  provider: string
  /** The credential reference the active token is written to. */
  keyRef: string
  /** Credential wire face (only `set` is used). */
  api: Pick<IApiClient, 'credentials'>
  /** Section copy. */
  t: (key: keyof typeof en) => string
  /** Disable the controls (read-only deployment or an in-flight write). */
  disabled: boolean
  /** Fired after a token was stored to the credential store (switch or save). */
  onActivated: () => void
}

/** `t('key')` with the one `{name}` placeholder replaced. */
function named(t: (key: keyof typeof en) => string, key: keyof typeof en, name: string): string {
  return t(key).replace('{name}', name)
}

/**
 * Render one provider's token roster and switching controls.
 * @param props - provider identity, the credential reference, and copy.
 * @returns the switcher block.
 */
export function TokenSwitcher(props: TokenSwitcherProps): ReactNode {
  const { provider, keyRef, api, t, disabled } = props
  const [roster, setRoster] = useState<TokenRoster>(() => loadRoster(provider, STORAGE))
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string | undefined>(undefined)
  const [adding, setAdding] = useState(false)
  const [addName, setAddName] = useState('')
  const [addKey, setAddKey] = useState('')
  const [addFailure, setAddFailure] = useState<string | undefined>(undefined)
  // Half-typed renames live here until their input blurs or submits.
  const [renames, setRenames] = useState<Record<string, string>>({})

  // A card reuses this component across providers (one editor at a time), so
  // the roster follows the provider prop rather than being read once on mount.
  useEffect(() => {
    setRoster(loadRoster(provider, STORAGE))
    setAdding(false)
    setAddName('')
    setAddKey('')
    setAddFailure(undefined)
    setFailure(undefined)
    setRenames({})
  }, [provider])

  const active = activeEntry(roster)

  /**
   * Write one token's key into the credential store and mark it active. The
   * write lands before the roster updates: a refused write leaves the roster
   * and the active pick exactly as they were.
   * @param entry - the token to activate.
   * @returns the failure text, or undefined once stored and persisted.
   */
  /**
   * Write one token's key into the credential store. The write lands before
   * any roster change, so a refused write leaves roster and pick untouched;
   * the caller persists the roster it already built once the store accepted.
   * @param entry - the token whose key is written.
   * @returns the failure text, or undefined once stored.
   */
  const storeKey = async (entry: TokenEntry): Promise<string | undefined> => {
    const stored = await api.credentials.set({ ref: keyRef, value: entry.key })
    if (!stored.result.ok) return stored.result.error.message
    props.onActivated()
    return undefined
  }

  /** Activate the picked entry; the placeholder option is not a real choice. */
  const switchTo = async (id: string): Promise<void> => {
    const entry = roster.entries.find(candidate => candidate.id === id)
    if (entry === undefined) return
    setBusy(true)
    setFailure(undefined)
    try {
      const failure = await storeKey(entry)
      if (failure !== undefined) {
        setFailure(failure)
        return
      }
      const next = activateToken(roster, entry.id)
      saveRoster(provider, next, STORAGE)
      setRoster(next)
    } catch (error) {
      // A transport rejection (disconnect, a refused request) must not leave
      // the control stuck or silent.
      setFailure(messageOf(error))
    } finally {
      setBusy(false)
    }
  }

  /** Save a newly named token: validate, store the key, activate, persist. */
  const save = async (): Promise<void> => {
    const name = addName.trim()
    if (name.length === 0) {
      setAddFailure(t('tokenNameRequired'))
      return
    }
    const key = addKey.trim()
    if (key.length === 0) {
      setAddFailure(t('tokenKeyRequired'))
      return
    }
    const keyFailure = apiKeyFailure(key)
    if (keyFailure !== undefined) {
      setAddFailure(t(keyFailure))
      return
    }
    setBusy(true)
    setAddFailure(undefined)
    try {
      const { roster: next, entry } = addToken(roster, name, key)
      const failure = await storeKey(entry)
      if (failure !== undefined) {
        // The roster was not persisted, so a refused write loses nothing.
        setAddFailure(failure)
        return
      }
      saveRoster(provider, next, STORAGE)
      setRoster(next)
      setAdding(false)
      setAddName('')
      setAddKey('')
    } catch (error) {
      setAddFailure(messageOf(error))
    } finally {
      setBusy(false)
    }
  }

  /** Commit a half-typed rename on blur or Enter; an empty draft keeps the old name. */
  const commitRename = (entry: TokenEntry): void => {
    const draft = (renames[entry.id] ?? '').trim()
    setRenames(current => Object.fromEntries(
      Object.entries(current).filter(([id]) => id !== entry.id),
    ))
    if (draft.length === 0 || draft === entry.name) return
    const next = renameToken(roster, entry.id, draft)
    saveRoster(provider, next, STORAGE)
    setRoster(next)
  }

  /** Forget one token from the roster; the credential store is untouched. */
  const remove = (entry: TokenEntry): void => {
    const next = removeToken(roster, entry.id)
    saveRoster(provider, next, STORAGE)
    setRoster(next)
  }

  const controlsDisabled = disabled || busy

  return (
    <div className={styles['tokenBlock']}>
      <div className={styles['tokenHead']}>
        <span className={styles['fieldLabel']}>{t('tokenSwitch')}</span>
        {active === undefined
          ? null
          : <span className={styles['tokenActiveName']}>{named(t, 'tokenCurrent', active.name)}</span>}
      </div>
      <div className={styles['tokenRow']}>
        <select
          className={`${styles['input']} ${styles['selectInput']} ${styles['tokenSelect']}`}
          aria-label={t('tokenSwitch')}
          value={active?.id ?? ''}
          disabled={controlsDisabled || roster.entries.length === 0}
          onChange={(event) => { void switchTo(event.target.value) }}
        >
          {roster.entries.length === 0
            ? <option value="">{t('tokenNone')}</option>
            : active === undefined
              // The pick can be empty after the active token is deleted;
              // that state reads as a disabled placeholder, not as a choice.
              ? <option value="" disabled>{t('tokenUnselected')}</option>
              : null}
          {roster.entries.map(entry => (
            <option key={entry.id} value={entry.id}>{entry.name}</option>
          ))}
        </select>
        <button
          type="button"
          className={styles['secondaryButton']}
          disabled={controlsDisabled}
          onClick={() => { setAdding(current => !current) }}
        >
          {adding ? t('cancel') : t('tokenAdd')}
        </button>
      </div>
      {adding
        ? (
          <div className={styles['tokenAddForm']}>
            <div className={styles['field']}>
              <span className={styles['fieldLabel']}>{t('tokenName')}</span>
              <input
                className={styles['input']}
                type="text"
                autoComplete="off"
                value={addName}
                placeholder={t('tokenNamePlaceholder')}
                aria-label={t('tokenName')}
                disabled={controlsDisabled}
                onChange={(event) => { setAddName(event.target.value) }}
              />
            </div>
            <div className={styles['field']}>
              <span className={styles['fieldLabel']}>{t('tokenKey')}</span>
              <input
                className={styles['input']}
                type="password"
                autoComplete="off"
                value={addKey}
                aria-label={t('tokenKey')}
                disabled={controlsDisabled}
                onChange={(event) => { setAddKey(event.target.value) }}
              />
            </div>
            {addFailure === undefined ? null : <p className={styles['error']}>{addFailure}</p>}
            <div className={styles['tokenAddActions']}>
              <button
                type="button"
                className={styles['primaryButton']}
                disabled={controlsDisabled}
                onClick={() => { void save() }}
              >
                {t('tokenSave')}
              </button>
            </div>
          </div>
        )
        : null}
      {failure === undefined ? null : <p className={styles['error']}>{failure}</p>}
      {roster.entries.length === 0
        ? null
        : (
          <details className={styles['tokenManage']}>
            <summary className={styles['customizedSummary']}>{t('tokenManage')}</summary>
            <div className={styles['tokenList']}>
              {roster.entries.map(entry => (
                <div key={entry.id} className={styles['tokenEntry']}>
                  <input
                    className={styles['input']}
                    type="text"
                    autoComplete="off"
                    value={renames[entry.id] ?? entry.name}
                    aria-label={named(t, 'tokenRename', entry.name)}
                    disabled={controlsDisabled}
                    onChange={(event) => {
                      setRenames(current => ({ ...current, [entry.id]: event.target.value }))
                    }}
                    onBlur={() => { commitRename(entry) }}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') commitRename(entry)
                    }}
                  />
                  <button
                    type="button"
                    className={`${styles['iconButton']} ${styles['iconButtonDanger']}`}
                    aria-label={named(t, 'tokenRemove', entry.name)}
                    disabled={controlsDisabled}
                    onClick={() => { remove(entry) }}
                  >
                    <span className={styles['hiddenLabel']}>{named(t, 'tokenRemove', entry.name)}</span>
                    {'\u00d7'}
                  </button>
                </div>
              ))}
            </div>
          </details>
        )}
    </div>
  )
}

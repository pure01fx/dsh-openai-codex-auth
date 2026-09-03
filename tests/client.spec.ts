import { readFile } from 'node:fs/promises'
import { createContext, runInContext } from 'node:vm'
import { describe, expect, it } from 'vitest'

const source = await readFile(new URL('../client.js', import.meta.url), 'utf8')

function between(start: string, end: string): string {
  const from = source.indexOf(start)
  const to = source.indexOf(end, from + start.length)
  if (from < 0 || to < 0) throw new Error(`missing client section: ${start}`)
  return source.slice(from, to)
}

describe('Codex settings login gestures', () => {
  it('shows device code without opening a window automatically', () => {
    const startDevice = between('const startDevice = async () => {', 'const probeBrowser =')
    expect(startDevice).toContain("post('/device/start')")
    expect(startDevice).not.toContain('window.open')
    expect(source).toContain('先复制下方代码')
  })

  it('prepares and probes browser login before a separate open button', () => {
    const startBrowser = between('const startBrowser = async () => {', 'const openBrowser =')
    const openBrowser = between('const openBrowser = () => {', 'const completeBrowser =')
    expect(startBrowser).toContain("post('/browser/prepare')")
    expect(startBrowser).toContain('probeBrowser(browser)')
    expect(startBrowser).not.toContain('window.open')
    expect(openBrowser).toContain('window.open(browser.authorizationUrl')
    expect(source).toContain('Callback 通道正常')
    expect(source).toContain('强制继续打开 OpenAI')
    expect(source).toContain("post('/browser/complete', { input: manualInput })")
  })

  it('renders the Host-reported current Codex route without guessing external ownership', () => {
    const route = between('function routePresentation(route) {', 'async function copyText')
    expect(route).toContain("route.owner === 'native'")
    expect(route).toContain("route.owner === 'external'")
    expect(route).toContain('DSH rc.6 不公开其具体 owner 身份')
    expect(source).toContain("const route = routePresentation(status && status.route)")
    expect(source).toContain("h('strong', null, '当前模型路由')")
    expect(source).toContain("route.title + ' · ' + route.value")
  })

  it('labels directly returned quota and renders bounded Codex credits', () => {
    expect(source).toContain("usage.source === 'response' ? 'Codex 返回' : '额度接口'")
    expect(source).toContain("'Codex Credits：无限'")
    expect(source).toContain("'Codex Credits：不可用'")
    expect(source).toContain("creditNotice ? h('p', { className: 'codexNotice' }, creditNotice) : null")
  })

  it('hides placeholder weekly quota windows with zero usage and no reset time', () => {
    const visibility = between('function displayQuotaWindow(window) {', 'function formatCountdown')
    expect(visibility).toContain('Number(window.usedPercent) === 0')
    expect(visibility).toContain('!Number.isFinite(window.resetAt)')
    expect(source).toContain('usage && displayQuotaWindow(usage.secondary) ? usage.secondary : null')
    expect(source).toContain("if (displayQuotaWindow(usage.secondary)) rows.push({ name: '周额度'")
  })

  it('persists browser-local hidden models and exposes checkbox controls', () => {
    expect(source).toContain("const HIDDEN_MODELS_KEY = 'dsh.openai-codex.hidden-models.v1'")
    expect(source).toContain("const AVAILABLE_MODELS_KEY = 'dsh.openai-codex.available-models.v1'")
    expect(source).toContain("window.dispatchEvent(new CustomEvent(MODEL_VISIBILITY_EVENT")
    expect(source).toContain("const inject = ['slots', 'modelDirectories']")
    expect(source).toContain('scope.effect(() => installModelVisibilityBridge(scope)')
    expect(source).toContain('const rawGroups = Array.isArray(value && value.groups)')
    expect(source).toContain('if (generation !== record.generation)')
    expect(source).toContain("window.localStorage.setItem(AVAILABLE_MODELS_KEY, next)")
    expect(source).toContain("h('strong', null, '模型列表显示')")
    expect(source).toContain("className: 'codexModelVisibilityOption'")
    expect(source).toContain('checked: modelVisibility.hidden.includes(model.id)')
    expect(source).toContain("}, '全部显示')")
    expect(source).toContain('只影响当前浏览器中的模型选择列表')
  })

  it('adds a click-to-refresh quota ring without idle usage polling', () => {
    const quotaRing = between('function CodexQuotaRing(props) {', 'function CodexSection() {')
    expect(source).toContain("ctx.slots.inject('conversation.input.right'")
    expect(source).toContain("id: 'openai-codex-quota'")
    expect(quotaRing).toContain('if (previous && !running) void load(false)')
    expect(quotaRing).toContain('onMouseEnter: () => { setOpen(true) }')
    expect(quotaRing).toContain('onMouseLeave: () => { setOpen(false) }')
    expect(quotaRing).toContain('onFocus: () => { setOpen(true) }')
    expect(quotaRing).toContain('onBlur: (event) => {')
    expect(quotaRing).toContain('void load(true)')
    expect(quotaRing).not.toContain('setOpen((value) => !value)')
    expect(quotaRing).toContain('点击圆圈刷新最新额度。')
    expect(source).not.toContain('30000')
    expect(source).toContain("if (!watchLogin) return undefined")
    expect(source).toContain("window.setInterval(() => { void load(false) }, 2000)")
    expect(source).toContain('const statusSubscribers = new Set()')
    expect(source.match(/const status = useSharedStatus\(\)/g)).toHaveLength(2)
    expect(quotaRing).toContain("className: 'codexQuotaAvailable' + quotaTone(used)")
    expect(quotaRing).toContain('const remainingLength = circumference - usedLength')
    expect(quotaRing).toContain("strokeDasharray: remainingLength + ' ' + usedLength")
    expect(quotaRing).toContain('strokeDashoffset: -usedLength')
    expect(quotaRing).not.toContain('codexQuotaConsumed')
  })
})

describe('Codex multi-account source contract', () => {
  it('reads the account collection and identifies the current account', () => {
    expect(source).toContain('Array.isArray(status.accounts) ? status.accounts : []')
    expect(source).toContain('const currentAccountId = status && status.currentAccountId')
    expect(source).toContain('account.current === true || account.accountId === currentAccountId')
    expect(source).toContain("h('strong', null, '已添加账号')")
    expect(source).toContain("' · 当前账号'")
  })

  it('prefers optional email while retaining accountId as secondary identity', () => {
    expect(source).toContain('currentAccount && currentAccount.email ? currentAccount.email : shortAccount(status && status.accountId)')
    expect(source).toContain("h('span', { title: account.accountId }")
    expect(source).toContain("h('strong', null, account.email || shortAccount(account.accountId))")
    expect(source).toContain("account.email ? h('span', null, ' · ' + shortAccount(account.accountId)) : null")
  })

  it('switches and removes a selected account through the CSRF post helper', () => {
    const mutations = between('const mutateAccount = async (path, accountId, action) => {', 'const logout = async () => {')
    expect(mutations).toContain('if (busy) return')
    expect(mutations).toContain('await post(path, { accountId })')
    expect(mutations).toContain('await load(false)')
    expect(mutations).toContain("mutateAccount('/accounts/current', accountId, 'current')")
    expect(mutations).toContain("mutateAccount('/accounts/logout', accountId, 'remove')")
    expect(mutations).toContain("window.confirm('确定移除 '")
    expect(mutations).toContain("移除后将退出 Codex")
    expect(source).toContain("'设为当前'")
    expect(source).toContain("'移除'")
  })

  it('keeps both login methods available as add-account actions', () => {
    expect(source).toContain("connected ? '用设备码添加账号' : '使用设备码登录'")
    expect(source).toContain("connected ? '用浏览器添加账号' : '本机浏览器 OAuth'")
    expect(source).toContain("await post('/logout')")
  })
})

describe('Codex model visibility bridge', () => {
  it('caches loaded Codex models and filters hidden rows from the shared directory', async () => {
    const storage = new Map<string, string>([
      ['dsh.openai-codex.hidden-models.v1', JSON.stringify(['gpt-hidden'])],
    ])
    const listeners = new Map<string, Set<(event: unknown) => void>>()
    let plugin: { apply: (ctx: unknown) => void } | undefined
    class TestEvent {
      constructor(public readonly type: string, public readonly init?: unknown) {}
    }
    const browser = {
      __ModuleLoader__: {
        load(definition: { factory: (require: (name: string) => unknown) => typeof plugin }) {
          plugin = definition.factory(() => ({
            createElement: () => undefined,
            useCallback: () => undefined,
            useEffect: () => undefined,
            useMemo: () => undefined,
            useRef: () => undefined,
            useState: () => undefined,
          }))
        },
      },
      localStorage: {
        getItem: (key: string) => storage.get(key) ?? null,
        setItem: (key: string, value: string) => { storage.set(key, value) },
      },
      addEventListener(type: string, listener: (event: unknown) => void) {
        const group = listeners.get(type) ?? new Set()
        group.add(listener)
        listeners.set(type, group)
      },
      removeEventListener(type: string, listener: (event: unknown) => void) {
        listeners.get(type)?.delete(listener)
      },
      dispatchEvent(event: TestEvent) {
        for (const listener of listeners.get(event.type) ?? []) listener(event)
      },
    }
    runInContext(source, createContext({ window: browser, CustomEvent: TestEvent, console }))

    const state = { groups: [] as unknown[] }
    const raw = {
      current: null,
      routable: true,
      failures: [],
      groups: [
        {
          id: 'openai-codex',
          name: 'Codex',
          models: [
            { id: 'gpt-visible', name: 'Visible' },
            { id: 'gpt-hidden', name: 'Hidden' },
          ],
        },
        { id: 'other', name: 'Other', models: [{ id: 'other-model', name: 'Other model' }] },
      ],
    }
    let loadImplementation: () => Promise<typeof raw> = async () => raw
    const directory = {
      store: {
        getSnapshot: () => state,
        update: (update: (value: typeof state) => void) => { update(state) },
      },
      load: () => loadImplementation(),
      dispose: () => {},
    }
    const resolver = {
      live: { directories: new Map([['session', directory]]) },
      directoryFor: () => directory,
    }
    const scope = {
      modelDirectories: resolver,
      effect: (setup: () => void) => setup(),
    }
    const ctx = {
      modelDirectories: resolver,
      inject: (_services: string[], setup: (scope: typeof scope) => void) => setup(scope),
      slots: { inject: () => {} },
    }
    expect(plugin).toBeDefined()
    plugin!.apply(ctx)

    const loaded = await resolver.directoryFor().load()
    expect(JSON.parse(JSON.stringify(loaded.groups))).toEqual([
      { id: 'openai-codex', name: 'Codex', models: [{ id: 'gpt-visible', name: 'Visible' }] },
      { id: 'other', name: 'Other', models: [{ id: 'other-model', name: 'Other model' }] },
    ])
    expect(JSON.parse(JSON.stringify(state.groups))).toEqual(loaded.groups)
    expect(JSON.parse(storage.get('dsh.openai-codex.available-models.v1')!)).toEqual([
      { id: 'gpt-visible', name: 'Visible' },
      { id: 'gpt-hidden', name: 'Hidden' },
    ])

    storage.set('dsh.openai-codex.hidden-models.v1', '[]')
    browser.dispatchEvent(new TestEvent('dsh:openai-codex-model-visibility'))
    expect(JSON.parse(JSON.stringify(state.groups))).toEqual(raw.groups)

    const oldRaw = {
      ...raw,
      groups: [{ id: 'openai-codex', name: 'Codex', models: [{ id: 'gpt-old', name: 'Old' }] }],
    }
    const newRaw = {
      ...raw,
      groups: [{ id: 'openai-codex', name: 'Codex', models: [{ id: 'gpt-new', name: 'New' }] }],
    }
    let resolveOld!: (value: typeof raw) => void
    let resolveNew!: (value: typeof raw) => void
    const oldResponse = new Promise<typeof raw>((resolve) => { resolveOld = resolve })
    const newResponse = new Promise<typeof raw>((resolve) => { resolveNew = resolve })
    let call = 0
    loadImplementation = () => call++ === 0 ? oldResponse : newResponse
    const oldLoad = resolver.directoryFor().load()
    const newLoad = resolver.directoryFor().load()
    resolveNew(newRaw)
    await newLoad
    resolveOld(oldRaw)
    await oldLoad

    expect(JSON.parse(JSON.stringify(state.groups))).toEqual(newRaw.groups)
    expect(JSON.parse(storage.get('dsh.openai-codex.available-models.v1')!)).toEqual([
      { id: 'gpt-new', name: 'New' },
    ])
  })
})

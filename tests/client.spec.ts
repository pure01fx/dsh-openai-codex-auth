import { readFile } from 'node:fs/promises'
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

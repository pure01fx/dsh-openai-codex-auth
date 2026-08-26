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

  it('adds a click-to-refresh quota ring without idle usage polling', () => {
    const quotaRing = between('function CodexQuotaRing(props) {', 'function CodexSection() {')
    expect(source).toContain("ctx.slots.inject('conversation.input.right'")
    expect(source).toContain("id: 'openai-codex-quota'")
    expect(quotaRing).toContain('if (previous && !running) void load(false)')
    expect(quotaRing).toContain('void load(true)')
    expect(source).not.toContain('30000')
    expect(source).toContain("if (!watchLogin) return undefined")
    expect(source).toContain("window.setInterval(() => { void load(false) }, 2000)")
    expect(source).toContain('const statusSubscribers = new Set()')
    expect(source.match(/const status = useSharedStatus\(\)/g)).toHaveLength(2)
    expect(quotaRing).toContain("className: 'codexQuotaAvailable' + quotaTone(used)")
    expect(quotaRing).toContain("className: 'codexQuotaConsumed'")
    expect(quotaRing).toContain('strokeDasharray: (circumference * used / 100)')
  })
})

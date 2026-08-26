window.__ModuleLoader__.load({
  id: '@pure01fx/dsh-openai-codex-auth',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')
    const { createElement: h, useCallback, useEffect, useMemo, useRef, useState } = React
    const BASE = '/openai-codex'
    const PLUGIN_ID = '@pure01fx/dsh-openai-codex-auth'
    const statusSubscribers = new Set()
    let sharedStatus = null
    let statusRequestGeneration = 0

    const css = `
      .codexSection{box-sizing:border-box;max-width:720px;color:var(--dsw-alias-label-primary);display:flex;flex-direction:column;gap:12px}
      .codexSection *{box-sizing:border-box}.codexTitle{color:var(--dsw-alias-label-primary);margin:0;font-size:16px;font-weight:500;line-height:24px}
      .codexIntro{color:var(--dsw-alias-label-tertiary);margin:0;font-size:14px;line-height:22px}
      .codexCard{overflow:hidden;border:1px solid var(--dsw-alias-border-l2);border-radius:12px;background:var(--dsw-alias-bg-layer-3)}
      .codexHero{display:flex;align-items:flex-start;justify-content:space-between;gap:20px;padding:16px 18px;background:var(--dsw-alias-bg-layer-2);border-bottom:1px solid var(--dsw-alias-border-l2)}
      .codexBrand{display:flex;align-items:center;gap:12px;min-width:0}
      .codexLogo{display:grid;place-items:center;width:40px;height:40px;flex:0 0 auto;border-radius:10px;background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-foreground);font:700 13px/1 ui-monospace,SFMono-Regular,Consolas,monospace}
      .codexName{color:var(--dsw-alias-label-primary);margin:0;font-size:15px;font-weight:500;line-height:22px}.codexMeta{margin:2px 0 0;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px;overflow-wrap:anywhere}
      .codexBadge{display:inline-flex;align-items:center;gap:6px;white-space:nowrap;border:1px solid var(--dsw-alias-border-l3);border-radius:999px;padding:3px 9px;font-size:12px;font-weight:500;line-height:18px;background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-secondary)}
      .codexBadge.connected{color:var(--dsw-alias-state-success-primary)}.codexBadge.pending{color:var(--dsw-alias-state-warn-label)}
      .codexDot{width:7px;height:7px;border-radius:50%;background:currentColor}
      .codexBody{padding:18px}.codexActions{display:flex;flex-wrap:wrap;gap:8px;margin-top:16px}
      .codexButton{appearance:none;box-sizing:border-box;min-height:34px;border:1px solid var(--dsw-alias-border-l2);border-radius:17px;background:transparent;color:var(--dsw-alias-label-primary);padding:5px 13px;font:500 13px/20px inherit;cursor:pointer;transition:background .15s,border-color .15s,color .15s}
      .codexButton:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);border-color:var(--dsw-alias-border-l3)}.codexButton:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}.codexButton:disabled{color:var(--dsw-alias-label-dimmed);cursor:not-allowed}
      .codexButton.primary{border-color:transparent;background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-foreground)}.codexButton.primary:hover:not(:disabled){border-color:transparent;background:var(--dsw-alias-button-primary-hover)}.codexButton.danger{color:var(--dsw-alias-state-error-primary)}
      .codexGrid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px;margin-top:14px}
      .codexUsage{border:1px solid var(--dsw-alias-border-l2);border-radius:10px;padding:12px 14px;background:var(--dsw-alias-bg-layer-2)}
      .codexUsageHead{display:flex;align-items:baseline;justify-content:space-between;gap:12px}.codexUsageName{font-size:13px;font-weight:500}.codexUsageValue{font-size:12px;color:var(--dsw-alias-label-tertiary)}
      .codexBar{height:6px;margin:10px 0 8px;overflow:hidden;border-radius:999px;background:var(--dsw-alias-bg-layer-1)}.codexBarFill{height:100%;border-radius:inherit;background:var(--dsw-alias-state-success-primary);transition:width .25s ease}.codexBarFill.high{background:var(--dsw-alias-state-warn-label)}
      .codexReset{font-size:12px;color:var(--dsw-alias-label-tertiary)}
      .codexPlan{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:2px}.codexPlan strong{font-size:14px;font-weight:500}.codexPlan span{font-size:12px;color:var(--dsw-alias-label-tertiary)}
      .codexNotice,.codexWarning,.codexError{margin:14px 0 0;border-radius:8px;padding:8px 10px;background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}
      .codexWarning{color:var(--dsw-alias-state-warn-label)}.codexError{color:var(--dsw-alias-state-error-primary);overflow-wrap:anywhere}
      .codexDevice{margin-top:14px;border:1px solid var(--dsw-alias-brand-primary);border-radius:10px;padding:14px;background:var(--dsw-alias-interactive-bg-hover)}
      .codexDeviceTitle{margin:0;font-size:14px;font-weight:500;line-height:22px}.codexDeviceHelp{margin:4px 0 0;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}
      .codexCode{display:block;margin:12px 0 5px;padding:10px;border:1px dashed var(--dsw-alias-border-l3);border-radius:8px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font:700 24px/1.25 ui-monospace,SFMono-Regular,Consolas,monospace;letter-spacing:.08em;text-align:center;user-select:all}
      .codexDeviceMeta{text-align:center;color:var(--dsw-alias-label-tertiary);font-size:12px}.codexDeviceActions{display:flex;flex-wrap:wrap;justify-content:center;gap:8px;margin-top:12px}
      .codexBrowser{margin-top:14px;border:1px solid var(--dsw-alias-border-l3);border-radius:10px;padding:14px;background:var(--dsw-alias-bg-layer-2)}
      .codexBrowserHead{display:flex;align-items:flex-start;justify-content:space-between;gap:12px}.codexProbe{display:flex;align-items:flex-start;gap:9px;margin-top:12px;padding:10px;border-radius:8px;background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}.codexProbe.ok{color:var(--dsw-alias-state-success-primary)}.codexProbe.failed{color:var(--dsw-alias-state-warn-label)}
      .codexProbeIcon{display:grid;place-items:center;width:20px;height:20px;flex:0 0 auto;border:1px solid currentColor;border-radius:50%;font-weight:700}.codexProbeText strong{display:block;font-size:13px;font-weight:500}.codexProbeEndpoint{display:block;margin-top:3px;color:var(--dsw-alias-label-tertiary);font:12px/18px ui-monospace,SFMono-Regular,Consolas,monospace;overflow-wrap:anywhere}
      .codexField{display:block;margin-top:14px}.codexFieldLabel{display:block;margin-bottom:6px;color:var(--dsw-alias-label-secondary);font-size:12px}.codexInput{display:block;width:100%;min-height:36px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:7px 10px;background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-primary);font:13px/20px ui-monospace,SFMono-Regular,Consolas,monospace}.codexInput:focus{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}.codexInput::placeholder{color:var(--dsw-alias-label-dimmed)}
      .codexEmpty{padding:4px 0;color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:20px}.codexSkeleton{height:8px;margin:10px 0;border-radius:99px;background:linear-gradient(90deg,var(--dsw-alias-bg-layer-2),var(--dsw-alias-interactive-bg-hover-solid),var(--dsw-alias-bg-layer-2));background-size:200% 100%;animation:codexPulse 1.2s infinite}
      .codexQuotaRoot{display:inline-flex;position:relative}.codexQuotaTrigger{width:28px;height:28px;color:var(--dsw-alias-label-secondary);cursor:pointer;background:transparent;border:none;border-radius:999px;flex:none;place-items:center;display:grid}.codexQuotaTrigger:hover{background:var(--dsw-alias-interactive-bg-hover)}.codexQuotaTrigger:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
      .codexQuotaTrack{fill:none;stroke:var(--dsw-alias-border-l3);stroke-width:2px}.codexQuotaAvailable{fill:none;stroke:var(--dsw-alias-state-success-primary);stroke-width:2px;stroke-linecap:round;transition:stroke .25s ease,stroke-dasharray .25s ease,stroke-dashoffset .25s ease}.codexQuotaAvailable.high{stroke:var(--dsw-alias-state-warn-label)}.codexQuotaAvailable.critical{stroke:var(--dsw-alias-state-error-primary)}.codexQuotaLoading{animation:codexQuotaPulse .8s ease-in-out infinite alternate}
      .codexQuotaPanel{z-index:100;box-sizing:border-box;width:272px;border:1px solid var(--dsw-alias-border-inverted);border-radius:12px;padding:12px;background:var(--dsw-specific-menu);box-shadow:var(--dsw-shadow-lv3);color:var(--dsw-alias-label-secondary);cursor:default;font-size:12px;line-height:20px;position:absolute;right:0;bottom:calc(100% + 8px)}.codexQuotaPanelHead{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:8px}.codexQuotaPanelHead strong{color:var(--dsw-alias-label-primary);font-size:13px;font-weight:500}.codexQuotaPanelHead span{color:var(--dsw-alias-label-tertiary)}
      .codexQuotaWindow{padding:7px 0}.codexQuotaWindow+.codexQuotaWindow{border-top:1px solid var(--dsw-alias-border-l2)}.codexQuotaWindowHead{display:flex;align-items:center;justify-content:space-between;gap:10px}.codexQuotaWindowHead strong{font-weight:500;color:var(--dsw-alias-label-secondary)}.codexQuotaWindowHead span{font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-primary)}.codexQuotaBar{height:4px;margin:6px 0;border-radius:999px;overflow:hidden;background:var(--dsw-alias-interactive-bg-hover)}.codexQuotaBarFill{height:100%;border-radius:inherit;background:var(--dsw-alias-state-success-primary)}.codexQuotaBarFill.high{background:var(--dsw-alias-state-warn-label)}.codexQuotaBarFill.critical{background:var(--dsw-alias-state-error-primary)}.codexQuotaReset{color:var(--dsw-alias-label-tertiary)}.codexQuotaMessage{margin:4px 0;color:var(--dsw-alias-label-tertiary)}.codexQuotaMessage.error{color:var(--dsw-alias-state-error-primary)}
      @keyframes codexPulse{to{background-position:-200% 0}}@keyframes codexQuotaPulse{to{opacity:.35}}@media(prefers-reduced-motion:reduce){.codexSkeleton,.codexQuotaLoading{animation:none}}@media(max-width:620px){.codexHero{padding:14px;flex-direction:column}.codexBody{padding:14px}.codexGrid{grid-template-columns:1fr}.codexCode{font-size:20px}}
    `
    if (typeof document !== 'undefined' && document.querySelector('style[data-plugin="' + PLUGIN_ID + '"]') === null) {
      const style = document.createElement('style')
      style.dataset.plugin = PLUGIN_ID
      style.textContent = css
      document.head.appendChild(style)
    }

    function messageOf(error) {
      return error instanceof Error ? error.message : String(error)
    }

    function publishStatus(value) {
      sharedStatus = value
      for (const subscriber of statusSubscribers) subscriber(value)
    }

    function useSharedStatus() {
      const [status, setStatus] = useState(sharedStatus)
      useEffect(() => {
        statusSubscribers.add(setStatus)
        return () => { statusSubscribers.delete(setStatus) }
      }, [])
      return status
    }

    async function requestStatus(refresh) {
      const generation = ++statusRequestGeneration
      const response = await fetch(BASE + '/status' + (refresh ? '?refresh=1' : ''), { cache: 'no-store' })
      const value = await response.json()
      if (!response.ok) throw new Error(value.error || 'HTTP ' + response.status)
      if (generation === statusRequestGeneration) publishStatus(value)
      return value
    }

    function shortAccount(value) {
      if (!value) return ''
      return value.length > 22 ? value.slice(0, 10) + '…' + value.slice(-8) : value
    }

    function formatReset(seconds) {
      if (!Number.isFinite(seconds)) return '重置时间未知'
      const date = new Date(seconds * 1000)
      const remaining = date.getTime() - Date.now()
      if (remaining <= 0) return '即将重置'
      const hours = Math.floor(remaining / 3600000)
      const minutes = Math.max(1, Math.floor((remaining % 3600000) / 60000))
      const relative = hours >= 24 ? Math.floor(hours / 24) + ' 天后' : hours > 0 ? hours + ' 小时 ' + minutes + ' 分后' : minutes + ' 分后'
      return relative + ' · ' + date.toLocaleString([], { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })
    }

    function formatCountdown(expiresAt, now) {
      const seconds = Math.max(0, Math.ceil((Number(expiresAt) - now) / 1000))
      return Math.floor(seconds / 60) + ':' + String(seconds % 60).padStart(2, '0')
    }

    function browserLoginAvailable(callbackUrl) {
      if (!callbackUrl || typeof window === 'undefined') return false
      try {
        const callback = new URL(callbackUrl)
        return callback.href === 'http://localhost:1455/auth/callback'
          && window.location.protocol === 'http:'
          && (window.location.hostname === '127.0.0.1' || window.location.hostname === 'localhost')
      } catch {
        return false
      }
    }

    async function copyText(text) {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(text)
        return
      }
      const input = document.createElement('textarea')
      input.value = text
      input.style.position = 'fixed'
      input.style.opacity = '0'
      document.body.appendChild(input)
      input.select()
      document.execCommand('copy')
      input.remove()
    }

    function UsageCard(props) {
      const used = Math.max(0, Math.min(100, Number(props.window.usedPercent) || 0))
      return h('div', { className: 'codexUsage' },
        h('div', { className: 'codexUsageHead' },
          h('span', { className: 'codexUsageName' }, props.name),
          h('span', { className: 'codexUsageValue' }, '已用 ' + Math.round(used) + '% · 剩余 ' + Math.max(0, Math.round(100 - used)) + '%'),
        ),
        h('div', { className: 'codexBar', role: 'progressbar', 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-valuenow': used },
          h('div', { className: 'codexBarFill' + (used >= 80 ? ' high' : ''), style: { width: used + '%' } }),
        ),
        h('div', { className: 'codexReset' }, formatReset(props.window.resetAt)),
      )
    }

    function quotaTone(used) {
      return used >= 95 ? ' critical' : used >= 80 ? ' high' : ''
    }

    function quotaWindowName(window, secondary) {
      if (secondary) return '周额度'
      return window && window.windowSeconds === 18000 ? '5 小时额度' : '短周期额度'
    }

    function QuotaWindow(props) {
      const used = Math.max(0, Math.min(100, Number(props.window.usedPercent) || 0))
      const remaining = Math.max(0, Math.round(100 - used))
      const tone = quotaTone(used)
      return h('div', { className: 'codexQuotaWindow' },
        h('div', { className: 'codexQuotaWindowHead' },
          h('strong', null, props.name),
          h('span', null, '剩余 ' + remaining + '%'),
        ),
        h('div', { className: 'codexQuotaBar', role: 'progressbar', 'aria-label': props.name, 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-valuenow': used },
          h('div', { className: 'codexQuotaBarFill' + tone, style: { width: used + '%' } }),
        ),
        h('div', { className: 'codexQuotaReset' }, formatReset(props.window.resetAt)),
      )
    }

    function CodexQuotaRing(props) {
      const running = props.useSession((snapshot) => snapshot.running)
      const status = useSharedStatus()
      const [open, setOpen] = useState(false)
      const [loading, setLoading] = useState(false)
      const [error, setError] = useState('')
      const rootRef = useRef(null)
      const wasRunning = useRef(running)
      const loadGeneration = useRef(0)

      const load = useCallback(async (refresh) => {
        const generation = ++loadGeneration.current
        if (refresh) setLoading(true)
        try {
          await requestStatus(refresh)
          if (generation !== loadGeneration.current) return
          setError('')
        } catch (loadError) {
          if (generation !== loadGeneration.current) return
          setError(messageOf(loadError))
        } finally {
          if (generation === loadGeneration.current) setLoading(false)
        }
      }, [])

      useEffect(() => { void load(false) }, [load])
      useEffect(() => {
        const previous = wasRunning.current
        wasRunning.current = running
        if (previous && !running) void load(false)
      }, [load, running])
      useEffect(() => {
        if (!open) return undefined
        const onPointerDown = (event) => {
          if (event.target instanceof Node && rootRef.current && rootRef.current.contains(event.target)) return
          setOpen(false)
        }
        const onKeyDown = (event) => { if (event.key === 'Escape') setOpen(false) }
        document.addEventListener('pointerdown', onPointerDown)
        document.addEventListener('keydown', onKeyDown)
        return () => {
          document.removeEventListener('pointerdown', onPointerDown)
          document.removeEventListener('keydown', onKeyDown)
        }
      }, [open])

      if (!status || !status.loggedIn) return null
      const usage = status.usage
      const primary = usage && usage.primary
      const secondary = usage && usage.secondary
      const meter = primary || secondary
      const used = meter ? Math.max(0, Math.min(100, Number(meter.usedPercent) || 0)) : 0
      const remaining = Math.max(0, 100 - used)
      const reading = meter ? Math.round(remaining) + '%' : '待更新'
      const title = loading ? '正在刷新 Codex 额度' : 'Codex 额度剩余 ' + reading
      const circumference = 2 * Math.PI * 5.5
      const usedLength = circumference * used / 100
      const remainingLength = circumference - usedLength
      const windows = []
      if (primary) windows.push({ name: quotaWindowName(primary, false), window: primary })
      if (secondary) windows.push({ name: quotaWindowName(secondary, true), window: secondary })

      return h('span', { ref: rootRef, className: 'codexQuotaRoot' },
        h('button', {
          type: 'button',
          className: 'codexQuotaTrigger' + (loading ? ' codexQuotaLoading' : ''),
          title,
          'aria-label': title,
          'aria-haspopup': 'dialog',
          'aria-expanded': open,
          onClick: () => {
            setOpen((value) => !value)
            void load(true)
          },
        },
        h('svg', { viewBox: '0 0 14 14', width: '14', height: '14', 'aria-hidden': true },
          h('circle', { className: 'codexQuotaTrack', cx: '7', cy: '7', r: '5.5' }),
          meter && remaining > 0 ? h('circle', {
            className: 'codexQuotaAvailable' + quotaTone(used),
            cx: '7', cy: '7', r: '5.5',
            strokeDasharray: remainingLength + ' ' + usedLength,
            strokeDashoffset: -usedLength,
            transform: 'rotate(-90 7 7)',
          }) : null,
        )),
        open ? h('div', { className: 'codexQuotaPanel', role: 'dialog', 'aria-label': 'OpenAI Codex 额度' },
          h('div', { className: 'codexQuotaPanelHead' },
            h('strong', null, 'Codex 额度'),
            h('span', null, loading ? '刷新中…' : usage && usage.fetchedAt ? new Date(usage.fetchedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '尚未读取'),
          ),
          windows.length > 0
            ? windows.map((row) => h(QuotaWindow, { key: row.name, name: row.name, window: row.window }))
            : h('p', { className: 'codexQuotaMessage' }, '点击圆圈读取最新额度。'),
          status.usageError ? h('p', { className: 'codexQuotaMessage error', role: 'status' }, '额度读取失败：' + status.usageError) : null,
          error ? h('p', { className: 'codexQuotaMessage error', role: 'status' }, '无法连接额度接口：' + error) : null,
        ) : null,
      )
    }

    function CodexSection() {
      const status = useSharedStatus()
      const [error, setError] = useState('')
      const [busy, setBusy] = useState('')
      const [watchLogin, setWatchLogin] = useState(false)
      const [copied, setCopied] = useState(false)
      const [probe, setProbe] = useState({ state: 'idle', message: '' })
      const [manualInput, setManualInput] = useState('')
      const [now, setNow] = useState(Date.now())
      const probeGeneration = useRef(0)

      const load = useCallback(async (refresh) => {
        try {
          const value = await requestStatus(refresh)
          setError('')
          setWatchLogin(Boolean(value.loginPending))
        } catch (loadError) {
          setError('无法连接 DSH Web 的 Codex 同源路由。请重启 Web profile 后再试。' + (messageOf(loadError) ? ' (' + messageOf(loadError) + ')' : ''))
        }
      }, [])

      useEffect(() => {
        void load(false)
        if (!watchLogin) return undefined
        const timer = window.setInterval(() => { void load(false) }, 2000)
        return () => { window.clearInterval(timer) }
      }, [load, watchLogin])

      useEffect(() => {
        const expiresAt = status && ((status.device && status.device.expiresAt) || (status.browser && status.browser.expiresAt))
        if (!expiresAt) return undefined
        setNow(Date.now())
        const timer = window.setInterval(() => { setNow(Date.now()) }, 1000)
        return () => { window.clearInterval(timer) }
      }, [status && ((status.device && status.device.expiresAt) || (status.browser && status.browser.expiresAt))])

      const post = useCallback(async (path, body) => {
        if (!status || !status.csrf) throw new Error('登录状态尚未加载')
        const headers = { 'x-dsh-csrf': status.csrf }
        if (body !== undefined) headers['content-type'] = 'application/json'
        const response = await fetch(BASE + path, {
          method: 'POST',
          headers,
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        })
        const value = await response.json()
        if (!response.ok) {
          const problem = new Error(value.error || 'HTTP ' + response.status)
          problem.code = value.code
          throw problem
        }
        return value
      }, [status])

      const startDevice = async () => {
        setBusy('device')
        setCopied(false)
        setError('')
        try {
          await post('/device/start')
          setWatchLogin(true)
          await load(false)
        } catch (startError) {
          const fallback = startError && startError.code === 'device_code_unavailable' ? ' 可改用下方本机浏览器 OAuth。' : ''
          setError(messageOf(startError) + fallback)
        } finally {
          setBusy('')
        }
      }

      const probeBrowser = useCallback(async (browser) => {
        if (!browser || !browser.probeUrl) return
        const generation = ++probeGeneration.current
        setProbe({ state: 'checking', message: '正在从当前浏览器检测 127.0.0.1:1455…' })
        const controller = new AbortController()
        const timer = window.setTimeout(() => { controller.abort() }, 4000)
        try {
          const response = await fetch(browser.probeUrl, { cache: 'no-store', mode: 'cors', signal: controller.signal })
          const value = await response.json().catch(() => ({}))
          if (!response.ok || value.ok !== true) throw new Error(value.error || 'HTTP ' + response.status)
          if (generation === probeGeneration.current) setProbe({ state: 'ok', message: '当前浏览器可以访问 callback 端口，可以继续登录。' })
        } catch (probeError) {
          const reason = probeError && probeError.name === 'AbortError' ? '检测超时' : messageOf(probeError)
          if (generation === probeGeneration.current) setProbe({ state: 'failed', message: '无法从当前浏览器访问 127.0.0.1:1455。远程 DSH 请转发 1455，然后重新检测。' + (reason ? ' (' + reason + ')' : '') })
        } finally {
          window.clearTimeout(timer)
        }
      }, [])

      useEffect(() => {
        if (status && status.browser && probe.state === 'idle') void probeBrowser(status.browser)
      }, [status && status.browser && status.browser.probeUrl, probe.state, probeBrowser])

      const startBrowser = async () => {
        if (!(status && browserLoginAvailable(status.browserCallbackUrl))) return
        setBusy('browser')
        probeGeneration.current += 1
        setError('')
        setManualInput('')
        setProbe({ state: 'checking', message: '正在启动 callback listener…' })
        try {
          const browser = await post('/browser/prepare')
          setWatchLogin(true)
          await load(false)
          await probeBrowser(browser)
        } catch (startError) {
          setProbe({ state: 'failed', message: messageOf(startError) })
          setError(messageOf(startError))
        } finally {
          setBusy('')
        }
      }

      const openBrowser = () => {
        const browser = status && status.browser
        if (!browser || !browser.authorizationUrl) return
        const popup = window.open(browser.authorizationUrl, 'dsh-openai-codex-login', 'popup,width=560,height=760')
        if (popup === null) setError('浏览器阻止了登录窗口，请允许此站点打开弹窗后重试。')
      }

      const completeBrowser = async () => {
        if (!manualInput.trim()) return
        setBusy('complete')
        probeGeneration.current += 1
        setError('')
        try {
          await post('/browser/complete', { input: manualInput })
          setManualInput('')
          setWatchLogin(false)
          await load(false)
        } catch (completeError) {
          setError('手动完成登录失败：' + messageOf(completeError))
        } finally {
          setBusy('')
        }
      }

      const cancel = async () => {
        setBusy('cancel')
        probeGeneration.current += 1
        try {
          await post('/cancel')
          setWatchLogin(false)
          setProbe({ state: 'idle', message: '' })
          setManualInput('')
          await load(false)
        } catch (cancelError) {
          setError(messageOf(cancelError))
        } finally {
          setBusy('')
        }
      }

      const logout = async () => {
        setBusy('logout')
        probeGeneration.current += 1
        try {
          await post('/logout')
          setWatchLogin(false)
          setProbe({ state: 'idle', message: '' })
          setManualInput('')
          await load(false)
        } catch (logoutError) {
          setError(messageOf(logoutError))
        } finally {
          setBusy('')
        }
      }

      const refresh = async () => {
        setBusy('refresh')
        await load(true)
        setBusy('')
      }

      const copyCode = async () => {
        if (!(status && status.device)) return
        try {
          await copyText(status.device.userCode)
          setCopied(true)
          window.setTimeout(() => { setCopied(false) }, 1600)
        } catch (copyError) {
          setError('复制失败：' + messageOf(copyError))
        }
      }

      const usage = status && status.usage
      const loading = status === null && !error
      const connected = Boolean(status && status.loggedIn)
      const pending = Boolean(status && status.loginPending) || watchLogin
      const devicePending = Boolean(status && status.loginMethod === 'device' && status.device)
      const browserPending = Boolean(status && status.loginMethod === 'browser' && status.browser)
      const browserAvailable = Boolean(status && browserLoginAvailable(status.browserCallbackUrl))
      const plan = usage && usage.planType ? String(usage.planType).toUpperCase() : 'ChatGPT 订阅'
      const windows = useMemo(() => {
        if (!usage) return []
        const rows = []
        if (usage.primary) rows.push({ name: usage.primary.windowSeconds === 18000 ? '5 小时额度' : '短周期额度', window: usage.primary })
        if (usage.secondary) rows.push({ name: '周额度', window: usage.secondary })
        return rows
      }, [usage])

      return h('section', { className: 'codexSection' },
        h('h2', { className: 'codexTitle' }, 'OpenAI Codex'),
        h('p', { className: 'codexIntro' }, '优先使用设备码连接 ChatGPT 订阅；无需本机回调，适合 SSH 和反向代理。登录结果自动用于“模型提供方”中的 openai-codex。'),
        h('div', { className: 'codexCard' },
          h('div', { className: 'codexHero' },
            h('div', { className: 'codexBrand' },
              h('div', { className: 'codexLogo', 'aria-hidden': true }, 'OA'),
              h('div', null,
                h('h3', { className: 'codexName' }, 'OpenAI Codex 订阅'),
                h('p', { className: 'codexMeta', title: connected ? status.accountId : '' }, loading ? '正在读取 OpenAI 登录状态' : connected ? shortAccount(status.accountId) : '尚未连接 ChatGPT 账号'),
              ),
            ),
            h('span', { className: 'codexBadge ' + (loading || pending ? 'pending' : connected ? 'connected' : '') },
              h('span', { className: 'codexDot', 'aria-hidden': true }), loading ? '刷新中…' : pending ? '等待授权' : connected ? '已连接' : '未登录',
            ),
          ),
          h('div', { className: 'codexBody' },
            loading
              ? h('div', { 'aria-label': '加载中' }, h('div', { className: 'codexSkeleton' }), h('div', { className: 'codexSkeleton', style: { width: '72%' } }))
              : connected
                ? h(React.Fragment, null,
                    h('div', { className: 'codexPlan' }, h('strong', null, plan), h('span', null, usage && usage.fetchedAt ? '更新于 ' + new Date(usage.fetchedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '额度信息待更新')),
                    windows.length > 0
                      ? h('div', { className: 'codexGrid' }, windows.map((row) => h(UsageCard, { key: row.name, name: row.name, window: row.window })))
                      : h('p', { className: 'codexEmpty' }, '账号已连接，暂时没有返回可展示的额度窗口。'),
                    usage && Number.isFinite(usage.resetCredits) ? h('p', { className: 'codexNotice' }, '可用额度重置次数：' + usage.resetCredits) : null,
                    status.usageError ? h('p', { className: 'codexError', role: 'status' }, '额度读取失败：' + status.usageError) : null,
                  )
                : h('p', { className: 'codexEmpty' }, '设备码登录可在任意设备完成授权，令牌只由 Host 保存和刷新，Web 页面不会读取令牌。'),
            devicePending
              ? h('div', { className: 'codexDevice' },
                  h('h4', { className: 'codexDeviceTitle' }, '在 OpenAI 输入设备码'),
                  h('p', { className: 'codexDeviceHelp' }, '先复制下方代码，再按需点击“打开 OpenAI 验证页”并输入代码。此页面会自动等待结果。'),
                  h('code', { className: 'codexCode' }, status.device.userCode),
                  h('div', { className: 'codexDeviceMeta' }, '代码剩余 ' + formatCountdown(status.device.expiresAt, now)),
                  h('div', { className: 'codexDeviceActions' },
                    h('button', { type: 'button', className: 'codexButton', onClick: () => { void copyCode() } }, copied ? '已复制' : '复制代码'),
                    h('a', { className: 'codexButton primary', href: status.device.verificationUri, target: '_blank', rel: 'noreferrer' }, '打开 OpenAI 验证页'),
                    h('button', { type: 'button', className: 'codexButton danger', disabled: Boolean(busy), onClick: () => { void cancel() } }, busy === 'cancel' ? '取消中…' : '取消登录'),
                  ),
                )
              : null,
            browserPending
              ? h('div', { className: 'codexBrowser' },
                  h('div', { className: 'codexBrowserHead' },
                    h('div', null,
                      h('h4', { className: 'codexDeviceTitle' }, '浏览器 OAuth callback 检测'),
                      h('p', { className: 'codexDeviceHelp' }, '先确认当前浏览器能访问本机 callback，再由你点击按钮打开 OpenAI。'),
                    ),
                    h('span', { className: 'codexBadge pending' }, '剩余 ' + formatCountdown(status.browser.expiresAt, now)),
                  ),
                  h('div', { className: 'codexProbe ' + (probe.state === 'ok' ? 'ok' : probe.state === 'failed' ? 'failed' : '') },
                    h('span', { className: 'codexProbeIcon', 'aria-hidden': true }, probe.state === 'ok' ? '✓' : probe.state === 'failed' ? '!' : '…'),
                    h('div', { className: 'codexProbeText' },
                      h('strong', null, probe.state === 'ok' ? 'Callback 通道正常' : probe.state === 'failed' ? 'Callback 通道不可达' : '正在检测 callback 通道'),
                      h('span', null, probe.message || '正在检测当前浏览器到 127.0.0.1:1455 的连接。'),
                      h('code', { className: 'codexProbeEndpoint' }, 'http://127.0.0.1:1455 → localhost:1455/auth/callback'),
                    ),
                  ),
                  probe.state === 'failed'
                    ? h('p', { className: 'codexWarning' }, '请先开放或转发端口。例如远程 SSH 可增加：-L 1455:127.0.0.1:1455。打通后点击“重新检测”，也可以选择强制继续。')
                    : null,
                  h('div', { className: 'codexActions' },
                    h('button', { type: 'button', className: 'codexButton', disabled: Boolean(busy) || probe.state === 'checking', onClick: () => { void probeBrowser(status.browser) } }, probe.state === 'checking' ? '检测中…' : '重新检测'),
                    h('button', { type: 'button', className: 'codexButton primary', disabled: Boolean(busy), onClick: openBrowser }, probe.state === 'failed' ? '强制继续打开 OpenAI' : '打开 OpenAI 登录页'),
                    h('button', { type: 'button', className: 'codexButton danger', disabled: Boolean(busy), onClick: () => { void cancel() } }, busy === 'cancel' ? '取消中…' : '取消登录'),
                  ),
                  h('label', { className: 'codexField' },
                    h('span', { className: 'codexFieldLabel' }, '手动完成（可粘贴完整 callback URL 或 authorization code）'),
                    h('input', {
                      className: 'codexInput', type: 'text', value: manualInput,
                      placeholder: 'http://localhost:1455/auth/callback?code=…&state=…',
                      autoComplete: 'off', spellCheck: false,
                      onChange: (event) => { setManualInput(event.target.value) },
                    }),
                  ),
                  h('div', { className: 'codexActions' },
                    h('button', { type: 'button', className: 'codexButton', disabled: Boolean(busy) || !manualInput.trim(), onClick: () => { void completeBrowser() } }, busy === 'complete' ? '提交中…' : '提交 code'),
                  ),
                )
              : null,
            status && status.loginError ? h('p', { className: 'codexError', role: 'alert' }, '登录失败：' + status.loginError) : null,
            status && status.credentialError ? h('p', { className: 'codexError', role: 'alert' }, '凭据文件无法读取：' + status.credentialError + '。可点击退出登录删除并重新创建。') : null,
            error ? h('p', { className: 'codexError', role: 'alert' }, error) : null,
            !loading && !browserAvailable
              ? h('p', { className: 'codexWarning' }, '本机浏览器 OAuth 仅支持通过 HTTP 127.0.0.1 或 localhost 打开 DSH。当前入口请使用设备码登录。')
              : null,
            h('div', { className: 'codexActions' },
              h('button', { type: 'button', className: 'codexButton primary', disabled: Boolean(busy) || pending || loading, onClick: () => { void startDevice() } },
                busy === 'device' ? '正在申请设备码…' : connected ? '用设备码重新登录' : '使用设备码登录'),
              h('button', {
                type: 'button', className: 'codexButton', disabled: Boolean(busy) || pending || loading || !browserAvailable,
                title: browserAvailable ? '展开 callback 检测，不会自动弹出窗口' : '仅支持 HTTP 127.0.0.1/localhost 入口', onClick: () => { void startBrowser() },
              }, busy === 'browser' ? '正在准备浏览器登录…' : connected ? '用浏览器重新登录' : '本机浏览器 OAuth'),
              pending && !devicePending && !browserPending ? h('button', { type: 'button', className: 'codexButton danger', disabled: Boolean(busy), onClick: () => { void cancel() } }, busy === 'cancel' ? '取消中…' : '取消登录') : null,
              connected ? h('button', { type: 'button', className: 'codexButton', disabled: Boolean(busy), onClick: refresh }, busy === 'refresh' ? '刷新中…' : '刷新用量') : null,
              connected || (status && status.credentialError) ? h('button', { type: 'button', className: 'codexButton danger', disabled: Boolean(busy), onClick: () => { void logout() } }, busy === 'logout' ? '退出中…' : '退出登录') : null,
            ),
          ),
        ),
        h('p', { className: 'codexNotice' }, '设备码与浏览器登录都只在你点击对应按钮后打开外部页面。浏览器 OAuth 会临时监听 localhost:1455；远程 DSH 还需额外转发 1455。'),
      )
    }

    const inject = ['slots']
    function apply(ctx) {
      ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section',
        id: 'openai-codex',
        order: 11,
        label: () => 'OpenAI Codex',
      }, CodexSection))
      ctx.slots.inject('conversation.input.right', () => ctx.slots.register({
        name: 'conversation.input.right',
        id: 'openai-codex-quota',
        order: 100,
        label: () => 'OpenAI Codex 额度',
      }, CodexQuotaRing))
    }

    exports.inject = inject
    exports.apply = apply
    return module.exports
  },
})

import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

async function text(path: string): Promise<string> {
  return readFile(new URL(path, import.meta.url), 'utf8')
}

describe('native Codex Hu profile template', () => {
  it('loads the native auth bundle after the unchanged Hu composition', async () => {
    const root = JSON.parse(await text('../package.json')) as {
      version: string
      files: string[]
    }
    const profile = JSON.parse(await text('../profiles/native-codex-hu/package.json')) as {
      dependencies: Record<string, string>
      dsh: { profile: { bundles: string[] } }
    }
    expect(profile.dsh.profile.bundles).toEqual([
      '@deepseek-ai/dsh-base',
      '@deepseek-ai/dsh-web-app',
      '@pure01fx/dsh-collection-hu',
      'dsh-better-sidebar',
      '@pure01fx/dsh-openai-codex-auth',
    ])
    expect(profile.dependencies['@pure01fx/dsh-openai-codex-auth']).toBe(root.version)
    expect(profile.dependencies).toMatchObject({
      '@pure01fx/dsh-collection-hu': '0.1.1',
      'dsh-better-sidebar': '0.16.1',
    })
    expect(profile.dependencies).toMatchObject({
      '@deepseek-ai/cordis': '4.0.1',
      '@deepseek-ai/dsh-credentials': '0.1.0-rc.6',
      '@deepseek-ai/dsh-host-webserver': '0.1.0-rc.6',
      '@deepseek-ai/dsh-llm': '0.1.0-rc.6',
    })
    expect(root.files).toContain('profiles/native-codex-hu')
  })

  it('transfers ownership before native registration and disables the duplicate instance', async () => {
    expect(await text('../cordis.patch.yml')).toBe(
      '# The native adapter claims production plus compatibility routes atomically. A profile\n'
      + '# that still gives openai-codex to pi-ai must release that route before activation.\n'
      + '- insert:\n'
      + '    - id: openai-codex-auth\n'
      + "      name: '@pure01fx/dsh-openai-codex-auth'\n"
      + '      config:\n'
      + '        nativeAdapter: true\n'
      + '        nativeCompatibilityRoute: true\n',
    )
    expect(await text('../profiles/native-codex-hu/cordis.patch.yml')).toBe(
      '# Hu collection 0.1.1 gives pi-ai exactly one route: openai-codex. Replace that\n'
      + '# complete known map before the later native adapter registration; no sibling route is lost.\n'
      + '- id: llm-pi-ai\n'
      + '  config:\n'
      + '    providers: {}\n'
      + '\n'
      + '# The collection mounts this package once for OAuth/UI. Disable that earlier instance\n'
      + '# because the package bundle adds the single native-owner instance.\n'
      + '- id: hu-collection-openai-codex-auth\n'
      + '  disabled: true\n',
    )
    expect(await text('../profiles/native-codex-hu/pnpm-workspace.yaml')).toContain(
      'nodeLinker: hoisted\nautoInstallPeers: false',
    )
  })
})

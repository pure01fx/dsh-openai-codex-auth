import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

async function text(path: string): Promise<string> {
  return readFile(new URL(path, import.meta.url), 'utf8')
}

describe('package integration boundary', () => {
  it('mounts the native-first plugin without shipping profile-specific composition', async () => {
    const root = JSON.parse(await text('../package.json')) as {
      files: string[]
      publishConfig?: { access?: string }
    }
    expect(root.publishConfig).toEqual({ access: 'public' })
    expect(root.files.some(path => path.startsWith('profiles/'))).toBe(false)
    await expect(text('../profiles/native-codex-hu/package.json'))
      .rejects.toMatchObject({ code: 'ENOENT' })
    expect(await text('../CHANGELOG.md')).toContain(
      '# Changelog\n\n## Unreleased\n\n## 0.6.0\n',
    )
    expect(await text('../cordis.patch.yml')).toBe(
      '# Native Codex is the package default. Integration bundles own any removal or\n'
      + '# replacement of an existing openai-codex route before mounting this plugin.\n'
      + '- insert:\n'
      + '    - id: openai-codex-auth\n'
      + "      name: '@pure01fx/dsh-openai-codex-auth'\n",
    )
  })
})

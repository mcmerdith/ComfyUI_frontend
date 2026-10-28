import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const SCRIPT = path.join(import.meta.dirname, 'reconcile-npm-latest-tag.sh')
const PACKAGE = '@comfyorg/comfyui-frontend-types'

type Registry = {
  versionsJson: string
  latest: string
  viewStatus?: number
}

function runReconcile(
  registry: Registry,
  options: { packageName?: string | null; version?: string } = {}
) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reconcile-npm-latest-'))
  const binDir = path.join(dir, 'bin')
  fs.mkdirSync(binDir)
  const tagLog = path.join(dir, 'dist-tags.log')

  const npmStub = [
    '#!/usr/bin/env bash',
    'if [[ "$1" == "view" && "$3" == "versions" ]]; then',
    '  printf %s "$STUB_VERSIONS_JSON"',
    '  exit "${STUB_VIEW_STATUS:-0}"',
    'fi',
    'if [[ "$1" == "view" && "$3" == "dist-tags.latest" ]]; then',
    '  printf "%s\\n" "$STUB_LATEST"',
    '  exit 0',
    'fi',
    'if [[ "$1" == "dist-tag" && "$2" == "add" ]]; then',
    '  printf "%s\\n" "$*" >> "$STUB_TAG_LOG"',
    '  exit 0',
    'fi',
    'echo "unexpected npm invocation: $*" >&2',
    'exit 99',
    ''
  ].join('\n')
  fs.writeFileSync(path.join(binDir, 'npm'), npmStub, { mode: 0o755 })

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ''}`,
    STUB_VERSIONS_JSON: registry.versionsJson,
    STUB_LATEST: registry.latest,
    STUB_VIEW_STATUS: String(registry.viewStatus ?? 0),
    STUB_TAG_LOG: tagLog,
    GITHUB_STEP_SUMMARY: '',
    VERSION: options.version ?? ''
  }
  if (options.packageName === null) {
    delete env.PACKAGE
  } else {
    env.PACKAGE = options.packageName ?? PACKAGE
  }

  const result = spawnSync('bash', [SCRIPT], {
    cwd: dir,
    encoding: 'utf8',
    env
  })

  const tagChanges = fs.existsSync(tagLog)
    ? fs
        .readFileSync(tagLog, 'utf8')
        .split('\n')
        .filter((line) => line.length > 0)
    : []

  fs.rmSync(dir, { recursive: true, force: true })
  return {
    status: result.status,
    output: `${result.stdout}${result.stderr}`,
    tagChanges
  }
}

const versions = (...list: string[]) => JSON.stringify(list)

describe('reconcile-npm-latest-tag.sh', () => {
  it.for([
    {
      scenario: 'a backport publish moved latest below a newer release',
      registry: {
        versionsJson: versions('1.57.5', '1.60.0', '1.57.6'),
        latest: '1.57.6'
      },
      version: undefined,
      expected: '1.60.0'
    },
    {
      scenario: 'versions differ only past the ninth patch (1.57.10 > 1.57.9)',
      registry: {
        versionsJson: versions('1.57.9', '1.57.10'),
        latest: '1.57.9'
      },
      version: undefined,
      expected: '1.57.10'
    },
    {
      scenario: 'a prerelease is the newest publish',
      registry: {
        versionsJson: versions('1.60.0', '1.61.0-rc.1'),
        latest: '1.61.0-rc.1'
      },
      version: undefined,
      expected: '1.60.0'
    },
    {
      scenario: 'the just-published version is not yet visible in the registry',
      registry: {
        versionsJson: versions('1.59.0', '1.60.0'),
        latest: '1.60.0'
      },
      version: '1.61.0',
      expected: '1.61.0'
    },
    {
      scenario: 'the registry returns a single version as a bare string',
      registry: { versionsJson: '"1.60.0"', latest: '' },
      version: undefined,
      expected: '1.60.0'
    }
  ])(
    'points latest at the highest stable version when $scenario',
    ({ registry, version, expected }) => {
      const { status, tagChanges } = runReconcile(registry, { version })

      expect(status).toBe(0)
      expect(tagChanges).toEqual([`dist-tag add ${PACKAGE}@${expected} latest`])
    }
  )

  it('leaves latest alone when it already points at the highest stable version', () => {
    const { status, output, tagChanges } = runReconcile(
      { versionsJson: versions('1.57.6', '1.60.0'), latest: '1.60.0' },
      { version: '1.57.6' }
    )

    expect(status).toBe(0)
    expect(tagChanges).toEqual([])
    expect(output).toContain('already points at the highest stable version')
  })

  it('exits cleanly with a warning when no stable version exists', () => {
    const { status, output, tagChanges } = runReconcile(
      { versionsJson: versions('1.61.0-rc.1'), latest: '1.61.0-rc.1' },
      { version: '1.61.0-rc.2' }
    )

    expect(status).toBe(0)
    expect(tagChanges).toEqual([])
    expect(output).toContain('No stable versions')
  })

  it('fails without changing tags when the registry lookup fails', () => {
    const { status, tagChanges } = runReconcile({
      versionsJson: '',
      latest: '1.57.6',
      viewStatus: 1
    })

    expect(status).not.toBe(0)
    expect(tagChanges).toEqual([])
  })

  it('exits non-zero with a clear error when PACKAGE is unset', () => {
    const { status, output, tagChanges } = runReconcile(
      { versionsJson: versions('1.60.0'), latest: '1.57.6' },
      { packageName: null }
    )

    expect(status).not.toBe(0)
    expect(output).toContain('PACKAGE is required')
    expect(tagChanges).toEqual([])
  })
})

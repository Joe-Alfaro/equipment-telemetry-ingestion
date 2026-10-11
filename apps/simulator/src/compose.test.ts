import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'

interface ComposeService {
  profiles?: string[]
  build?: { context?: string; target?: string; args?: Record<string, string> | string[] }
  depends_on?: Record<string, { condition?: string }> | string[]
}

interface ComposeFile {
  services: Record<string, ComposeService>
}

function repoFile(name: string): string {
  return readFileSync(fileURLToPath(new URL(`../../../${name}`, import.meta.url)), 'utf8')
}

const compose = parse(repoFile('docker-compose.yml')) as ComposeFile

describe('docker-compose: simulator service (rule 7)', () => {
  it('puts the simulator under profiles ["demo"] only', () => {
    expect(compose.services.simulator).toBeDefined()
    expect(compose.services.simulator?.profiles).toEqual(['demo'])
  })

  it('leaves every other service without a profile, so plain `docker compose up` is unchanged', () => {
    const profiled = Object.entries(compose.services)
      .filter(([name, service]) => name !== 'simulator' && service.profiles !== undefined)
      .map(([name]) => name)

    expect(Object.keys(compose.services)).toContain('simulator')
    expect(profiled).toEqual([])
  })

  it('starts the simulator only once the api is healthy', () => {
    const dependsOn = compose.services.simulator?.depends_on

    expect(dependsOn).toMatchObject({ api: { condition: 'service_healthy' } })
  })

  it('builds the simulator from the Dockerfile with a simulator target', () => {
    const build = compose.services.simulator?.build
    const args = Array.isArray(build?.args)
      ? Object.fromEntries(build.args.map((arg) => arg.split('=')))
      : (build?.args ?? {})

    expect(build?.target === 'simulator' || args.SERVICE_TARGET === 'simulator').toBe(true)
    expect(repoFile('Dockerfile')).toMatch(/^FROM \S+ AS simulator$/m)
    expect(repoFile('Dockerfile')).toMatch(/^COPY apps\/simulator\/package\.json /m)
  })
})

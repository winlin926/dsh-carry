import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import ts from 'typescript'

const ROOT = resolve(import.meta.dirname, '..')
const REMOTE_CONTRACT_DIR = join(ROOT, 'src', 'remote')
const REMOTE_SERVER_SRC = join(ROOT, 'remote-server', 'src')

function collectTsFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...collectTsFiles(full))
    else if (entry.isFile() && /\.(?:ts|tsx|mts)$/u.test(entry.name)) out.push(full)
  }
  return out.sort()
}

function readModuleSpecifiers(file: string): string[] {
  const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, false)
  const specs: string[] = []
  for (const statement of source.statements) {
    if ((ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement)) && statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier)) {
      specs.push(statement.moduleSpecifier.text)
    }
  }
  return specs
}

describe('shared contract boundary (src/remote)', () => {
  it('keeps src/remote self-contained without Host or third-party package imports', () => {
    for (const file of collectTsFiles(REMOTE_CONTRACT_DIR)) {
      for (const spec of readModuleSpecifiers(file)) {
        if (spec.startsWith('.')) {
          const resolved = resolve(dirname(file), spec)
          const rel = relative(REMOTE_CONTRACT_DIR, resolved)
          expect(rel.startsWith('..'), `${relative(ROOT, file)} must not import outside src/remote: ${spec}`).toBe(false)
          continue
        }
        // Only Node built-ins are allowed outside relative src/remote imports, and node-api.ts must remain browser-safe.
        expect(spec.startsWith('node:'), `${relative(ROOT, file)} must not depend on package "${spec}"`).toBe(true)
        expect(relative(ROOT, file).replaceAll('\\', '/')).not.toBe('src/remote/node-api.ts')
      }
    }
  })

  it('restricts remote-server cross-directory imports to src/remote only', () => {
    for (const file of collectTsFiles(REMOTE_SERVER_SRC)) {
      for (const spec of readModuleSpecifiers(file)) {
        if (!spec.startsWith('.')) continue
        const resolved = resolve(dirname(file), spec)
        const relToServer = relative(join(ROOT, 'remote-server'), resolved)
        if (!relToServer.startsWith('..')) continue
        const relToContract = relative(REMOTE_CONTRACT_DIR, resolved)
        expect(relToContract.startsWith('..'), `${relative(ROOT, file)} may only cross-import from src/remote: ${spec}`).toBe(false)
      }
    }
  })

  it('covers the whole src/remote directory in Docker and remote-server build configs', () => {
    const dockerignore = readFileSync(join(ROOT, '.dockerignore'), 'utf8')
    const dockerfile = readFileSync(join(ROOT, 'remote-server', 'Dockerfile'), 'utf8')
    const serverTsconfig = JSON.parse(readFileSync(join(ROOT, 'remote-server', 'tsconfig.json'), 'utf8')) as { include?: string[] }

    expect(dockerignore).toContain('!src/remote/**')
    expect(dockerfile).toContain('COPY src/remote ./src/remote')
    expect(serverTsconfig.include).toContain('../src/remote/**/*.ts')
  })
})

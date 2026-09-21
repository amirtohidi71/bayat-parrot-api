import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const testDirectory = path.dirname(fileURLToPath(import.meta.url))
const repositoryRoot = path.resolve(testDirectory, '..', '..')
const packagingScriptPath = path.join(repositoryRoot, 'tools', 'package-production.ps1')
const architecturePath = path.join(repositoryRoot, 'docs', 'ARCHITECTURE.md')
const deploymentPolicyPath = path.join(repositoryRoot, 'docs', 'DEPLOYMENT_POLICY.md')

const [script, architecture, deploymentPolicy] = await Promise.all([
  readFile(packagingScriptPath, 'utf8'),
  readFile(architecturePath, 'utf8'),
  readFile(deploymentPolicyPath, 'utf8'),
])

test('frontend packaging derives the Linux sharp runtime from the frontend lockfile', () => {
  assert.match(script, /Get-FrontendLinuxSharpRuntimeSpec/)
  assert.match(script, /node_modules\/sharp/)
  assert.match(script, /node_modules\/@img\/sharp-linux-x64/)
  assert.match(script, /node_modules\/@img\/sharp-libvips-linux-x64/)
  assert.match(script, /optionalDependencies/)
  assert.doesNotMatch(script, /SharpVersion\s*=\s*['"]\d/)
  assert.doesNotMatch(script, /BindingVersion\s*=\s*['"]\d/)
  assert.doesNotMatch(script, /LibvipsVersion\s*=\s*['"]\d/)
})

test('frontend packaging installs target dependencies outside the worktree', () => {
  assert.match(script, /frontend-linux-runtime/)
  assert.match(script, /npm\.cmd/)
  assert.match(script, /ci --omit=dev --include=optional --ignore-scripts --os=linux --cpu=x64 --libc=glibc --no-audit --no-fund/)
  assert.match(script, /Copy-Item -LiteralPath \(Join-Path \$FrontendRoot 'package-lock\.json'\) -Destination \$InstallRoot/)
  assert.match(script, /Install-FrontendLinuxSharpRuntime[^\n]+-StandaloneRoot \$standaloneTarget/)
})

test('frontend packaging rejects missing, mismatched, or foreign native runtimes before archiving', () => {
  const validationCall = script.lastIndexOf('Assert-FrontendLinuxSharpRuntime -StandaloneRoot')
  const archiveCall = script.lastIndexOf('New-TarGzArchive -SourceDirectory $frontendStage')

  assert.ok(validationCall >= 0, 'Linux sharp validation call is required')
  assert.ok(archiveCall > validationCall, 'Linux sharp validation must run before archive creation')
  assert.match(script, /does not contain a native \.node module/)
  assert.match(script, /does not contain a libvips shared library/)
  assert.match(script, /contains non-linux-x64 sharp runtimes/)
  assert.match(script, /Remove-OwnedDirectory -Path \$directory\.FullName/)
})

test('deployment documentation requires Linux execution and image-resize preflight', () => {
  assert.match(architecture, /built on Windows and runs on Ubuntu Linux x64 with glibc/)
  assert.match(deploymentPolicy, /require\('sharp'\)/)
  assert.match(deploymentPolicy, /\/_next\/image/)
  assert.match(deploymentPolicy, /128 pixels/)
  assert.match(deploymentPolicy, /smaller than the original/)
})

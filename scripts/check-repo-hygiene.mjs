// scripts/check-repo-hygiene.mjs
// 提交/CI 仓库卫生检查：.gitignore 防误加，本脚本防已被追踪或强制 add 的私有/可再生文件。

import { execFileSync } from 'node:child_process'

const trackedFiles = execFileSync('git', ['ls-files'], { encoding: 'utf8' })
  .split(/\r?\n/)
  .filter(Boolean)

const rules = [
  {
    label: 'generated output',
    matches: (file) =>
      /(^|\/)(node_modules|out|dist|coverage|dist-electron|test-results|playwright-report|blob-report|\.nyc_output)(\/|$)/.test(
        file
      )
  },
  {
    label: 'environment file',
    matches: (file) =>
      /(^|\/)\.env(?:\..+)?$/.test(file) &&
      file !== '.env.example' &&
      !file.endsWith('/.env.example')
  },
  {
    label: 'private key or signing certificate',
    matches: (file) => /\.(pfx|p12|pem|key)$/i.test(file)
  },
  {
    label: 'local Claude settings',
    matches: (file) => /(^|\/)\.claude\/settings\.local\.json$/i.test(file)
  },
  {
    label: 'secret data file',
    matches: (file) => /(^|\/)secrets?\.json$/i.test(file)
  },
  {
    label: 'temporary root verification screenshot',
    matches: (file) => /^verify-[^/]+\.png$/i.test(file)
  }
]

const violations = trackedFiles.flatMap((file) =>
  rules.filter((rule) => rule.matches(file)).map((rule) => ({ file, label: rule.label }))
)

if (violations.length > 0) {
  console.error('Repository hygiene check failed: forbidden files are tracked.')
  for (const violation of violations) {
    console.error(`  - ${violation.file} (${violation.label})`)
  }
  process.exit(1)
}

console.log(`Repository hygiene check passed: ${trackedFiles.length} tracked files inspected.`)

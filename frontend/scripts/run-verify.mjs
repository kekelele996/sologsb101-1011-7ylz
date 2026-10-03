/**
 * 验证脚本运行器：用 esbuild 把 scripts/verify-datum.mts 临时打包（解析 @ 别名）后执行。
 * 用法：npm run verify
 */
import { build } from 'esbuild'
import { pathToFileURL } from 'node:url'
import { rm } from 'node:fs/promises'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const outfile = resolve(here, '.verify-bundle.mjs')

await build({
  entryPoints: [resolve(here, 'verify-datum.mts')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  outfile,
  alias: { '@': resolve(here, '..', 'src') },
  logLevel: 'warning'
})

try {
  await import(pathToFileURL(outfile).href)
} finally {
  await rm(outfile, { force: true })
}

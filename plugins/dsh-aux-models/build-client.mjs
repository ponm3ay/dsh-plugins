// Rebuild lib/client.js from src/client.js（产物即构建，改源码后必跑）。
// 与 dsh-whale-backdrop/build-client.mjs 同款：源码逐字套壳，无打包器。
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(fileURLToPath(import.meta.url))
const id = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).name

const head =
  'window.__ModuleLoader__.load({ id: ' + JSON.stringify(id) + ', factory: (require) => {\n' +
  'var module = { exports: {} }; var exports = module.exports;\n'
const tail = '\nreturn module.exports; } });\n'

const source = readFileSync(join(root, 'src', 'client.js'), 'utf8')
if (source.includes('return module.exports; } });')) {
  throw new Error('build-client: src/client.js already carries the loader tail; it is source, not a bundle')
}

const bundle = head + source + tail
mkdirSync(join(root, 'lib'), { recursive: true })
writeFileSync(join(root, 'lib', 'client.js'), bundle)
console.log('build-client: lib/client.js written (' + String(bundle.length) + ' chars from ' + String(source.length) + ')')

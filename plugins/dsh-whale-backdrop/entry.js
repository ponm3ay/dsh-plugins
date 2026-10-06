// dsh-whale-backdrop — host half.
//
// Serves the backdrop art the browser half paints behind the app:
//
//   GET /plugins/dsh-whale-backdrop/images.json        → { primary, images: [...] }
//   GET /plugins/dsh-whale-backdrop/image/<file>?v=... → the bytes (ETag / 304)
//
// The bytes route is a PREFIX below `<ROUTE>/image`, never on `<ROUTE>` itself:
// the web server resolves prefixes longest-first, and the browser fetches this
// package's own client bundle under `<ROUTE>/client.js` — a prefix on the root
// would answer that request with this plugin's 404 and the bundle would never
// materialize (the same trap `dsh-boot-animation` documents in its entry.js).
//
// Nothing here writes state: the assets directory IS the configuration. Drop a
// file in, the manifest picks it up on the next request (the browser half asks
// for a fresh revision per page load).
import { readdir, stat } from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import { extname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const ASSETS = fileURLToPath(new URL('./assets/', import.meta.url))
const ROUTE = '/plugins/dsh-whale-backdrop'
const PREFIX = ROUTE + '/image'
const PRIMARY = 'backdrop.jpg'
const TYPES = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
}

export const name = 'dsh-whale-backdrop'
export const inject = ['webServer']

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(Buffer.byteLength(body)),
    'cache-control': 'no-store',
  })
  res.end(body)
}

/** Every image directly inside ./assets, sorted by name. Subdirectories are skipped. */
async function listImages() {
  const images = []
  for (const entry of await readdir(ASSETS, { withFileTypes: true })) {
    if (!entry.isFile()) continue
    const type = TYPES[extname(entry.name).toLowerCase()]
    if (type === undefined) continue
    const info = await stat(join(ASSETS, entry.name))
    images.push({
      name: entry.name,
      bytes: info.size,
      // Size+time is the same pair the bytes route answers as its ETag, so the
      // URL the browser half builds is unreachable once the file changes.
      revision: String(info.size) + '-' + String(Math.round(info.mtimeMs)),
      type,
    })
  }
  images.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  return images
}

/** Resolve `<file>` under ./assets, refusing anything that escapes it. */
function resolveImage(requestUrl) {
  const path = String(requestUrl ?? '').split('?')[0]
  let name = path.startsWith(PREFIX) ? path.slice(PREFIX.length) : path
  try {
    name = decodeURIComponent(name)
  } catch {
    return undefined
  }
  name = name.replace(/^\/+/, '')
  if (name === '' || name.includes('/') || name.includes('\\') || name.includes('..')) return undefined
  if (TYPES[extname(name).toLowerCase()] === undefined) return undefined
  const absolute = resolve(ASSETS, name)
  if (!absolute.startsWith(resolve(ASSETS) + sep)) return undefined
  return { name, absolute }
}

async function serveImage(file, req, res) {
  const info = await stat(file.absolute)
  const type = TYPES[extname(file.name).toLowerCase()]
  const etag = '"' + String(info.size) + '-' + String(Math.round(info.mtimeMs)) + '"'
  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304, { etag })
    res.end()
    return
  }
  const head = {
    'content-type': type,
    'content-length': String(info.size),
    etag,
    'last-modified': new Date(info.mtimeMs).toUTCString(),
    // The revision rides in `?v=`, so the body under that URL can never go stale.
    'cache-control': 'public, max-age=31536000, immutable',
  }
  if (req.method === 'HEAD') {
    res.writeHead(200, head)
    res.end()
    return
  }
  res.writeHead(200, head)
  createReadStream(file.absolute).pipe(res)
}

export function apply(ctx) {
  const server = ctx.webServer

  ctx.effect(() => server.register({
    kind: 'exact',
    path: ROUTE + '/images.json',
    handler: (req, res) => {
      void (async () => {
        const images = await listImages()
        const primary = images.find(image => image.name === PRIMARY) ?? images[0]
        sendJson(res, 200, {
          primary: primary === undefined ? null : primary.name,
          images,
        })
      })().catch(error => {
        ctx.logger?.error?.('whale-backdrop: manifest route failed', error)
        if (res.headersSent !== true) sendJson(res, 500, { error: 'internal' })
        else res.end()
      })
    },
  }), 'whale-backdrop: manifest route')

  ctx.effect(() => server.register({
    kind: 'prefix',
    path: PREFIX,
    handler: (req, res) => {
      const file = resolveImage(req.url)
      if (file === undefined) {
        sendJson(res, 404, { error: 'not found' })
        return
      }
      void serveImage(file, req, res).catch(error => {
        if (error?.code === 'ENOENT') {
          sendJson(res, 404, { error: 'not found' })
          return
        }
        ctx.logger?.error?.('whale-backdrop: image route failed', error)
        if (res.headersSent !== true) sendJson(res, 500, { error: 'internal' })
        else res.end()
      })
    },
  }), 'whale-backdrop: image route')
}

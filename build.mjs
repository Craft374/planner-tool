import { build } from 'esbuild'
import { cp, rm } from 'node:fs/promises'

await rm('dist', { recursive: true, force: true })
const common = { bundle: true, minify: true, logLevel: 'info', legalComments: 'none' }
await Promise.all([
  build({ ...common, entryPoints: ['src/main.ts'], outfile: 'dist/main.js', platform: 'node', format: 'cjs', target: 'node22', external: ['electron', 'node-pty'] }),
  build({ ...common, entryPoints: ['src/preload.ts'], outfile: 'dist/preload.js', platform: 'node', format: 'cjs', target: 'node22', external: ['electron'] }),
  // app.ts가 불러오는 CSS는 dist/renderer/app.css로 묶인다.
  build({ ...common, entryPoints: ['src/renderer/app.ts'], outfile: 'dist/renderer/app.js', platform: 'browser', format: 'iife', target: 'chrome130' }),
  cp('src/renderer/index.html', 'dist/renderer/index.html'),
  cp('resources/logo.svg', 'dist/renderer/logo.svg'),
])

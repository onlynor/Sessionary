// Builds design/playground.html: one self-contained file (Inter + JetBrains Mono + lucide sprite inlined).
// usage: pnpm build:design   (reads lucide-static and the @fontsource-variable fonts from node_modules)
import { readFileSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
const here = dirname(fileURLToPath(import.meta.url))
const nm = join(here, '..', '..', 'node_modules')
const ICONS = ['panel-left','panel-left-close','panel-left-open','panel-right','search','command','chevron-right','chevron-down','chevrons-up-down','folder','folder-open','file','file-text','git-branch','git-commit-horizontal','terminal','file-pen','file-plus','globe','bot','list-checks','lightbulb','layers','list-chevrons-down-up','chevrons-down-up','ellipsis','trash-2','eye-off','arrow-up','arrow-down','keyboard','sun-moon','settings-2','refresh-cw','clock','message-square','copy','check','x','lock','lock-open','pencil','hash','plus','square','cpu','coins','wrench','corner-down-left','text-search','circle-dot','sun','moon','monitor','external-link','archive-restore','arrow-up-down','info','list-filter','history']
const sym = ICONS.map((n) => {
  const svg = readFileSync(join(nm, 'lucide-static/icons', n + '.svg'), 'utf8')
  const body = svg.replace(/<!--[\s\S]*?-->/, '').replace(/^[\s\S]*?<svg[^>]*>/, '').replace(/<\/svg>\s*$/, '').replace(/\s+/g, ' ').trim()
  return `<symbol id="i-${n}" viewBox="0 0 24 24">${body}</symbol>`
}).join('')
const b64 = (p) => readFileSync(join(nm, p)).toString('base64')
const fonts = `@font-face{font-family:'Inter';font-style:normal;font-weight:100 900;font-display:block;src:url(data:font/woff2;base64,${b64('@fontsource-variable/inter/files/inter-latin-opsz-normal.woff2')}) format('woff2')}
@font-face{font-family:'JetBrains Mono';font-style:normal;font-weight:100 800;font-display:block;src:url(data:font/woff2;base64,${b64('@fontsource-variable/jetbrains-mono/files/jetbrains-mono-latin-wght-normal.woff2')}) format('woff2')}`
const src = readFileSync(join(here, 'src.html'), 'utf8')
writeFileSync(join(here, '..', 'playground.html'), src.replace('/*FONTS*/', () => fonts).replace('<!--ICONS-->', () => `<svg width="0" height="0" style="position:absolute" aria-hidden="true">${sym}</svg>`))
console.log('wrote design/playground.html')

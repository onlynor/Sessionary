# Third-party notices

Sessionary itself is licensed under the [Apache License 2.0](LICENSE). This file covers the third-party code it
builds on, verified against the actual build output (`pnpm build`) rather than assumed from `package.json`.

## The server (`dist/`)

`dist/cli.js` is built with `tsup`, which externalizes Sessionary's two runtime dependencies rather than inlining
them: `hono` and `@hono/node-server` (both MIT, © the Hono authors / Yusuke Wada). They are not bundled into
`dist/cli.js`; when Sessionary is installed, npm installs them as ordinary packages next to it, each carrying its
own `LICENSE` file as usual. No separate notice is needed for them here.

## The web client (`web-dist/`)

`web-dist/` is a Vite/Rollup production bundle, so the browser-side libraries it imports are compiled directly into
`web-dist/assets/*.js` and `*.woff2`. Rollup preserves each library's own `/** @license … */` banner at the top of
its compiled code (confirmed in the built output), which is the primary attribution mechanism for these; the table
below is a verified summary, not a substitute for those banners.

Directly imported by `web/src` (`pnpm licenses list`):

| Package | License | Copyright / author |
|---|---|---|
| react, react-dom | MIT | Meta Platforms, Inc. and affiliates |
| react-markdown | MIT | Espen Hovlandsdal |
| remark-gfm | MIT | Titus Wormer |
| @tanstack/react-virtual | MIT | Tanner Linsley |
| @xterm/xterm, @xterm/addon-fit | MIT | The xterm.js authors |
| lucide-react | ISC | Eric Fennis |
| highlight.js | BSD-3-Clause | Josh Goebel |

`react-markdown` and `remark-gfm` pull in the `unified`/`remark`/`rehype`/`mdast`/`hast` processing pipeline they run
on (also compiled into `web-dist/assets/*.js`, since it runs in the browser) — `unified`, `remark-parse`,
`remark-rehype`, `remark-stringify`, `hast-util-to-jsx-runtime`, `property-information`, `vfile` and its
dependents, `unist-util-*`, `zwitch`, `stringify-entities`, `parse-entities`, `trough`, `devlop`,
`html-url-attributes`, `space-separated-tokens`, `comma-separated-tokens`, `style-to-js`/`style-to-object`,
`@ungap/structured-clone` and similar small utilities. All of them are **MIT**-licensed (verified with
`pnpm licenses list`); their own license banners are preserved in the bundle the same way.

Two fonts are bundled as `.woff2` files rather than code: `@fontsource-variable/inter` and
`@fontsource-variable/jetbrains-mono`, both under the **SIL Open Font License, Version 1.1** — Inter ©
2016 The Inter Project Authors, JetBrains Mono © 2020 the JetBrains Mono Project Authors.

Build-only tooling (`vite`, `tsup`, `tsx`, `typescript`, `@vitejs/plugin-react`, `postcss`, `rollup`, `esbuild` and
their own dependencies) runs at build time and ships in none of the distributed output, so it needs no notice here.

## License texts

### MIT

```
MIT License

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### ISC (lucide-react)

```
ISC License

Copyright (c) for portions of this code are held by Cole Bemis 2013-2022 and
the rest are held by Lucide Contributors 2022-present.

Permission to use, copy, modify, and/or distribute this software for any
purpose with or without fee is hereby granted, provided that the above
copyright notice and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH
REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY
AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT,
INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM
LOSS OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR
OTHER TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR
PERFORMANCE OF THIS SOFTWARE.
```

### BSD-3-Clause (highlight.js)

```
BSD 3-Clause License

Copyright (c) 2006, Ivan Sagalaev.
All rights reserved.

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are met:

* Redistributions of source code must retain the above copyright notice, this
  list of conditions and the following disclaimer.

* Redistributions in binary form must reproduce the above copyright notice,
  this list of conditions and the following disclaimer in the documentation
  and/or other materials provided with the distribution.

* Neither the name of highlight.js nor the names of its contributors may be
  used to endorse or promote products derived from this software without
  specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
```

### SIL Open Font License 1.1 (Inter, JetBrains Mono)

The full OFL-1.1 text is long and standardized; see <https://scripts.sil.org/OFL> for the canonical copy. In
summary, it permits using, embedding, modifying and redistributing the fonts (including as part of this web
application) as long as they are not sold by themselves and derivative fonts are renamed.

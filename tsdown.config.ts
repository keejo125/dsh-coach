/**
 * 双面构建（惯例对齐 dsh-workbench-plugin，零代码复用）：
 * - Node 面：src/host/index.ts → lib/index.js（host 插件，external 全部裸导入）
 * - Browser 面：src/client/index.tsx → lib/client.js（closure-factory 产物，
 *   `window.__ModuleLoader__.load({id, factory})` 注册，require 走模块表）
 * - CSS Modules 内联编译：`*.module.css` 经 lightningcss 编译为哈希类名映射，
 *   factory 执行期注入 `<style data-plugin-css>` 标签。
 */
import { defineConfig } from 'tsdown'
import { readFile } from 'node:fs/promises'
import { basename, dirname, resolve as resolvePath } from 'node:path'
import { transform } from 'lightningcss'

const CSS_VIRTUAL_PREFIX = '\0dsh-css:'
const CSS_VIRTUAL_SUFFIX = '.mjs'
const PLUGIN_ID = 'dsh-coach'

function contextCssModules(pluginId: string) {
  return {
    name: 'dsh-coach-css-modules',
    resolveId(source: string, importer: string | undefined) {
      if (!source.endsWith('.module.css') || importer === undefined) return null
      const abs = resolvePath(dirname(importer.split('?')[0] ?? importer), source)
      return CSS_VIRTUAL_PREFIX + abs + CSS_VIRTUAL_SUFFIX
    },
    async load(this: { addWatchFile: (file: string) => void }, virtualId: string) {
      if (!virtualId.startsWith(CSS_VIRTUAL_PREFIX)) return null
      const fileId = virtualId.slice(CSS_VIRTUAL_PREFIX.length, -CSS_VIRTUAL_SUFFIX.length)
      this.addWatchFile(fileId)
      const source = await readFile(fileId)
      const { code, exports: cssExports } = transform({
        filename: fileId,
        code: source,
        cssModules: { pattern: '[hash]_[local]' },
        minify: true,
      })
      const classMap: Record<string, string> = {}
      for (const [local, exp] of Object.entries(cssExports ?? {})) classMap[local] = exp.name
      const css = code.toString()
      const tagId = `${pluginId}/${basename(fileId)}`
      return [
        `const css = ${JSON.stringify(css)};`,
        `const tagId = ${JSON.stringify(tagId)};`,
        'if (typeof document !== \'undefined\' && document.querySelector(\'style[data-plugin-css=\' + JSON.stringify(tagId) + \']\') === null) {',
        '  const tag = document.createElement(\'style\');',
        `  tag.dataset.plugin = ${JSON.stringify(pluginId)};`,
        '  tag.dataset.pluginCss = tagId;',
        '  tag.textContent = css;',
        '  document.head.appendChild(tag);',
        '}',
        `export default ${JSON.stringify(classMap)};`,
      ].join('\n')
    },
  }
}

/** 模块表基线 + runtime 预载行：保持 external，require 经模块表解析。 */
const CLIENT_EXTERNALS = [
  /^react$/,
  /^react\/jsx-runtime$/,
  /^react-dom(\/client)?$/,
  /^@deepseek-ai\/cordis$/,
  /^@deepseek-ai\/dsh-client-locale(\/client)?$/,
  /^@deepseek-ai\/dsh-client-ui-slots(\/client)?$/,
  /^@deepseek-ai\/dsh-client-ui-conversation(\/client)?$/,
]

export default defineConfig([
  {
    name: 'dsh-coach/host',
    entry: { index: 'src/host/index.ts' },
    outDir: 'lib',
    format: 'esm',
    platform: 'node',
    target: 'node22',
    dts: false,
    sourcemap: true,
    clean: true,
    external: [/^@deepseek-ai\//, /^node:/],
    outputOptions: { entryFileNames: 'index.js' },
  },
  {
    name: 'dsh-coach/client',
    entry: { client: 'src/client/index.tsx' },
    outDir: 'lib',
    format: 'cjs',
    platform: 'browser',
    dts: false,
    sourcemap: true,
    clean: false,
    external: CLIENT_EXTERNALS,
    plugins: [contextCssModules(PLUGIN_ID)],
    define: {
      'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production'),
      'import.meta.env.MODE': JSON.stringify(process.env.NODE_ENV ?? 'production'),
      'import.meta.env': JSON.stringify({ MODE: process.env.NODE_ENV ?? 'production' }),
    },
    outputOptions: {
      entryFileNames: 'client.js',
      banner: 'window.__ModuleLoader__.load({ id: "dsh-coach", factory: (require) => {',
      footer: 'return module.exports; } });',
      intro: 'var module = { exports: {} }; var exports = module.exports;',
    },
  },
])

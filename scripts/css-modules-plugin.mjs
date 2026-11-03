import { dirname } from 'node:path'
import { build } from 'esbuild'

export function cssModulesPlugin() {
  return {
    name: 'dsh-css-modules',
    setup(builder) {
      builder.onLoad({ filter: /\.module\.css$/ }, async args => {
        const result = await build({
          stdin: {
            contents: `import styles from ${JSON.stringify(args.path)}; export default styles`,
            resolveDir: dirname(args.path),
            sourcefile: 'css-module.js',
            loader: 'js',
          },
          outfile: 'css-module.js',
          bundle: true,
          write: false,
          format: 'esm',
          loader: { '.css': 'local-css' },
          logLevel: 'silent',
        })
        const module = result.outputFiles.find(file => file.path.endsWith('.js'))
        const stylesheet = result.outputFiles.find(file => file.path.endsWith('.css'))
        if (module === undefined || stylesheet === undefined) {
          throw new Error(`CSS Module build emitted incomplete output: ${args.path}`)
        }
        return {
          contents: `${module.text}\nconst cssText = ${JSON.stringify(stylesheet.text)};\n` +
            'export function installCss() {\n' +
            "  const style = document.createElement('style')\n" +
            "  style.setAttribute('data-dsh-agent-enhancer', '')\n" +
            '  style.textContent = cssText\n' +
            '  document.head.append(style)\n' +
            '  return () => style.remove()\n' +
            '}\n',
          loader: 'js',
          resolveDir: dirname(args.path),
        }
      })
    },
  }
}

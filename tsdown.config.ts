import type { UserConfig } from 'tsdown'

export const bootConfig: UserConfig = {
  entry: { boot: 'src/boot/entry.ts' },
  outDir: 'lib',
  format: 'iife',
  platform: 'browser',
  target: 'es2022',
  clean: false,
  dts: false,
  fixedExtension: false,
  globalName: '__dshBootBundle',
  deps: { onlyBundle: false },
  outputOptions: { entryFileNames: 'boot.js', codeSplitting: false },
}

const host: UserConfig = {
  entry: ['lib/types/index.js'],
  outDir: 'lib',
  format: 'esm',
  platform: 'node',
  target: 'es2024',
  clean: false,
  dts: false,
  fixedExtension: false,
  deps: {
    neverBundle: ['@deepseek-ai/cordis', '@deepseek-ai/schemastery', '@deepseek-ai/dsh-host-webserver', 'ws', 'undici'],
    onlyBundle: false,
  },
}

const client: UserConfig = {
  entry: { client: 'lib/types/client/index.js' },
  outDir: 'lib',
  format: 'cjs',
  platform: 'browser',
  target: 'es2022',
  clean: false,
  dts: false,
  fixedExtension: false,
  deps: { neverBundle: ['react', 'react/jsx-runtime'], onlyBundle: false },
  define: { 'process.env.NODE_ENV': JSON.stringify('production') },
  outputOptions: {
    entryFileNames: 'client.js',
    banner: 'window.__ModuleLoader__.load({ id: "@winlin926/dsh-carry", factory: (require) => {',
    intro: 'var module = { exports: {} }; var exports = module.exports;',
    footer: 'return module.exports; } });',
  },
}

export default [host, client, bootConfig]

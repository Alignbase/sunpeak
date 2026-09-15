import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import dts from 'vite-plugin-dts';
import tailwindcss from '@tailwindcss/vite';
import { resolve } from 'path';
import { builtinModules } from 'module';

// Node.js built-in modules to externalize
const nodeBuiltins = builtinModules.flatMap((m) => [m, `node:${m}`]);

// Tailwind v4's @source directive may be visible to lightningcss during
// parsing/minification. Declaring it as a custom at-rule suppresses warnings.
const lightningcssConfig = {
  customAtRules: {
    source: { prelude: '<string>' as const },
  },
};

export default defineConfig({
  css: { lightningcss: lightningcssConfig },
  plugins: [
    react(),
    tailwindcss(),
    dts({
      include: ['src/**/*.ts', 'src/**/*.tsx'],
      exclude: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
      entryRoot: 'src',
      outDir: 'dist',
      rollupTypes: false,
    }),
  ],
  build: {
    lib: {
      entry: {
        index: resolve(__dirname, 'src/index.ts'),
        'inspector/index': resolve(__dirname, 'src/inspector/index.ts'),
        'chatgpt/index': resolve(__dirname, 'src/chatgpt/index.ts'),
        'claude/index': resolve(__dirname, 'src/claude/index.ts'),
        'lib/discovery-cli': resolve(__dirname, 'src/lib/discovery-cli.ts'),
        'mcp/index': resolve(__dirname, 'src/mcp/index.ts'),
        'host/index': resolve(__dirname, 'src/host/index.ts'),
        'host/chatgpt/index': resolve(__dirname, 'src/host/chatgpt/index.ts'),
      },
      formats: ['es', 'cjs'],
      fileName: (format, entryName) => {
        const ext = format === 'es' ? 'js' : 'cjs';
        return `${entryName}.${ext}`;
      },
    },
    outDir: 'dist',
    sourcemap: true,
    minify: false,
    cssCodeSplit: false,
    rollupOptions: {
      external: [
        'react',
        'react-dom',
        'react/jsx-runtime',
        '@modelcontextprotocol/client',
        '@modelcontextprotocol/client/stdio',
        '@modelcontextprotocol/core',
        '@modelcontextprotocol/server',
        '@modelcontextprotocol/server/stdio',
        '@modelcontextprotocol/node',
        'esbuild',
        'zod',
        'raw-body',
        ...nodeBuiltins,
      ],
      output: {
        preserveModules: false,
        assetFileNames: (assetInfo) => {
          if (assetInfo.names?.[0]?.endsWith('.css')) {
            return 'style.css';
          }
          return '[name][extname]';
        },
      },
    },
  },
});

import { defineConfig } from 'bunup'

export default defineConfig({
	entry: './mcp/index.ts',
	outDir: './dist',
	format: 'esm',
	dts: true,
	clean: true,
	splitting: false,
})

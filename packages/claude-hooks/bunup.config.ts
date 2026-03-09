import { defineConfig } from 'bunup'

export default defineConfig({
	entry: './hooks/index.ts',
	outDir: './dist',
	format: 'esm',
	dts: true,
	clean: true,
	splitting: false,
	target: 'bun',
})

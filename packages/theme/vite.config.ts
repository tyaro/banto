import { defineConfig } from 'vite';

// Only what `vitest` needs: pure logic tests (node environment).
export default defineConfig({
	test: {
		environment: 'node'
	}
});

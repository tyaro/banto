import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';

// 派生アプリが置く `optimizeDeps.exclude`（ADR-0007、#150）。`.svelte.ts` を
// ソース配布する `@banto/*` を dev の依存オプティマイザから外す。一覧は
// apps/admin-template/vite.config.ts と同じで、verify:architecture（rule
// `external-consumer-fixture`）が「packages/ のうち .svelte.ts を持つもの」との
// 一致を検査する。
//
// `BANTO_FIXTURE_NO_EXCLUDE=1` のときだけ exclude を外す。CI の診断ジョブ
// （成功条件にしない）が #150 がまだ再現するかを記録するためのもの。
const noExclude = process.env.BANTO_FIXTURE_NO_EXCLUDE === '1';

export default defineConfig({
	plugins: [sveltekit()],
	optimizeDeps: noExclude
		? {}
		: {
				exclude: [
					'@banto/admin-core',
					'@banto/dock-svelte',
					'@banto/forms',
					'@banto/grid-svelte',
					'@banto/tree-svelte'
				]
			},
	server: {
		host: '127.0.0.1',
		port: 4319,
		strictPort: true
	},
	clearScreen: false
});

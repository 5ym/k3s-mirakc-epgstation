/**
 * EPGStation の録画を denpa に引き継ぐ。
 *
 *   bun scripts/migrate-epgstation.ts              # 何が起きるか出すだけ
 *   bun scripts/migrate-epgstation.ts --apply      # 実際に取り込む
 *   bun scripts/migrate-epgstation.ts --apply --move   # コピーではなく移動する
 *
 * 中身は src/lib/server/migrate.ts にある。設定画面から実行するときと同じものを使う。
 * denpa の Pod に EPGStation のPVCをマウントできないときのために CLI も残してある
 * (k3s/migrate-job.yaml)。
 */
import { config } from '../src/lib/server/config';
import { run, source } from '../src/lib/server/migrate';

const apply = process.argv.includes('--apply');
const move = process.argv.includes('--move');

const result = await run({ apply, move });
for (const line of result.log) console.log(line);

if (result.state === 'failed') {
    console.error(`\n失敗: ${result.error}`);
    process.exit(1);
}

console.log(
    `\n${apply ? '完了' : '(--apply を付けると実行します)'}: ` +
        `取り込み ${result.imported} 件 / 取り込み済み ${result.skipped} 件 / ファイル無し ${result.missing} 件`,
);
console.log(`引き継ぎ元: ${source.recordedDir}`);
console.log(`ライブラリ: ${config.libraryDir}`);

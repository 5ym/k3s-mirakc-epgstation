/**
 * 送信中のフォームの数。0より大きい間はローディングバーを出す。
 *
 * `navigating` は画面遷移しか見ておらず、フォームのアクション(EPG取得など)は
 * 数秒かかっても何の表示も出ないまま押し放題になっていた。
 */
let count = $state(0);

export const busy = {
    get active(): boolean {
        return count > 0;
    },
};

export function begin(): void {
    count++;
}

export function finish(): void {
    count = Math.max(0, count - 1);
}

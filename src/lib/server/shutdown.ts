/**
 * 止められている最中かどうか。
 *
 * ArgoCD の同期やイメージの入れ替えで Pod が差し替わるとき、録画中でも
 * 容赦なく止められる。TSは追記で開いているので**次の起動で続きから録れる**が、
 * 入れ替わるまでの十数秒は落ちる。そこを落としたくないので、
 * SIGTERM を受けても**録画が終わるまで居座る** (runtime.ts)。
 *
 * 居座っている間に新しい録画を始めてしまうと、いつまでも終わらない。
 * スケジューラはこの印を見て、始めるほうだけを止める
 * (走っているものは最後まで通す)。
 *
 * 小さな別モジュールにしてあるのは、runtime と scheduler の両方から
 * 見たいため (同じファイルに置くと読み込みが輪になる)。
 */

let draining = false;

export function beginDraining(): void {
    draining = true;
}

export function isDraining(): boolean {
    return draining;
}

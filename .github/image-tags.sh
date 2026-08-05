#!/bin/sh
# イメージごとの「そのイメージの中身を最後に変えたコミット」を出す。
#
# 全部を HEAD で揃えると、denpa を直しただけの push でエージェントのタグまで
# 変わり、録画中に選局が落ちる。
#
# **2つのワークフローが同じ答えを要る。** main の build-and-deploy と、
# リリースのときに latest を貼り替える release で、指す先が違ったら意味が無い。
# 書き写すと片方だけ直したときに食い違うので、ここ1つに置く。
#
# 使い方: . .github/image-tags.sh  → $AGENT_TAG と $DENPA_TAG が入る
set -eu

# denpa はリポジトリ直下なので、エージェントなど別物のパスを除いて見る
denpa_paths="Dockerfile src static package.json bun.lock svelte.config.js vite.config.ts"

AGENT_TAG="sha-$(git log -1 --format=%H -- agent | cut -c1-12)"
DENPA_TAG="sha-$(git log -1 --format=%H -- $denpa_paths | cut -c1-12)"

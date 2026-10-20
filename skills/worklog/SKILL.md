---
name: worklog
description: このセッションのここまでの作業時間を worklog.md に記録し、Issue のリポジトリの worklog.csv へ追記する。/exit 時に自動で走る処理と同じもの
disable-model-invocation: true
allowed-tools: Bash(node *)
---

このセッションの工数を記録します。次のコマンドを Bash ツールで **1 回だけ** 実行してください（タイトル要約と GitHub への書き込みで時間がかかるため、timeout は 300000 を指定）。

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/worklog-end.cjs" --session ${CLAUDE_SESSION_ID}
```

実行後は、標準出力に表示された結果をそのまま利用者に伝えてください。それ以外の作業（ファイルの確認、再実行、修正）はしないでください。

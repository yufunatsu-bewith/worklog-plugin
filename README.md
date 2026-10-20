# worklog plugin

Claude Code のセッション時間を自動で記録し、GitHub Issue のリポジトリにある `worklog.csv` へ工数を追記する Claude Code プラグインです。

## 何をするか

| タイミング | スクリプト | 内容 |
| --- | --- | --- |
| セッション開始 | `worklog-start.cjs` | 開始時刻を記録 |
| セッション開始 | `worklog-csv-sync.cjs` | 前回までに送れなかった行を CSV へ再送 |
| プロンプト送信 | `worklog-issue-link.cjs` | `#123` や Issue URL を拾って記録先 Issue を設定 |
| 応答完了 | `worklog-stop.cjs` | 活動時刻を記録（無操作時間の除外に使う） |
| セッション終了 | `worklog-end.cjs` | `~/.claude/worklog/worklog.md` に追記し、CSV へ同期 |

途中で記録したいときは `/worklog:worklog` を実行します。

## 必要なもの

- Node.js 18 以上
- GitHub CLI (`gh`) でログイン済み、または Personal Access Token
- `claude` コマンドに PATH が通っていること（タイトルの自動要約に使用）

## インストール

Claude Code で次を実行します。

```
/plugin marketplace add yufunatsu-bewith/worklog-plugin
/plugin install worklog@worklog-marketplace
```

インストール後、Claude Code を再起動してください。

## 初期設定

`~/.claude/worklog/config.json` を作成します（`config.example.json` を参考に）。

```json
{
  "repo": "your-org/your-repo",
  "csvPath": "worklog.csv",
  "csvBranch": "worklog",
  "auth": "gh"
}
```

| キー | 説明 |
| --- | --- |
| `repo` | 既定の記録先リポジトリ。`#123` だけで指定したときはここの Issue になる |
| `repos` | `repo` 以外に記録先として許可するリポジトリの一覧 |
| `allowAnyRepo` | `true` にするとどのリポジトリの Issue でも記録先にできる |
| `csvPath` / `csvPaths` | リポジトリ内の CSV のパス（`csvPaths` はリポジトリ別に `{ "owner/repo": "path" }`） |
| `csvBranch` | CSV をコミットするブランチ（既定 `worklog`） |
| `auth` | `"gh"` で gh CLI のトークンを優先して使う |
| `token` / `tokenFile` / `tokens` | gh を使わない場合の Personal Access Token（`tokens` はリポジトリ別） |
| `userName` | CSV に書くユーザー名（省略時は GitHub のログイン名） |
| `idleMinutes` | 無操作とみなすまでの分数（既定 15） |

トークンは `config.json` に直接書くより、gh CLI（`"auth": "gh"`）か `tokenFile` を推奨します。

## 記録データの場所

プラグインの更新・削除をしても消えないよう、データはプラグインの外に置きます。

- `~/.claude/worklog/worklog.md` … 全セッションの記録
- `~/.claude/worklog/state/` … 実行中セッションの状態
- `~/.claude/worklog/issue-sync.log` … 同期のログ

## 以前の手動セットアップから移行する場合

`~/.claude/settings.json` に `~/.claude/hooks/worklog-*.cjs` を登録している場合は、**プラグインを入れたあとに必ず削除してください**。両方残っていると同じセッションが二重に記録されます。

1. `~/.claude/settings.json` の `hooks` から `worklog-` を含むエントリを削除
2. `~/.claude/skills/worklog/` を削除（プラグインの `/worklog:worklog` と重複するため）
3. `~/.claude/hooks/worklog-*.cjs` は削除して構いません（`~/.claude/worklog/` のデータはそのまま使われます）

## 更新

```
/plugin marketplace update worklog-marketplace
```

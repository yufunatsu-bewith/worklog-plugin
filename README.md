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

## 複数人・複数セッションで書き込みが重なったとき

- 他の人と同時に CSV を更新した場合は、GitHub が拒否するため他人の行を上書きすることはありません。最新の CSV を読み直し、1〜3秒のランダムな間隔を空けて最大5回やり直します。
- それでも書けなかった行は `worklog.md` の同期列が「送信中」のまま残り、次回のセッション開始時に再送します。再送の前に CSV に同じ行があるか確かめるので、通信切れなどで成否が分からなかった行が二重に入ることはありません。
- 同じ PC で複数のセッションが同時に終了しても、`~/.claude/worklog/*.lock` で1つずつ処理するため、同じ行を2回送ったり worklog.md の行が消えたりしません。

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
claude plugin marketplace update worklog-marketplace   # 配布元の最新情報を取得
claude plugin update worklog@worklog-marketplace         # インストール済みのプラグインを更新
```

更新後は Claude Code を再起動してください。`/plugin` のメニューからも更新できます。

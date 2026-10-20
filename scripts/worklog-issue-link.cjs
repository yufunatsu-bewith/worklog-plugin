#!/usr/bin/env node
// UserPromptSubmit hook: 送信されたプロンプトから issue 参照を拾い、
// そのセッションの「現在の記録先 issue」を state ファイルに記録する。
//
// 受け付ける書き方（プロンプト中で最初に現れたものを採用）
//   https://github.com/owner/repo/issues/123  … URL の貼り付け
//   owner/repo#123                            … 別リポジトリを明示
//   myrepo#123                                … config.json が知っているリポジトリ名だけ
//   #123                                      … config.json の repo（既定リポジトリ）
//
// ただし記録先にできるのは「既定リポジトリと同じ owner」か config.json の repos に登録した
// リポジトリだけ。参考として貼った他人のリポジトリの URL で記録先が入れ替わる事故を防ぐため。
// どのリポジトリでも許可したい場合は config.json に "allowAnyRepo": true を入れる。
//
// ・issue の同一性は「リポジトリ名 + 番号」で判定する。番号だけが同じでも別リポジトリなら別 issue
// ・同一セッション内で別の issue が宣言されたら、その時点で記録先を切り替える。
//   切り替えより前の経過時間は前の issue に、以降は新しい issue に計上される（state.segments）
// ・正規表現マッチのみで判定するため、モデルの解釈に依存せず動作が決まる
// ・stdout はモデルのコンテキストに注入されるため、利用者への通知は systemMessage だけを使う
// ・issue の宣言が無くても、入力があったこと自体は「活動」として state に記録する
//   （無操作だった時間を工数から除くため。worklog-stop.cjs と対になっている）
const fs = require('fs');
const path = require('path');
const lib = require('./worklog-lib.cjs');

// タイトル生成用の `claude -p` 子セッション側では動かさない（worklog-end.cjs と同じ保険）
if (process.env.CLAUDE_WORKLOG_DISABLE === '1') {
  process.exit(0);
}

// issue の URL。owner/repo が確定するので最優先で拾う
const URL_RE = /github\.com\/([A-Za-z0-9._-]+\/[A-Za-z0-9._-]+)\/issues\/(\d{1,6})(?!\d)/g;
// "#123" と、その前に付くリポジトリ指定（省略可）。
// 直前が単語文字・#・/・.・- でないものだけを拾うので "C#5" や "#fff" や URL 断片は対象外になる
const HASH_RE = /(?<![\w#/.\-])([A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)?)?#(\d{1,6})(?!\d)/g;

// 直前の区間がこの秒数以内に始まっていた場合は「番号の言い直し」とみなし、
// 新しい区間を足さずに上書きする（打ち間違いで 0 分の区間が増えるのを防ぐ）
const CORRECTION_SEC = 60;

// config.json から既知のリポジトリ一覧を作る（repo = 既定、repos = 併用する他リポジトリ）
function knownRepos(cfg) {
  const list = [];
  if (cfg.repo) list.push(String(cfg.repo));
  if (Array.isArray(cfg.repos)) list.push(...cfg.repos.map(String));
  return list;
}

const eq = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();

// "owner/repo" を記録先として認めてよいか。
// 既定リポジトリと同じ owner か、config.json の repos に載っているものだけを通す
function isAllowedRepo(repo, cfg) {
  if (cfg.allowAnyRepo) return true;
  if (knownRepos(cfg).some((r) => eq(r, repo))) return true;
  const owner = cfg.repo ? String(cfg.repo).split('/')[0] : '';
  return Boolean(owner) && eq(repo.split('/')[0], owner);
}

// 省略記法を "owner/repo" に正規化する。解決できなければ null＝その参照は issue とみなさない
function resolveRepo(prefix, cfg) {
  if (!prefix) return cfg.repo ? String(cfg.repo) : '';
  if (prefix.includes('/')) return isAllowedRepo(prefix, cfg) ? prefix : null;
  // リポジトリ名だけの指定は、登録済みの名前と一致したときにのみ採用する
  // （"ver1#2" のような紛らわしい文字列を issue 参照と誤認しないため）
  const hit = knownRepos(cfg).find((r) => eq(r.split('/').pop(), prefix));
  return hit || null;
}

// プロンプト中で最も手前に現れる、解決できた issue 参照を返す。
// 明示的に "owner/repo#123" と書いたのに許可対象外だった場合だけ、理由を返して利用者に伝える
function findRef(prompt, cfg) {
  const found = [];
  let rejected = null;
  for (const m of prompt.matchAll(URL_RE)) {
    // 参照用に貼っただけの URL で切り替わらないよう、許可対象のリポジトリに限る
    if (!isAllowedRepo(m[1], cfg)) continue;
    found.push({ at: m.index, repo: m[1], issue: Number(m[2]) });
  }
  for (const m of prompt.matchAll(HASH_RE)) {
    const repo = resolveRepo(m[1], cfg);
    if (repo === null) {
      if (m[1] && m[1].includes('/') && (rejected === null || m.index < rejected.at)) {
        rejected = { at: m.index, repo: m[1], issue: Number(m[2]) };
      }
      continue;
    }
    found.push({ at: m.index, repo, issue: Number(m[2]) });
  }
  found.sort((a, b) => a.at - b.at);
  return found[0] || (rejected ? { rejected } : null);
}

function label(seg) {
  return `${seg.repo || '(既定リポジトリ)'}#${seg.issue}`;
}

let input = '';
process.stdin.on('data', (d) => (input += d));
process.stdin.on('end', () => {
  let data = {};
  try {
    data = JSON.parse(input || '{}');
  } catch {
    process.exit(0);
  }

  const cfg = lib.readConfig() || {};
  const sessionId = data.session_id || 'unknown';
  const p = lib.paths();
  const stateFile = path.join(p.stateDir, `${sessionId}.json`);

  let state = {};
  try {
    state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  } catch {
    // SessionStart が動いていない場合の保険。開始時刻はこの時点のものにする
    state = { start: new Date().toISOString(), cwd: data.cwd || '' };
  }

  const now = new Date();
  // 入力があった＝活動していた。issue の宣言が無い場合もここは必ず通る
  lib.touchActivity(state, now.toISOString(), cfg, false);

  const save = () => {
    try {
      fs.mkdirSync(p.stateDir, { recursive: true });
      fs.writeFileSync(stateFile, JSON.stringify(state), 'utf8');
      return true;
    } catch {
      return false; // 書けなくてもセッションは妨げない
    }
  };

  const ref = findRef(data.prompt || '', cfg);
  if (!ref) {
    save();
    process.exit(0);
  }

  // 許可対象外のリポジトリを明示指定された場合は、切り替えずに設定方法だけ伝える
  if (ref.rejected) {
    save();
    process.stdout.write(
      JSON.stringify({
        systemMessage: `⏱ ${ref.rejected.repo}#${ref.rejected.issue} は工数の記録先として未登録のため無視しました（~/.claude/worklog/config.json の "repos" に "${ref.rejected.repo}" を追加すると記録できます）`,
      })
    );
    process.exit(0);
  }

  // 旧形式（issue 1件だけを持つ state）からの移行
  if (!Array.isArray(state.segments)) {
    state.segments = state.issue
      ? [{ from: state.start, repo: state.repo || (cfg.repo ? String(cfg.repo) : ''), issue: Number(state.issue) }]
      : [];
  }

  const last = state.segments[state.segments.length - 1];

  // 同じ issue を再度書いただけなら何もしない（区間を分割しない）
  if (last && String(last.repo) === String(ref.repo) && Number(last.issue) === ref.issue) {
    save();
    process.exit(0);
  }

  // 区間の開始時刻。最初の区間だけはセッション開始まで遡って計上する
  const isCorrection = last && now - new Date(last.from) < CORRECTION_SEC * 1000;
  const from = state.segments.length === 0
    ? state.start
    : isCorrection
      ? last.from
      : now.toISOString();
  const seg = { from, repo: ref.repo, issue: ref.issue };

  if (isCorrection) state.segments[state.segments.length - 1] = seg;
  else state.segments.push(seg);

  // 後方互換（他スクリプトが state.issue を見る場合のため現在値を残す）
  state.issue = ref.issue;
  state.repo = ref.repo;

  if (!save()) process.exit(0);

  // 切り替わったことが利用者に見えないと事故のもとなので短い通知だけ出す。
  // systemMessage はモデルのコンテキストには入らない
  const msg = !last
    ? `⏱ このセッションの工数を ${label(seg)} に記録します`
    : isCorrection
      ? `⏱ 工数の記録先を ${label(seg)} に訂正しました`
      : `⏱ 工数の記録先を ${label(last)} から ${label(seg)} に切り替えました（ここまでの時間は ${label(last)} に計上）`;
  process.stdout.write(JSON.stringify({ systemMessage: msg }));
});

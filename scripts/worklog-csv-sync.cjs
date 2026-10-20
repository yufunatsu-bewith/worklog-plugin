#!/usr/bin/env node
// worklog.md の各行を、対象リポジトリ内の CSV へ追記する。
//
//   ・issue 列が埋まっていて 同期 列が空の行 → その行のリポジトリにある CSV に1行追加する
//   ・書き込めたら worklog.md の 同期 列を「済」にする（＝二重書き込みの防止）
//   ・同じリポジトリ宛の行はまとめて1コミットにする
//
// CSV は「issue のあるリポジトリごと」に置かれている前提で、リポジトリ内の相対パスを
// config.json の csvPath（リポジトリ別に変えるなら csvPaths）で指定する。
//
// コミット先は工数専用ブランチ（既定 "worklog"）。開発の履歴に工数コミットが混ざらないよう、
// 既定ブランチとは履歴を共有しない孤立ブランチとして作る（誤ってマージされる事故も防ぐ）。
// 既定ブランチに直接置きたい場合は config.json の csvBranch に "main" などを指定する。
//
// 列の並び（7列目は実作業時間。指定の6列＋末尾に追加したもの）
//   ユーザー名, リポジトリ名, issue-id, 開始日時(yyyymmdd), 終了日時(yyyymmdd), 作業の概要, 実作業h
//
// 既存ファイルには追記するだけで、ヘッダ行・改行コード・BOM は元のまま維持する。
// ファイルが無い場合のみ、ヘッダ行を付けて新規作成する。
//
// 通信は GitHub Contents API を Node の fetch で直接叩く（リポジトリを clone しない。
// 追加パッケージへの依存も無し）。認証は gh CLI のトークンか Personal Access Token。
//
// 実行タイミング: SessionEnd（記録直後に即時）と SessionStart（取りこぼしの追いつき）の両方。
// 手動実行も可: node worklog-csv-sync.cjs
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const lib = require('./worklog-lib.cjs');

const API = 'https://api.github.com';
const TIMEOUT = 30000;

// CSV の列。指定の6列に、作業時間を残すための「実作業h」を足している
const HEADER = [
  'ユーザー名',
  'リポジトリ名',
  'issue-id',
  '開始日時',
  '終了日時',
  '作業の概要',
  '実作業h',
];

// gh CLI の実行ファイルを探す。Claude Code の起動後に gh を入れた場合、
// hook に渡る PATH にはまだ載っていないことがあるので既知の場所も見る
function findGh(cfg) {
  if (cfg.ghPath) return String(cfg.ghPath);
  try {
    execFileSync('gh', ['--version'], { stdio: 'ignore', windowsHide: true, timeout: 10000 });
    return 'gh';
  } catch {
    // PATH に無いだけなので、下の候補を探す
  }
  const candidates = [
    process.env.ProgramFiles && path.join(process.env.ProgramFiles, 'GitHub CLI', 'gh.exe'),
    process.env['ProgramFiles(x86)'] && path.join(process.env['ProgramFiles(x86)'], 'GitHub CLI', 'gh.exe'),
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs', 'GitHub CLI', 'gh.exe'),
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Microsoft', 'WinGet', 'Links', 'gh.exe'),
    '/usr/local/bin/gh',
    '/usr/bin/gh',
    '/opt/homebrew/bin/gh',
  ].filter(Boolean);
  return candidates.find((p) => fs.existsSync(p)) || null;
}

// gh のログイン済みトークンを借りる。OS のキーチェーンに預けたまま使えるので、
// config.json にトークンを平文で置かずに済む
let ghToken; // undefined=未取得 / null=取得できなかった
function getGhToken(cfg) {
  if (ghToken !== undefined) return ghToken;
  const bin = findGh(cfg);
  if (!bin) {
    ghToken = null;
    lib.log('gh CLI が見つかりません（config.json の ghPath で実行ファイルを指定できます）');
    return null;
  }
  try {
    ghToken = execFileSync(bin, ['auth', 'token'], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 15000,
    }).trim() || null;
  } catch {
    ghToken = null;
    lib.log('gh auth token に失敗しました（gh auth login が必要かもしれません）');
  }
  return ghToken;
}

// トークンの解決順。config.json の auth: "gh" なら gh のトークンを最優先にする。
// それ以外はリポジトリ別の指定 → 環境変数 → config の順で、最後に gh へ退避する
function resolveToken(cfg, repo) {
  const ghFirst = cfg.auth === 'gh';
  if (ghFirst) {
    const t = getGhToken(cfg);
    if (t) return t;
  }
  if (repo && cfg.tokens && cfg.tokens[repo]) return String(cfg.tokens[repo]).trim();
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN.trim();
  if (cfg.token) return String(cfg.token).trim();
  if (cfg.tokenFile) {
    try {
      return fs.readFileSync(cfg.tokenFile, 'utf8').trim();
    } catch {
      // ファイルが読めない場合は gh にフォールバックする
    }
  }
  return ghFirst ? null : getGhToken(cfg);
}

// リポジトリ内の CSV のパス。csvPaths でリポジトリごとに上書きできる
function resolveCsvPath(cfg, repo) {
  if (cfg.csvPaths && cfg.csvPaths[repo]) return String(cfg.csvPaths[repo]);
  return cfg.csvPath ? String(cfg.csvPath) : null;
}

async function api(token, method, path, body) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'claude-code-worklog-hook',
      'Content-Type': 'application/json',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT),
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) {
    const err = new Error(`${method} ${path} → ${res.status} ${(data && data.message) || text.slice(0, 200)}`);
    err.status = res.status;
    throw err;
  }
  return data;
}

function num(v) {
  const n = parseFloat(String(v ?? '').replace(/[^\d.-]/g, ''));
  return isNaN(n) ? 0 : n;
}

// ---------- CSV の組み立て ----------

// 区切り文字・引用符・改行を含むセルだけ引用符で囲む（RFC 4180）
function csvCell(v) {
  const s = String(v ?? '').replace(/\r?\n/g, ' ');
  return /[",]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function csvLine(values) {
  return values.map(csvCell).join(',');
}

// ISO文字列を JST の yyyymmdd にする（記録はUTC、CSVはJSTの日付）
function ymd(iso) {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  const j = new Date(d.getTime() + 9 * 3600 * 1000);
  const p = (n) => String(n).padStart(2, '0');
  return `${j.getUTCFullYear()}${p(j.getUTCMonth() + 1)}${p(j.getUTCDate())}`;
}

function buildLine(row, repo, user) {
  return csvLine([
    user,
    repo.split('/').pop(), // リポジトリごとの CSV なので owner は省く
    row.issue,
    ymd(row['開始']),
    ymd(row['終了']),
    row['タイトル'] || '(タイトル未生成)',
    num(row['③実作業h']).toFixed(2),
  ]);
}

// ---------- GitHub Contents API ----------

// 日本語ファイル名にも対応できるよう、パスはセグメントごとにエンコードする
function encodePath(p) {
  return p.split('/').filter(Boolean).map(encodeURIComponent).join('/');
}

// コミット先ブランチ。既定はリポジトリの既定ブランチではなく工数専用の "worklog"
function getBranch(cfg) {
  return cfg.csvBranch ? String(cfg.csvBranch) : 'worklog';
}

async function branchExists(token, repo, branch) {
  try {
    const ref = await api(token, 'GET', `/repos/${repo}/git/ref/heads/${branch}`);
    // 完全一致でない場合は候補の配列が返ることがある。その場合は「無い」とみなす
    return !Array.isArray(ref);
  } catch (e) {
    if (e.status === 404) return false;
    throw e;
  }
}

// 工数専用ブランチを新規に作る。親を持たない孤立ブランチなので、
// 既定ブランチのコードは一切含まれず、CSV 1ファイルだけが乗る
async function createOrphanBranch(token, repo, branch, path, text, message) {
  const blob = await api(token, 'POST', `/repos/${repo}/git/blobs`, {
    content: Buffer.from(text, 'utf8').toString('base64'),
    encoding: 'base64',
  });
  const tree = await api(token, 'POST', `/repos/${repo}/git/trees`, {
    tree: [{ path, mode: '100644', type: 'blob', sha: blob.sha }],
  });
  const commit = await api(token, 'POST', `/repos/${repo}/git/commits`, {
    message,
    tree: tree.sha,
    parents: [],
  });
  await api(token, 'POST', `/repos/${repo}/git/refs`, {
    ref: `refs/heads/${branch}`,
    sha: commit.sha,
  });
}

const userCache = new Map();
async function getUserName(token, cfg) {
  if (cfg.userName) return String(cfg.userName);
  if (userCache.has(token)) return userCache.get(token);
  const me = await api(token, 'GET', '/user');
  userCache.set(token, me.login || '');
  return me.login || '';
}

// CSV を取得する。存在しなければ text: null を返す（新規作成の合図）
async function readCsv(token, repo, path, branch) {
  try {
    const data = await api(
      token,
      'GET',
      `/repos/${repo}/contents/${encodePath(path)}?ref=${encodeURIComponent(branch)}`
    );
    if (Array.isArray(data)) throw new Error(`${path} はファイルではなくディレクトリです`);
    return {
      text: Buffer.from(data.content || '', data.encoding || 'base64').toString('utf8'),
      sha: data.sha,
    };
  } catch (e) {
    if (e.status === 404) return { text: null, sha: null };
    throw e;
  }
}

// 既存ファイルの改行コードを踏襲する（混在していれば CRLF 優先）
function detectEol(text) {
  return text && text.includes('\r\n') ? '\r\n' : '\n';
}

// 追記後の中身を作る。ヘッダ・改行コード・BOM は既存のものを壊さない
function appendLines(current, lines, cfg) {
  if (current === null) {
    // 新規作成。Excel で開いたときに文字化けしないよう既定で BOM を付ける
    const bom = cfg.csvBom === false ? '' : '﻿';
    const eol = cfg.csvEol === 'lf' ? '\n' : '\r\n';
    const head = cfg.csvHeader === false ? [] : [csvLine(HEADER)];
    return bom + [...head, ...lines].join(eol) + eol;
  }
  const eol = detectEol(current);
  let body = current;
  // 末尾に改行が無いファイルに追記すると最終行とつながってしまう
  if (body.length && !/\r?\n$/.test(body)) body += eol;
  // 空ファイルだけはヘッダを補う
  if (body.replace(/^﻿/, '').trim() === '' && cfg.csvHeader !== false) {
    body = (body.startsWith('﻿') ? '﻿' : '') + csvLine(HEADER) + eol;
  }
  return body + lines.join(eol) + eol;
}

async function putCsv(token, repo, path, branch, text, sha, message) {
  const body = {
    message,
    content: Buffer.from(text, 'utf8').toString('base64'),
    branch,
  };
  if (sha) body.sha = sha;
  return api(token, 'PUT', `/repos/${repo}/contents/${encodePath(path)}`, body);
}

// ---------- 本体 ----------

async function syncAll() {
  const cfg = lib.readConfig();
  if (!cfg) {
    lib.log('config.json が読めないため同期をスキップ');
    return;
  }

  const md = lib.paths().mdFile;
  const { rows } = lib.readTable(md);

  const pending = rows.filter((r) => r.issue && !r['同期'] && lib.rowRepo(r, cfg));
  if (pending.length === 0) return;

  // 同じリポジトリ宛はまとめて1コミットにする（API 呼び出しとコミット数を減らす）
  const byRepo = new Map();
  for (const r of pending) {
    const repo = lib.rowRepo(r, cfg);
    if (!byRepo.has(repo)) byRepo.set(repo, []);
    byRepo.get(repo).push(r);
  }

  for (const [repo, group] of byRepo) {
    const token = resolveToken(cfg, repo);
    if (!token) {
      lib.log(
        `${repo} トークンを解決できないためスキップ（gh auth login、GITHUB_TOKEN 環境変数、または config.json の token/tokenFile/tokens）`
      );
      continue;
    }
    const path = resolveCsvPath(cfg, repo);
    if (!path) {
      lib.log(`${repo} CSV のパスが未設定のためスキップ（config.json の csvPath / csvPaths）`);
      continue;
    }

    try {
      const branch = getBranch(cfg);
      const user = await getUserName(token, cfg);
      const lines = group.map((r) => buildLine(r, repo, user));
      const label = group.length === 1 ? `#${group[0].issue}` : `${group.length}件`;
      const message = `[worklog] 作業記録を追加: ${label}`;

      if (!(await branchExists(token, repo, branch))) {
        // 初回。ブランチごと作り、ヘッダと今回の行を最初のコミットに含める
        await createOrphanBranch(
          token,
          repo,
          branch,
          path,
          appendLines(null, lines, cfg),
          `[worklog] 工数記録用ブランチを作成`
        );
        lib.log(`${repo} に ${branch} ブランチを作成（${path} を新規作成）`);
      } else {
        // 他の人が同じ CSV を更新していると sha 不一致で弾かれるので、読み直して1度だけやり直す
        let written = false;
        for (let attempt = 0; attempt < 2 && !written; attempt++) {
          const cur = await readCsv(token, repo, path, branch);
          try {
            await putCsv(token, repo, path, branch, appendLines(cur.text, lines, cfg), cur.sha, message);
            written = true;
          } catch (e) {
            if ((e.status === 409 || e.status === 422) && attempt === 0) {
              lib.log(`${repo}/${path} 競合を検出。読み直して再試行します`);
              continue;
            }
            throw e;
          }
        }
      }

      for (const r of group) r['同期'] = '済';
      lib.writeTable(md, rows);
      lib.log(
        `${repo} [${branch}] ${path} へ ${group.length}行: ${group.map((r) => `#${r.issue}(${r['③実作業h']}h)`).join(' ')}`
      );
    } catch (e) {
      lib.log(`${repo}/${path} への書き込みに失敗（次回リトライ）: ${String(e.message).trim()}`);
    }
  }
}

module.exports = {
  syncAll,
  findGh,
  getGhToken,
  getBranch,
  branchExists,
  createOrphanBranch,
  HEADER,
  csvLine,
  csvCell,
  ymd,
  buildLine,
  appendLines,
  detectEol,
  resolveCsvPath,
  resolveToken,
  api,
};

if (require.main === module) {
  // hook から呼ばれる場合も含め、ここで例外を外に出さない（セッションを妨げない）
  syncAll().catch((e) => {
    lib.log(`CSV 同期処理が異常終了: ${String(e.message).trim()}`);
  });
}

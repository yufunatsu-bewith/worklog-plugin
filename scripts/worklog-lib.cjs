#!/usr/bin/env node
// worklog.md (Markdownテーブル) の読み書きと、列スキーマの移行を担う共通モジュール。
// worklog-end.cjs（行の追記）と worklog-issue-sync.cjs（GitHub Issue への同期）の両方から使う。
const fs = require('fs');
const path = require('path');
const os = require('os');

// 列の定義と表示順。既存ファイルの列構成がこれと違う場合、
// readTable が列名でマッピングし writeTable がこの順で書き戻すため自動で移行される。
const COLUMNS = [
  '日付',
  'session_id',
  '開始',
  '終了',
  '経過分',
  '実作業分',
  '作業ディレクトリ',
  'タイトル',
  'repo',
  'issue',
  '①AIなし想定h',
  '②AIあり見込みh',
  '③実作業h',
  '④用途振り返り',
  '同期',
];

function paths() {
  const dir = path.join(os.homedir(), '.claude', 'worklog');
  return {
    dir,
    mdFile: path.join(dir, 'worklog.md'),
    stateDir: path.join(dir, 'state'),
    configFile: path.join(dir, 'config.json'),
    logFile: path.join(dir, 'issue-sync.log'),
  };
}

function readConfig() {
  try {
    return JSON.parse(fs.readFileSync(paths().configFile, 'utf8'));
  } catch {
    return null;
  }
}

// 同期処理は hook から静かに動くため、標準出力ではなくファイルに記録する
// （SessionStart / UserPromptSubmit の stdout はモデルのコンテキストに注入されるので汚さない）
function log(msg) {
  const p = paths();
  try {
    fs.mkdirSync(p.dir, { recursive: true });
    fs.appendFileSync(p.logFile, `[${new Date().toISOString()}] ${msg}\n`, 'utf8');
  } catch {
    // ログが書けなくても本処理は止めない
  }
}

const BS = String.fromCharCode(92); // バックスラッシュ

function mdField(v) {
  return String(v ?? '')
    .replace(/\|/g, BS + '|')
    .replace(/\n/g, ' ');
}

function unmdField(v) {
  return v.split(BS + '|').join('|').trim();
}

// エスケープされた \| はセル区切りとして扱わない
const CELL_SPLIT = new RegExp('(?<!' + BS + BS + ')' + BS + '|');

function splitRow(line) {
  const t = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  return t.split(CELL_SPLIT).map(unmdField);
}

function isSeparator(line) {
  const t = line.trim();
  return /^[|\s:-]+$/.test(t) && t.includes('-');
}

// worklog.md を行オブジェクトの配列として読む。列は「その時のヘッダ名」で引く
function readTable(file) {
  if (!fs.existsSync(file)) return { rows: [] };
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
  let header = null;
  const rows = [];
  for (const line of lines) {
    if (!line.trim().startsWith('|')) continue;
    if (!header) {
      header = splitRow(line);
      continue;
    }
    if (isSeparator(line)) continue;
    const cells = splitRow(line);
    const row = {};
    header.forEach((h, i) => {
      row[h] = cells[i] ?? '';
    });
    rows.push(row);
  }
  return { rows };
}

function formatTable(rows) {
  const head =
    `| ${COLUMNS.join(' | ')} |\n` +
    `| ${COLUMNS.map(() => '---').join(' | ')} |\n`;
  const body = rows
    .map((r) => `| ${COLUMNS.map((c) => mdField(r[c])).join(' | ')} |\n`)
    .join('');
  return head + body;
}

// 一時ファイル経由で書き換える。途中で落ちても worklog.md が壊れないようにする
function writeTable(file, rows) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, formatTable(rows), 'utf8');
  fs.renameSync(tmp, file);
}

function appendRow(file, row) {
  appendRows(file, [row]);
}

// 1セッションが複数 issue にまたがる場合、区間ごとの複数行を一度に追記する
function appendRows(file, newRows) {
  if (!newRows.length) return;
  const { rows } = readTable(file);
  rows.push(...newRows);
  writeTable(file, rows);
}

// 行がどのリポジトリの issue を指すかを解決する。
// repo 列が空の行（この列を追加する前に記録された行）は既定リポジトリの issue とみなす
function rowRepo(row, cfg) {
  return String(row['repo'] || (cfg && cfg.repo) || '');
}

// 「リポジトリ + 番号」で issue を一意に表す。集計・比較のキーはすべてこれを使う
function issueKey(repo, issue) {
  return `${repo}#${issue}`;
}

// ---------- 無操作時間の除外 ----------
// 操作が途切れた時間を工数に含めないため、セッション中の「活動していた区間」を state に持つ。
// 活動の記録元は UserPromptSubmit（利用者の入力）と Stop（Claude の応答完了）の2つ。

// 無操作とみなすまでの時間。config.json の idleMinutes で変更できる（既定15分）
function idleMs(cfg) {
  const m = Number(cfg && cfg.idleMinutes);
  return (Number.isFinite(m) && m > 0 ? m : 15) * 60000;
}

// 活動時刻を記録する。前回の活動から idle を超えていれば、そこで区間を切って新しく始める。
// force=true（Claude の応答完了）のときは、間が空いていても作業していたとみなして延長する
function touchActivity(state, iso, cfg, force) {
  if (!Array.isArray(state.active)) state.active = [];
  const t = new Date(iso).getTime();
  if (isNaN(t)) return state;
  const last = state.active[state.active.length - 1];
  if (last && (force || t - new Date(last.to).getTime() <= idleMs(cfg))) {
    if (t > new Date(last.to).getTime()) last.to = new Date(t).toISOString();
  } else {
    const at = new Date(t).toISOString();
    state.active.push({ from: at, to: at });
  }
  return state;
}

// 区間 [from, to] のうち活動していた時間を分で返す。
// 活動の記録が無い場合は null（判断材料が無いので、呼び出し側で経過時間をそのまま使う）
function activeMinutes(active, from, to) {
  if (!Array.isArray(active) || active.length === 0) return null;
  let ms = 0;
  for (const iv of active) {
    const a = Math.max(new Date(iv.from).getTime(), from.getTime());
    const b = Math.min(new Date(iv.to).getTime(), to.getTime());
    if (b > a) ms += b - a;
  }
  return Math.round(ms / 60000);
}

// ISO文字列を JST の "YYYY-MM-DD HH:mm" にする（記録はUTC、表示はJST）
function jst(iso) {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return String(iso ?? '');
  const j = new Date(d.getTime() + 9 * 3600 * 1000);
  const p = (n) => String(n).padStart(2, '0');
  return `${j.getUTCFullYear()}-${p(j.getUTCMonth() + 1)}-${p(j.getUTCDate())} ${p(j.getUTCHours())}:${p(j.getUTCMinutes())}`;
}

module.exports = {
  COLUMNS,
  paths,
  readConfig,
  log,
  mdField,
  readTable,
  writeTable,
  appendRow,
  appendRows,
  rowRepo,
  issueKey,
  idleMs,
  touchActivity,
  activeMinutes,
  formatTable,
  jst,
};

#!/usr/bin/env node
// SessionEnd hook: 開始時刻との差分を計算し worklog.md に追記する
// ①想定工数(AIなし)・②見込み工数(AIあり)・④用途振り返り は空欄のまま残す（自動で埋めない）
// タイトルは transcript から人間の発言を抽出し、claude CLI (headless) で自動要約する
// repo / issue 列は worklog-issue-link.cjs が state に記録した紐づけを転記する。
// セッション中に issue を切り替えた場合は、切り替え時刻で区切った区間ごとに1行ずつ記録する
// （＝1セッションから複数行が出る）。埋まっていればこの直後に対象リポジトリの CSV へ同期する
//
// /worklog コマンドからも同じ処理を呼ぶ（node worklog-end.cjs --session <id>）。
// その場合はそこまでの時間を記録したあと state を作り直し、セッションを続けられるようにする。
// 記録済みの時点は state.flushedAt に残し、あとの /exit で同じ時間が二重に記録されないようにする
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');
const lib = require('./worklog-lib.cjs');

// タイトル生成のために起動する `claude -p` の子セッションでも hook は発火する。
// そのままだと SessionEnd が再帰的に自分を呼び出し続けるため、子側では即座に何もせず終了する。
if (process.env.CLAUDE_WORKLOG_DISABLE === '1') {
  process.exit(0);
}

// transcript(JSONL)から人間が入力したメッセージ本文だけを抽出する
function extractHumanMessages(transcriptPath) {
  let raw;
  try {
    raw = fs.readFileSync(transcriptPath, 'utf8');
  } catch {
    return [];
  }
  const messages = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    // message.content が string の user 行が、人間が実際にタイプした発言
    // （tool_result はここでは array content になるため自然に除外される）
    if (obj.type === 'user' && typeof obj.message?.content === 'string') {
      // スラッシュコマンドの展開結果（/worklog など）は作業内容ではないので要約に含めない
      if (/^\s*<(command-|local-command)/.test(obj.message.content)) continue;
      messages.push(obj.message.content);
    }
  }
  return messages;
}

// /worklog から呼ばれたときは hook の入力が無いので、session_id から transcript を探す
function findTranscript(sessionId) {
  const dir = path.join(os.homedir(), '.claude', 'projects');
  try {
    for (const d of fs.readdirSync(dir)) {
      const f = path.join(dir, d, `${sessionId}.jsonl`);
      if (fs.existsSync(f)) return f;
    }
  } catch {
    // 見つからなければタイトル無しで記録する
  }
  return '';
}

// claude CLI をheadlessモードで呼び出し、セッション内容から短いタイトルを生成する
// 失敗・タイムアウト時は空文字を返す（記録自体は止めない）
// skip 件目より前の発言は、前回の /worklog で要約済みなので使わない
function generateTitle(messages, skip) {
  messages = messages.slice(skip || 0);
  if (messages.length === 0) return '';

  let transcriptText = messages.join('\n---\n');
  const MAX_CHARS = 8000;
  if (transcriptText.length > MAX_CHARS) {
    transcriptText = transcriptText.slice(0, MAX_CHARS) + '\n…(以下省略)';
  }

  // 指示と要約対象を1つのプロンプトにまとめる。
  // stdin経由で内容を渡すと、モデルがそれを新しい質問として扱ってしまい
  // 要約ではなく回答を返してしまう場合があったため避けている。
  const prompt = [
    '以下は<transcript>タグ内にある、あるチャットセッションでユーザーが入力した発言の一覧です。',
    'この内容だけを読んで、セッションで行われた作業内容を要約し、15〜25文字程度の日本語の体言止めタイトルを1行だけ出力してください。',
    '前置き・説明・記号・引用符・見出しは一切不要です。タイトルの文字列そのものだけを出力してください。',
    '<transcript>',
    transcriptText,
    '</transcript>',
  ].join('\n');

  try {
    const result = execFileSync(
      'claude',
      [
        '-p',
        prompt,
        '--model',
        'claude-haiku-4-5-20251001',
        // 子セッションで hook を動かさない（SessionEnd の無限再帰を防ぐ）
        '--settings',
        '{"disableAllHooks":true}',
        // MCPサーバの起動を省略して待ち時間を短縮する
        '--strict-mcp-config',
      ],
      {
        encoding: 'utf8',
        // CLI の起動に十分な余裕を取る（30秒では足りずタイトルが空欄になる）
        timeout: 90000,
        windowsHide: true,
        // --settings が効かない場合の保険。子側のスクリプトが自分で早期終了する
        env: { ...process.env, CLAUDE_WORKLOG_DISABLE: '1' },
      }
    );
    return result.trim().split('\n')[0].slice(0, 60);
  } catch {
    return '';
  }
}

// セッションのここまでの時間を worklog.md に記録し、CSV へ同期する。
// keep=true（/worklog）のときは state を消さずに作り直し、続きを新しい区間として計測する
async function record({ sessionId, transcriptPath, cwd: cwdIn, keep }) {
  const p = lib.paths();
  const stateFile = path.join(p.stateDir, `${sessionId}.json`);

  fs.mkdirSync(p.dir, { recursive: true });

  const end = new Date();
  let start = end;
  let cwd = cwdIn || '';
  // セッション中に紐づけられた issue の区間一覧（worklog-issue-link.cjs が記録する）
  let segments = [];
  let active = null; // 活動していた区間（無操作の時間を除くために使う）
  let state = null;

  if (fs.existsSync(stateFile)) {
    try {
      state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
      start = new Date(state.start);
      cwd = state.cwd || cwd;
      // 終了操作も活動とみなす。直前の活動から15分以内なら、そこまでを作業時間に含める
      lib.touchActivity(state, end.toISOString(), lib.readConfig() || {}, false);
      active = state.active || null;
      if (Array.isArray(state.segments) && state.segments.length) {
        segments = state.segments;
      } else if (state.issue) {
        // 旧形式の state（issue 1件のみ）はセッション全体を1区間として扱う
        segments = [{ from: state.start, repo: state.repo || '', issue: state.issue }];
      }
    } catch {
      // 読めなければ差分0・issue紐づけなしとして記録する
      state = null;
    }
  }

  // 区間の境界を実時刻に落とす。
  // 先頭区間はセッション開始まで遡り、最終区間はセッション終了まで伸ばす
  const spans = (segments.length
    ? segments.map((s, i) => ({
        repo: s.repo || '',
        issue: s.issue || '',
        from: i === 0 ? start : new Date(s.from),
        to: i + 1 < segments.length ? new Date(segments[i + 1].from) : end,
      }))
    : [{ repo: '', issue: '', from: start, to: end }]
  ).map((sp) => {
    // 経過時間と、そこから無操作の時間を除いた実作業時間
    const raw = Math.max(0, Math.round((sp.to - sp.from) / 60000));
    const act = lib.activeMinutes(active, sp.from, sp.to);
    return { ...sp, raw, min: act === null ? raw : Math.min(act, raw) };
  });

  // 切り替え直後にまた切り替えたような 0 分の区間は記録しない。
  // 全部 0 分になる短いセッションでは、最後に指定された issue の1行だけを残す。
  // ただし /worklog で記録した直後で、その後に作業が無い場合は何も残さない（二重記録の防止）
  let kept = spans.filter((sp) => sp.min > 0);
  if (kept.length === 0) kept = state && state.flushedAt ? [] : [spans[spans.length - 1]];

  const messages = transcriptPath ? extractHumanMessages(transcriptPath) : [];
  const title = kept.length ? generateTitle(messages, state && state.titleFrom) : '';

  const newRows = kept.map((sp) => ({
    日付: sp.to.toISOString().slice(0, 10),
    session_id: sessionId,
    開始: sp.from.toISOString(),
    終了: sp.to.toISOString(),
    経過分: sp.raw,
    実作業分: sp.min,
    作業ディレクトリ: cwd,
    タイトル: title,
    repo: sp.issue ? sp.repo : '',
    issue: sp.issue,
    '①AIなし想定h': '',
    '②AIあり見込みh': '',
    '③実作業h': (sp.min / 60).toFixed(2),
    '④用途振り返り': '',
    同期: '',
  }));
  lib.appendRows(p.mdFile, newRows);

  const idle = kept.reduce((t, sp) => t + (sp.raw - sp.min), 0);
  if (idle > 0) {
    lib.log(
      `${sessionId} 無操作 ${idle}分を除外（経過 ${kept.reduce((t, sp) => t + sp.raw, 0)}分 → 実作業 ${kept.reduce((t, sp) => t + sp.min, 0)}分）`
    );
  }

  if (keep && state) {
    // 続きは今の時刻から計測し直す。記録先の issue はそのまま引き継ぐ
    const now = end.toISOString();
    const last = segments[segments.length - 1];
    const next = {
      start: now,
      cwd,
      active: [{ from: now, to: now }],
      segments: last ? [{ from: now, repo: last.repo || '', issue: last.issue }] : [],
      flushedAt: now,
      titleFrom: messages.length,
    };
    if (last) {
      next.issue = last.issue;
      next.repo = last.repo || '';
    }
    fs.writeFileSync(stateFile, JSON.stringify(next), 'utf8');
  } else if (fs.existsSync(stateFile)) {
    fs.unlinkSync(stateFile);
  }

  // issue に紐づいている行があればここで CSV へ書き出す。
  // 失敗しても worklog.md への記録は済んでいるので、次回セッション開始時にリトライされる
  try {
    await require('./worklog-csv-sync.cjs').syncAll();
  } catch (e) {
    lib.log(`工数記録からの同期呼び出しが失敗: ${String(e.message).trim()}`);
  }

  return newRows;
}

// /worklog から呼ばれたときの結果表示。Claude がこの出力をそのまま利用者に伝える
function report(rows) {
  if (!rows.length) {
    console.log('前回の記録以降に作業時間が無いため、記録する行はありませんでした。');
    return;
  }
  const { rows: all } = lib.readTable(lib.paths().mdFile);
  for (const r of rows) {
    const saved = all.find((a) => a.session_id === r.session_id && a['開始'] === r['開始']) || r;
    const target = r.issue ? `${r.repo}#${r.issue}` : 'Issue 未指定';
    const sync = !r.issue
      ? 'CSV へは送っていません（Issue 番号を書くと次から記録されます）'
      : saved['同期'] === '済'
        ? 'CSV に追記しました'
        : 'CSV への書き込みに失敗。次回のセッション開始時に再送します（~/.claude/worklog/issue-sync.log 参照）';
    console.log(`- ${target}: 実作業 ${r['実作業分']}分（経過 ${r['経過分']}分）「${r['タイトル'] || 'タイトル無し'}」 → ${sync}`);
  }
  console.log('このセッションは続けて計測しています。続きは /exit か次の /worklog で記録されます。');
}

const argIdx = process.argv.indexOf('--session');
if (argIdx !== -1) {
  // /worklog コマンドから: node worklog-end.cjs --session <id>
  const sessionId = process.argv[argIdx + 1] || '';
  const stateFile = path.join(lib.paths().stateDir, `${sessionId}.json`);
  if (!/^[\w-]+$/.test(sessionId) || !fs.existsSync(stateFile)) {
    console.log(`このセッション（${sessionId || 'ID 不明'}）の計測データが見つからないため、記録しませんでした。`);
    process.exit(0);
  }
  record({ sessionId, transcriptPath: findTranscript(sessionId), cwd: '', keep: true })
    .then(report)
    .catch((e) => console.log(`記録に失敗しました: ${String(e.message).trim()}`));
} else {
  // SessionEnd hook から（/exit）
  let input = '';
  process.stdin.on('data', (d) => (input += d));
  process.stdin.on('end', () => {
    let data = {};
    try {
      data = JSON.parse(input || '{}');
    } catch {
      data = {};
    }
    record({
      sessionId: data.session_id || 'unknown',
      transcriptPath: data.transcript_path,
      cwd: data.cwd || '',
      keep: false,
    }).catch((e) => lib.log(`SessionEnd の記録処理が失敗: ${String(e.message).trim()}`));
  });
}

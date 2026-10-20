#!/usr/bin/env node
// Stop hook: Claude の応答が終わった時刻を「活動していた時刻」として記録する。
//
// 利用者の入力（UserPromptSubmit）だけを見ていると、Claude が長時間ツールを動かしている間が
// 無操作に見えてしまう。そこで応答完了時にも記録し、しかも「入力 → 応答完了」の間は
// 15分を超えていても作業時間として扱う（force）。
//
// stdout には何も出さない。
const fs = require('fs');
const path = require('path');
const lib = require('./worklog-lib.cjs');

// タイトル生成用の `claude -p` 子セッション側では動かさない
if (process.env.CLAUDE_WORKLOG_DISABLE === '1') {
  process.exit(0);
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

  const sessionId = data.session_id || 'unknown';
  const p = lib.paths();
  const stateFile = path.join(p.stateDir, `${sessionId}.json`);

  let state;
  try {
    state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  } catch {
    // SessionStart が動いていないセッションでは何もしない（開始時刻が分からないため）
    process.exit(0);
  }

  // 直前の入力から応答完了までは、間隔によらず作業していた時間として繋ぐ
  lib.touchActivity(state, new Date().toISOString(), lib.readConfig() || {}, true);

  try {
    fs.writeFileSync(stateFile, JSON.stringify(state), 'utf8');
  } catch {
    // 書けなくてもセッションは妨げない
  }
});

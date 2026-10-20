#!/usr/bin/env node
// SessionStart hook: セッション開始時刻を session_id ごとに記録する
const fs = require('fs');
const path = require('path');
const os = require('os');

// タイトル生成のために起動する `claude -p` の子セッションでも hook は発火する。
// そのままだと SessionEnd が再帰的に自分を呼び出し続けるため、子側では即座に何もせず終了する。
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
    data = {};
  }

  const sessionId = data.session_id || 'unknown';
  const cwd = data.cwd || process.cwd();

  const stateDir = path.join(os.homedir(), '.claude', 'worklog', 'state');
  fs.mkdirSync(stateDir, { recursive: true });

  const stateFile = path.join(stateDir, `${sessionId}.json`);
  const start = new Date().toISOString();
  fs.writeFileSync(
    stateFile,
    // active は「活動していた区間」。無操作の時間を工数から除くために使う
    JSON.stringify({ start, cwd, active: [{ from: start, to: start }] }),
    'utf8'
  );
});

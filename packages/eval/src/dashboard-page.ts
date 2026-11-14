export const DASHBOARD_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Coro eval</title>
  <style>
    :root {
      color-scheme: light;
      --bg: #f6f7f9;
      --panel: #ffffff;
      --text: #172033;
      --muted: #687386;
      --line: #e4e7ec;
      --accent: #5b5bd6;
      --accent-soft: #efefff;
      --good: #16845b;
      --good-soft: #e8f7f0;
      --bad: #c03636;
      --bad-soft: #fcecec;
      --warn: #a46109;
      --warn-soft: #fff4db;
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    * { box-sizing: border-box; }
    body { margin: 0; background: var(--bg); color: var(--text); }
    button { font: inherit; }
    .shell { min-height: 100vh; display: grid; grid-template-columns: 260px minmax(0, 1fr); }
    aside {
      background: #111827;
      color: #f9fafb;
      padding: 24px 16px;
      min-height: 100vh;
    }
    .brand { padding: 0 8px 22px; font-size: 18px; font-weight: 750; letter-spacing: -.02em; }
    .brand span { color: #a5b4fc; }
    .eyebrow { color: #8f9bb0; font-size: 11px; font-weight: 700; letter-spacing: .12em; text-transform: uppercase; }
    .run-list { display: grid; gap: 6px; margin-top: 10px; }
    .run-link {
      width: 100%;
      border: 0;
      border-radius: 9px;
      background: transparent;
      color: #d1d5db;
      cursor: pointer;
      padding: 10px;
      text-align: left;
    }
    .run-link:hover, .run-link.active { background: #242f43; color: #fff; }
    .run-link strong, .run-link small { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .run-link strong { font-size: 13px; }
    .run-link small { color: #95a0b3; font-size: 11px; margin-top: 4px; }
    main { min-width: 0; padding: 34px clamp(20px, 4vw, 56px) 64px; }
    .topbar { display: flex; align-items: flex-start; justify-content: space-between; gap: 20px; margin-bottom: 24px; }
    h1 { font-size: clamp(25px, 3vw, 34px); line-height: 1.1; letter-spacing: -.035em; margin: 4px 0 7px; }
    h2 { font-size: 16px; margin: 0; }
    h3 { font-size: 14px; margin: 0; }
    p { color: var(--muted); margin: 0; }
    .meta { font-size: 13px; }
    .pill {
      display: inline-flex;
      align-items: center;
      border-radius: 999px;
      font-size: 11px;
      font-weight: 700;
      padding: 4px 8px;
      white-space: nowrap;
    }
    .pill.good { color: var(--good); background: var(--good-soft); }
    .pill.bad { color: var(--bad); background: var(--bad-soft); }
    .pill.warn { color: var(--warn); background: var(--warn-soft); }
    .pill.neutral { color: #596579; background: #eef0f4; }
    .cards { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; margin-bottom: 22px; }
    .card, .panel {
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 12px;
      box-shadow: 0 1px 2px rgba(16, 24, 40, .03);
    }
    .card { padding: 17px; }
    .card .label { color: var(--muted); font-size: 12px; }
    .card .value { font-size: 23px; font-weight: 750; letter-spacing: -.03em; margin-top: 7px; }
    .panel { overflow: hidden; margin-top: 14px; }
    .panel-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 16px 18px; border-bottom: 1px solid var(--line); }
    .table-wrap { overflow-x: auto; }
    table { width: 100%; border-collapse: collapse; font-size: 13px; }
    th { color: var(--muted); font-size: 11px; font-weight: 700; letter-spacing: .04em; text-align: left; text-transform: uppercase; }
    th, td { padding: 12px 18px; border-bottom: 1px solid var(--line); white-space: nowrap; }
    tbody tr:last-child td { border-bottom: 0; }
    tbody tr.clickable { cursor: pointer; }
    tbody tr.clickable:hover { background: #fafaff; }
    .empty, .loading { padding: 48px 20px; text-align: center; color: var(--muted); }
    .back {
      border: 0;
      background: transparent;
      color: var(--accent);
      cursor: pointer;
      font-weight: 650;
      padding: 0;
      margin-bottom: 20px;
    }
    .detail-grid { display: grid; grid-template-columns: minmax(0, 1.5fr) minmax(260px, .7fr); gap: 14px; }
    .stack { display: grid; gap: 14px; align-content: start; }
    .result { padding: 18px; }
    .result + .result { border-top: 1px solid var(--line); }
    .result-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 9px; }
    .command { color: var(--muted); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; overflow-wrap: anywhere; }
    pre {
      background: #111827;
      border-radius: 8px;
      color: #d6deeb;
      font: 11px/1.55 ui-monospace, SFMono-Regular, Menlo, monospace;
      margin: 12px 0 0;
      max-height: 360px;
      overflow: auto;
      padding: 14px;
      white-space: pre-wrap;
      word-break: break-word;
    }
    .facts { display: grid; gap: 11px; padding: 17px 18px; }
    .fact { display: flex; justify-content: space-between; gap: 14px; font-size: 13px; }
    .fact span:first-child { color: var(--muted); }
    .reason { color: var(--text); font-size: 14px; line-height: 1.55; padding: 17px 18px; }
    .timeline { list-style: none; margin: 0; padding: 12px 18px 18px; }
    .timeline li { border-left: 2px solid #d9ddea; padding: 4px 0 13px 14px; font-size: 12px; }
    .timeline li:last-child { padding-bottom: 4px; }
    .timeline small { color: var(--muted); display: block; margin-top: 3px; }
    .error { background: var(--bad-soft); border: 1px solid #f5caca; border-radius: 10px; color: var(--bad); padding: 14px; }
    @media (max-width: 900px) {
      .shell { grid-template-columns: 1fr; }
      aside { min-height: auto; padding: 16px; }
      .brand { padding-bottom: 10px; }
      .run-list { display: flex; overflow-x: auto; }
      .run-link { min-width: 190px; }
      .cards { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .detail-grid { grid-template-columns: 1fr; }
    }
    @media (max-width: 520px) {
      main { padding: 24px 14px 44px; }
      .cards { grid-template-columns: 1fr 1fr; }
      th, td { padding: 11px 13px; }
    }
  </style>
</head>
<body>
  <div class="shell">
    <aside>
      <div class="brand"><span>coro</span> eval</div>
      <div class="eyebrow">Runs</div>
      <div id="runs" class="run-list"><div class="loading">Loading…</div></div>
    </aside>
    <main id="view"><div class="loading">Loading results…</div></main>
  </div>
  <script>
    const state = { runs: [], runId: null };
    const $ = selector => document.querySelector(selector);
    const e = value => String(value ?? '')
      .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;').replaceAll("'", '&#039;');
    const pct = value => Math.round((value || 0) * 100) + '%';
    const usd = value => '$' + Number(value || 0).toFixed(Number(value || 0) < 1 ? 3 : 2);
    const duration = value => {
      const seconds = Math.round(Number(value || 0) / 1000);
      if (seconds < 60) return seconds + 's';
      const minutes = Math.floor(seconds / 60);
      if (minutes < 60) return minutes + 'm ' + String(seconds % 60).padStart(2, '0') + 's';
      return Math.floor(minutes / 60) + 'h ' + String(minutes % 60).padStart(2, '0') + 'm';
    };
    const date = value => value ? new Date(value).toLocaleString() : 'In progress';
    const status = (text, ok) => '<span class="pill ' + (ok === true ? 'good' : ok === false ? 'bad' : 'neutral') + '">' + e(text) + '</span>';

    async function get(url) {
      const response = await fetch(url);
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || 'Request failed');
      return body;
    }

    function setLocation(params) {
      const url = new URL(location.href);
      url.search = '';
      Object.entries(params).forEach(([key, value]) => value != null && url.searchParams.set(key, value));
      history.pushState({}, '', url);
    }

    function renderRunList() {
      $('#runs').innerHTML = state.runs.length ? state.runs.map(run =>
        '<button class="run-link ' + (run.runId === state.runId ? 'active' : '') + '" data-run="' + e(run.runId) + '">' +
          '<strong>' + e(run.label || run.runId) + '</strong>' +
          '<small>' + e(date(run.startedAt)) + ' · ' + pct(run.overall.solveRate) + ' solved</small>' +
        '</button>'
      ).join('') : '<div class="empty">No eval runs yet.</div>';
      document.querySelectorAll('[data-run]').forEach(button => button.addEventListener('click', () => openRun(button.dataset.run)));
    }

    function card(label, value) {
      return '<div class="card"><div class="label">' + e(label) + '</div><div class="value">' + e(value) + '</div></div>';
    }

    async function openRun(runId, updateUrl = true) {
      state.runId = runId;
      renderRunList();
      $('#view').innerHTML = '<div class="loading">Loading run…</div>';
      try {
        const run = await get('/api/runs/' + encodeURIComponent(runId));
        const o = run.summary.overall;
        document.title = (run.info.label || run.info.runId) + ' · Coro eval';
        $('#view').innerHTML =
          '<div class="topbar"><div><div class="eyebrow">Eval run</div><h1>' + e(run.info.label || run.info.runId) + '</h1>' +
            '<p class="meta">' + e(date(run.info.startedAt)) + ' · ' + e(run.info.scenario.lane) + ' lane · ' + e(run.info.scenarioHash) + '</p></div>' +
            status(run.info.finishedAt ? 'Finished' : 'In progress', run.info.finishedAt ? true : null) + '</div>' +
          '<section class="cards">' +
            card('Solve rate', pct(o.solveRate)) +
            card('Solved', o.solved + ' / ' + o.attempts) +
            card('Total cost', usd(o.totalCostUsd)) +
            card('Median wall time', duration(o.medianWallMs)) +
          '</section>' +
          '<section class="panel"><div class="panel-head"><h2>Tasks</h2><span class="meta">' + o.tasks + ' total</span></div>' +
            '<div class="table-wrap"><table><thead><tr><th>Task</th><th>Solved</th><th>Pass@k</th><th>Pass^k</th><th>Median cost</th><th>Median time</th><th>Outcome</th></tr></thead><tbody>' +
              run.summary.tasks.map(task => '<tr><td><strong>' + e(task.taskId) + '</strong></td><td>' + e(task.solved + '/' + task.attempts) + '</td>' +
                '<td>' + status(task.passAtK ? 'Pass' : 'Fail', task.passAtK) + '</td><td>' + status(task.passPowK ? 'Pass' : 'Fail', task.passPowK) + '</td>' +
                '<td>' + e(usd(task.medianCostUsd)) + '</td><td>' + e(duration(task.medianWallMs)) + '</td><td>' + e(Object.entries(task.outcomes).map(([key, n]) => n + ' ' + key).join(', ')) + '</td></tr>').join('') +
            '</tbody></table></div></section>' +
          '<section class="panel"><div class="panel-head"><h2>Attempts</h2><span class="meta">Open one to inspect test results</span></div>' +
            '<div class="table-wrap"><table><thead><tr><th>Task</th><th>Attempt</th><th>Result</th><th>Outcome</th><th>Cost</th><th>Wall time</th><th>Rework</th></tr></thead><tbody>' +
              (run.attempts.length ? run.attempts.map(item => '<tr class="clickable" data-task="' + e(item.taskId) + '" data-attempt="' + e(item.attempt) + '">' +
                '<td><strong>' + e(item.taskId) + '</strong></td><td>#' + e(item.attempt) + '</td><td>' + status(item.solved ? 'Solved' : 'Failed', item.solved) + '</td>' +
                '<td>' + e(item.outcome) + '</td><td>' + e(usd(item.costUsd)) + '</td><td>' + e(duration(item.wallMs)) + '</td><td>' + e(item.reworkRuns) + '</td></tr>').join('') :
                '<tr><td colspan="7" class="empty">No completed attempts yet.</td></tr>') +
            '</tbody></table></div></section>';
        document.querySelectorAll('[data-task]').forEach(row => row.addEventListener('click', () => openAttempt(runId, row.dataset.task, row.dataset.attempt)));
        if (updateUrl) setLocation({ run: runId });
      } catch (error) {
        showError(error);
      }
    }

    function testResult(title, result) {
      if (!result) return '';
      const ok = result.passed !== undefined ? result.passed : result.exitCode === 0 && !result.timedOut;
      const count = result.counts ? result.counts.passed + '/' + result.counts.total + ' passed' : (result.timedOut ? 'Timed out' : 'Exit ' + result.exitCode);
      return '<div class="result"><div class="result-head"><h3>' + e(title) + '</h3>' + status(ok ? 'Passed' : 'Failed', ok) + '</div>' +
        '<div class="command">' + e(result.command) + ' · ' + e(count) + ' · ' + e(duration(result.durationMs)) + '</div>' +
        (result.outputTail ? '<pre>' + e(result.outputTail) + '</pre>' : '') + '</div>';
    }

    async function openAttempt(runId, taskId, attempt, updateUrl = true) {
      $('#view').innerHTML = '<div class="loading">Loading attempt…</div>';
      try {
        const data = await get('/api/runs/' + encodeURIComponent(runId) + '/attempts/' + encodeURIComponent(taskId) + '/' + encodeURIComponent(attempt));
        const grade = data.grade || {};
        const tests = grade.tests;
        const checks = tests?.checks || [];
        document.title = taskId + ' #' + attempt + ' · Coro eval';
        $('#view').innerHTML =
          '<button class="back" id="back">← Back to run</button>' +
          '<div class="topbar"><div><div class="eyebrow">Attempt result</div><h1>' + e(taskId) + ' <span class="meta">#' + e(attempt) + '</span></h1>' +
            '<p class="meta">' + e(data.meta?.jobId || 'No job id') + ' · ' + e(date(data.meta?.startedAt)) + '</p></div>' +
            status(grade.solved ? 'Solved' : 'Not solved', grade.solved === true) + '</div>' +
          '<div class="detail-grid"><div class="stack">' +
            '<section class="panel"><div class="panel-head"><h2>Test results</h2>' + (tests ? status(tests.hiddenPassed && tests.existingPassed ? 'Passed' : 'Failed', tests.hiddenPassed && tests.existingPassed) : status('Not run', null)) + '</div>' +
              (tests ? testResult('Setup', tests.setup) + testResult('Hidden tests', tests.hidden) + testResult('Existing tests', tests.existing) +
                checks.map((check, index) => testResult('Check ' + (index + 1), check)).join('') :
                '<div class="reason">' + e(grade.judgeSkipped || 'No automated tests were recorded for this attempt.') + '</div>') +
            '</section>' +
            (data.diff ? '<section class="panel"><div class="panel-head"><h2>Delivered diff</h2></div><div class="result"><pre>' + e(data.diff) + '</pre></div></section>' : '') +
          '</div><div class="stack">' +
            '<section class="panel"><div class="panel-head"><h2>Summary</h2></div><div class="reason">' + e(grade.reason || data.meta?.error || 'No grade recorded.') + '</div>' +
              '<div class="facts">' +
                '<div class="fact"><span>Outcome</span><strong>' + e(data.meta?.outcome || data.record.outcome) + '</strong></div>' +
                '<div class="fact"><span>Delivered</span><strong>' + e(grade.delivered ? 'Yes' : 'No') + '</strong></div>' +
                '<div class="fact"><span>Expected outcome</span><strong>' + e(grade.expectedOutcomeMet ? 'Met' : 'Not met') + '</strong></div>' +
                '<div class="fact"><span>Cost</span><strong>' + e(usd(data.record.costUsd)) + '</strong></div>' +
                '<div class="fact"><span>Wall time</span><strong>' + e(duration(data.record.wallMs)) + '</strong></div>' +
              '</div></section>' +
            (grade.scope ? '<section class="panel"><div class="panel-head"><h2>Scope</h2></div><div class="facts">' +
              '<div class="fact"><span>Files changed</span><strong>' + e(grade.scope.filesChanged) + '</strong></div>' +
              '<div class="fact"><span>Lines</span><strong>+' + e(grade.scope.linesAdded) + ' / −' + e(grade.scope.linesRemoved) + '</strong></div>' +
              '<div class="fact"><span>Out of scope</span><strong>' + e((grade.scope.outOfScopeFiles || []).length) + '</strong></div></div></section>' : '') +
            '<section class="panel"><div class="panel-head"><h2>Timeline</h2></div><ol class="timeline">' +
              (data.timeline?.entries || []).map(entry => '<li><strong>' + e(entry.phase || entry.status) + '</strong><small>' + e(duration(entry.elapsedMs)) + ' · ' + e(entry.event || entry.status) + '</small></li>').join('') +
            '</ol></section>' +
          '</div></div>';
        $('#back').addEventListener('click', () => openRun(runId));
        if (updateUrl) setLocation({ run: runId, task: taskId, attempt });
      } catch (error) {
        showError(error);
      }
    }

    function showError(error) {
      $('#view').innerHTML = '<div class="error">' + e(error instanceof Error ? error.message : error) + '</div>';
    }

    async function boot() {
      try {
        state.runs = await get('/api/runs');
        const params = new URLSearchParams(location.search);
        const requested = params.get('run');
        const runId = state.runs.some(run => run.runId === requested) ? requested : state.runs[0]?.runId;
        state.runId = runId;
        renderRunList();
        if (!runId) {
          $('#view').innerHTML = '<div class="empty"><h1>No results yet</h1><p>Run <code>pnpm eval run</code>, then refresh this page.</p></div>';
          return;
        }
        const task = params.get('task');
        const attempt = params.get('attempt');
        if (task && attempt) await openAttempt(runId, task, attempt, false);
        else await openRun(runId, false);
      } catch (error) {
        showError(error);
      }
    }

    addEventListener('popstate', boot);
    boot();
  </script>
</body>
</html>
`

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
    button, input, select { font: inherit; }
    input, select, .action { border: 1px solid var(--line); border-radius: 7px; padding: 8px 10px; background: var(--panel); color: var(--text); max-width: 100%; }
    .action { cursor: pointer; text-decoration: none; font-size: 12px; }
    .action:hover { border-color: var(--accent); }
    :focus-visible { outline: 2px solid var(--accent); outline-offset: 3px; }
    .toolbar { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; margin: 14px 0; }
    .toolbar label { font-size: 12px; color: var(--muted); }
    .toolbar input { max-width: 100%; }
    .note { font-size: 12px; line-height: 1.6; padding: 14px 18px; color: var(--muted); }
    details > summary { cursor: pointer; padding: 16px 18px; font-size: 14px; font-weight: 650; }
    .facts strong { overflow-wrap: anywhere; text-align: right; min-width: 0; }
    .progress { height: 7px; background: var(--line); border-radius: 5px; overflow: hidden; margin-top: 10px; }
    .progress span { display: block; height: 100%; background: var(--accent); }
    #run-search { width: 100%; margin-top: 10px; }
    #refresh { margin: 12px 0; }
    #refresh-status { font-size: 11px; color: #aeb8ca; }
    .shell { min-height: 100vh; display: grid; grid-template-columns: 260px minmax(0, 1fr); }
    aside {
      min-width: 0;
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
    .stack { display: grid; gap: 14px; align-content: start; min-width: 0; }
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
      .shell { grid-template-columns: minmax(0, 1fr); }
      aside { min-height: auto; padding: 16px; }
      .brand { padding-bottom: 10px; }
      .run-list { display: flex; overflow-x: auto; }
      .run-link { min-width: 190px; }
      .cards { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .detail-grid { grid-template-columns: minmax(0, 1fr); }
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
      <input id="run-search" type="search" placeholder="Search runs or scenario…" aria-label="Search runs">
      <button id="refresh" class="action">Refresh results</button>
      <label class="meta"><input id="auto-refresh" type="checkbox"> Auto-refresh (15s)</label>
      <div id="refresh-status" role="status"></div>
      <div id="runs" class="run-list"><div class="loading">Loading…</div></div>
    </aside>
    <main id="view" aria-live="polite"><div class="loading">Loading results…</div></main>
  </div>
  <script>
    const state = { runs: [], runId: null, run: null, request: 0, filters: { query: '', result: '', outcome: '', sort: 'task' } };
    const $ = selector => document.querySelector(selector);
    const e = value => String(value ?? '')
      .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;').replaceAll("'", '&#039;');
    const pct = value => value == null ? '—' : Math.round(value * 100) + '%';
    const usd = value => value == null ? '—' : '$' + Number(value).toFixed(Number(value) < 1 ? 3 : 2);
    const count = value => value == null ? '—' : Number(value).toLocaleString();
    const duration = value => {
      if (value == null) return '—';
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
      const query = $('#run-search').value.toLowerCase();
      const runs = state.runs.filter(run => [run.runId, run.label, run.scenarioHash, run.lane].join(' ').toLowerCase().includes(query));
      $('#runs').innerHTML = runs.length ? runs.map(run =>
        '<button class="run-link ' + (run.runId === state.runId ? 'active' : '') + '" data-run="' + e(run.runId) + '">' +
          '<strong>' + e(run.label || run.runId) + '</strong>' +
          '<small>' + e(date(run.startedAt)) + ' · ' + (run.overall.attempts ? pct(run.overall.solveRate) + ' solved' : 'No graded attempts') + '</small>' +
          '<small>' + e(run.lane) + ' · ' + run.overall.attempts + ' attempts · ' + usd(run.overall.totalCostUsd) + (run.finishedAt ? '' : ' · Unfinished') + '</small>' +
        '</button>'
      ).join('') : '<div class="empty">' + (state.runs.length ? 'No matching runs.' : 'No eval runs yet.') + '</div>';
      document.querySelectorAll('[data-run]').forEach(button => button.addEventListener('click', () => openRun(button.dataset.run)));
    }

    function card(label, value) {
      return '<div class="card"><div class="label">' + e(label) + '</div><div class="value">' + e(value) + '</div></div>';
    }

    function facts(entries) {
      return '<div class="facts">' + entries.map(([label, value]) => '<div class="fact"><span>' + e(label) + '</span><strong>' + e(value ?? '—') + '</strong></div>').join('') + '</div>';
    }

    function metric(key, value, delta = false) {
      if (value == null) return '—';
      const sign = delta && value > 0 ? '+' : '';
      if (key === 'solveRate') return sign + (value * 100).toFixed(1) + (delta ? ' pp' : '%');
      if (key === 'costUsd') return sign + usd(value);
      if (key.endsWith('Ms')) return (value < 0 ? '−' : sign) + duration(Math.abs(value));
      return sign + Number(value).toFixed(2);
    }

    function renderAttempts() {
      const f = state.filters;
      const items = state.run.attempts.filter(item =>
        item.taskId.toLowerCase().includes(f.query.toLowerCase()) &&
        (!f.result || (f.result === 'solved' ? item.solved : !item.solved)) &&
        (!f.outcome || item.outcome === f.outcome));
      items.sort((a, b) => f.sort === 'task' ? a.taskId.localeCompare(b.taskId) || a.attempt - b.attempt : (b[f.sort] ?? -Infinity) - (a[f.sort] ?? -Infinity));
      $('#attempt-count').textContent = items.length + ' / ' + state.run.attempts.length + ' attempts';
      $('#attempt-rows').innerHTML = items.length ? items.map(item => '<tr>' +
        '<td><button class="back" style="margin:0" data-task="' + e(item.taskId) + '" data-attempt="' + item.attempt + '">' + e(item.taskId) + ' #' + item.attempt + '</button></td>' +
        '<td>' + status(item.solved ? 'Solved' : 'Not solved', item.solved) + '</td><td>' + e(item.outcome) + '</td>' +
        '<td>' + usd(item.costUsd) + '</td><td>' + duration(item.agentMs) + '</td><td>' + duration(item.reviewWaitMs) + '</td><td>' + duration(item.wallMs) + '</td>' +
        '<td>' + count(item.inputTokens) + ' / ' + count(item.outputTokens) + '</td><td>' + count(item.reworkRuns) + '</td><td>' + (item.judge ? item.judge.mean.toFixed(2) : '—') + '</td></tr>').join('') :
        '<tr><td colspan="10" class="empty">No matching graded attempts.</td></tr>';
      $('#attempt-rows').querySelectorAll('[data-task]').forEach(button => button.addEventListener('click', () => openAttempt(state.runId, button.dataset.task, button.dataset.attempt)));
    }

    async function openRun(runId, updateUrl = true) {
      const request = ++state.request;
      state.runId = runId;
      renderRunList();
      $('#view').innerHTML = '<div class="loading">Loading run…</div>';
      try {
        const run = await get('/api/runs/' + encodeURIComponent(runId));
        if (request !== state.request) return;
        state.run = run;
        const o = run.summary.overall;
        const expected = run.info.tasks.length * run.info.scenario.repeat;
        document.title = (run.info.label || run.info.runId) + ' · Coro eval';
        $('#view').innerHTML =
          '<div class="topbar"><div><div class="eyebrow">Eval run</div><h1>' + e(run.info.label || run.info.runId) + '</h1>' +
            '<p class="meta">' + e(date(run.info.startedAt)) + ' · ' + e(run.info.scenario.lane) + ' lane · ' + e(run.info.scenarioHash) + '</p></div>' +
            status(run.info.finishedAt ? 'Finished' : 'Unfinished', null) + '</div>' +
          '<p class="meta">' + o.attempts + ' / ' + expected + ' planned attempts graded. ' + (run.info.finishedAt ? '' : 'Unfinished may mean running or interrupted; only graded attempts are shown.') + '</p>' +
          '<div class="progress" aria-label="Graded attempt progress"><span style="width:' + Math.min(100, expected ? o.attempts / expected * 100 : 0) + '%"></span></div><br>' +
          '<section class="cards">' +
            card('Solve rate', o.attempts ? pct(o.solveRate) : '—') +
            card('Solved', o.solved + ' / ' + o.attempts) +
            card('Total cost', usd(o.totalCostUsd)) +
            card('Median agent time', o.attempts ? duration(o.medianAgentMs) : '—') +
            card('Pass@k · at least once', o.tasks ? pct(o.passAtKRate) : '—') +
            card('Pass^k · every attempt', o.tasks ? pct(o.passPowKRate) : '—') +
            card('Cost per solved attempt', usd(o.costPerSolvedUsd)) +
            card('Judge mean · advisory / 5', o.meanJudge == null ? '—' : o.meanJudge.toFixed(2)) +
          '</section>' +
          '<p class="meta">Rates use completed attempts only. Pass^k is provisional until all planned attempts finish. Checks and judge scores do not decide solved.</p>' +
          '<section class="panel"><details><summary>Scenario & reproducibility</summary>' +
            facts([['Run ID', run.info.runId], ['Coro revision', (run.info.coroSha || 'Unknown') + (run.info.coroDirty ? ' +dirty' : '')],
              ['Harness revision', (run.info.harnessSha || 'Unknown') + (run.info.harnessDirty ? ' +dirty' : '')], ['Coro checkout', run.info.coroPath],
              ['Scenario file', run.info.scenarioFile || 'Defaults'], ['Finished', run.info.finishedAt ? date(run.info.finishedAt) : 'Not recorded'],
              ['Repeat / parallel', run.info.scenario.repeat + ' / ' + run.info.scenario.parallel], ['Overrides', run.info.overrides.join(', ') || 'None']]) +
            '<div class="result"><pre>' + e(JSON.stringify(run.info.scenario, null, 2)) + '</pre></div></details></section>' +
          '<section class="panel"><div class="panel-head"><h2>Compare to baseline</h2></div><div class="result">' +
            '<label for="baseline">Baseline run (A)</label> <select id="baseline"><option value="">Choose a run…</option>' +
            state.runs.filter(item => item.runId !== runId).map(item => '<option value="' + e(item.runId) + '">' + e(item.label + ' · ' + item.runId) + '</option>').join('') + '</select>' +
            '<div id="comparison"><p class="note">This run is B. Deltas are B minus A, paired on shared tasks, using the CLI’s noise-aware comparison.</p></div></div></section>' +
          '<section class="panel"><div class="panel-head"><h2>Tasks</h2><span class="meta">' + o.tasks + ' total</span></div>' +
            '<div class="table-wrap"><table><thead><tr><th>Task</th><th>Solved</th><th>Pass@k</th><th>Pass^k</th><th>Median cost</th><th>Median agent / review wait</th><th>Outcome</th></tr></thead><tbody>' +
              run.summary.tasks.map(task => '<tr><td><button class="back" style="margin:0" data-filter-task="' + e(task.taskId) + '">' + e(task.taskId) + '</button></td><td>' + e(task.solved + '/' + task.attempts) + '</td>' +
                '<td>' + status(task.passAtK ? 'Pass' : 'Fail', task.passAtK) + '</td><td>' + status(task.passPowK ? 'Pass' : 'Fail', task.passPowK) + '</td>' +
                '<td>' + e(usd(task.medianCostUsd)) + '</td><td>' + e(duration(task.medianAgentMs) + ' / ' + duration(task.medianReviewWaitMs)) + '</td><td>' + e(Object.entries(task.outcomes).map(([key, n]) => n + ' ' + key).join(', ')) + '</td></tr>').join('') +
            '</tbody></table></div></section>' +
          '<section class="panel" id="attempts"><div class="panel-head"><h2>Attempts</h2><span id="attempt-count" class="meta"></span></div>' +
            '<div class="result toolbar"><input id="task-filter" type="search" aria-label="Filter tasks" placeholder="Filter tasks…" value="' + e(state.filters.query) + '">' +
            '<select id="result-filter" aria-label="Filter result"><option value="">All results</option><option value="solved">Solved</option><option value="failed">Not solved</option></select>' +
            '<select id="outcome-filter" aria-label="Filter outcome"><option value="">All outcomes</option>' + Object.keys(o.outcomes).map(outcome => '<option>' + e(outcome) + '</option>').join('') + '</select>' +
            '<select id="sort" aria-label="Sort attempts">' + [['task','Task / attempt'],['costUsd','Highest cost'],['agentMs','Longest agent time'],['wallMs','Longest wall time'],['reworkRuns','Most rework']].map(([value,label]) => '<option value="' + value + '">' + label + '</option>').join('') + '</select>' +
            '<button id="clear-filters" class="action">Clear filters</button></div>' +
            '<div class="table-wrap"><table><thead><tr><th>Attempt</th><th>Result</th><th>Outcome</th><th>Cost</th><th>Agent</th><th>Review wait</th><th>Wall</th><th>Tokens in / out</th><th>Rework</th><th>Judge / 5</th></tr></thead><tbody id="attempt-rows"></tbody></table></div></section>';
        const controls = { query: '#task-filter', result: '#result-filter', outcome: '#outcome-filter', sort: '#sort' };
        Object.entries(controls).forEach(([key, selector]) => {
          $(selector).value = state.filters[key];
          $(selector).addEventListener(key === 'query' ? 'input' : 'change', event => { state.filters[key] = event.target.value; renderAttempts(); });
        });
        $('#clear-filters').addEventListener('click', () => {
          state.filters = { query: '', result: '', outcome: '', sort: 'task' };
          Object.entries(controls).forEach(([key, selector]) => { $(selector).value = state.filters[key]; });
          renderAttempts();
        });
        document.querySelectorAll('[data-filter-task]').forEach(button => button.addEventListener('click', () => {
          state.filters.query = button.dataset.filterTask;
          $('#task-filter').value = state.filters.query;
          renderAttempts();
          $('#attempts').scrollIntoView({ behavior: 'smooth' });
        }));
        renderAttempts();
        $('#baseline').addEventListener('change', () => showComparison(runId, $('#baseline').value));
        if (updateUrl) setLocation({ run: runId });
        const baseline = new URLSearchParams(location.search).get('baseline');
        if (baseline && $('#baseline').querySelector('option[value="' + CSS.escape(baseline) + '"]')) {
          $('#baseline').value = baseline;
          await showComparison(runId, baseline, false);
        }
      } catch (error) {
        if (request === state.request) showError(error);
      }
    }

    async function showComparison(runId, baseline, updateUrl = true) {
      const target = $('#comparison');
      if (updateUrl) setLocation({ run: runId, baseline: baseline || null });
      if (!baseline) { target.innerHTML = '<p class="note">Choose a baseline run to compare.</p>'; return; }
      target.innerHTML = '<p class="note">Loading comparison…</p>';
      try {
        const data = await get('/api/compare?a=' + encodeURIComponent(baseline) + '&b=' + encodeURIComponent(runId));
        if (!target.isConnected || $('#baseline').value !== baseline) return;
        const comparison = data.comparison;
        const rows = (label, metrics) => metrics.map(item => '<tr><td>' + e(label) + '</td><td>' + e(item.metric) + '</td><td>' + metric(item.metric, item.a) + '</td><td>' + metric(item.metric, item.b) + '</td><td>' + metric(item.metric, item.delta, true) + '</td><td>' +
          status(item.verdict, item.verdict === 'better' ? true : item.verdict === 'worse' ? false : null) + '</td></tr>').join('');
        target.innerHTML = '<p class="note">' + comparison.overall.tasks + ' shared tasks. ' +
          (data.a.scenarioHash !== data.b.scenarioHash ? 'Different scenario hashes. ' : 'Same scenario hash. ') +
          ((!data.a.finishedAt || !data.b.finishedAt) ? 'At least one run is unfinished; comparison is provisional. ' : '') +
          'Only A: ' + e(comparison.onlyInA.join(', ') || 'none') + '. Only B: ' + e(comparison.onlyInB.join(', ') || 'none') + '.</p>' +
          '<p class="note">Noise: within attempt spread. Unknown: insufficient repeats. Overall values are means across shared tasks, not medians. Judge is advisory.</p>' +
          (comparison.overall.tasks ? '<div class="table-wrap"><table><thead><tr><th>Task</th><th>Metric</th><th>A</th><th>B</th><th>B − A</th><th>Verdict</th></tr></thead><tbody>' +
            rows('Overall', comparison.overall.metrics) + comparison.tasks.map(task => rows(task.taskId + ' (' + task.attemptsA + ' / ' + task.attemptsB + ')', task.metrics)).join('') + '</tbody></table></div>' : '<p class="empty">No shared graded tasks to compare.</p>');
      } catch (error) {
        if (target.isConnected && $('#baseline').value === baseline) target.innerHTML = '<div class="error">' + e(error.message) + '</div>';
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
      const request = ++state.request;
      state.runId = runId;
      renderRunList();
      $('#view').innerHTML = '<div class="loading">Loading attempt…</div>';
      try {
        const data = await get('/api/runs/' + encodeURIComponent(runId) + '/attempts/' + encodeURIComponent(taskId) + '/' + encodeURIComponent(attempt));
        if (request !== state.request) return;
        const grade = data.grade || {};
        const m = data.metrics;
        const tests = grade.tests;
        const checks = tests?.checks || [];
        document.title = taskId + ' #' + attempt + ' · Coro eval';
        $('#view').innerHTML =
          '<button class="back" id="back">← Back to run</button>' +
          '<div class="topbar"><div><div class="eyebrow">Attempt result</div><h1>' + e(taskId) + ' <span class="meta">#' + e(attempt) + '</span></h1>' +
            '<p class="meta">' + e(data.meta?.jobId || 'No job id') + ' · ' + e(date(data.meta?.startedAt)) + '</p></div>' +
            status(data.record.solved ? 'Solved' : 'Not solved', data.record.solved) + '</div>' +
          '<div class="detail-grid"><div class="stack">' +
            '<section class="panel"><div class="panel-head"><h2>Test results</h2>' + (tests ? status(tests.hiddenPassed && tests.existingPassed ? 'Passed' : 'Failed', tests.hiddenPassed && tests.existingPassed) : status('Not run', null)) + '</div>' +
              (tests ? testResult('Setup', tests.setup) + testResult('Hidden tests', tests.hidden) + testResult('Existing tests', tests.existing) +
                checks.map((check, index) => testResult('Check ' + (index + 1), check)).join('') +
                (!tests.existing ? '<p class="note">Existing tests: ' + (tests.existingPassed ? 'none required' : 'not run') + '.</p>' : '') :
                '<div class="reason">No automated tests were recorded for this attempt. Escalation tasks are graded on asking for help, not tests.</div>') +
            '</section>' +
            (m ? '<section class="panel"><div class="panel-head"><h2>Phase breakdown</h2></div><div class="table-wrap"><table><thead><tr><th>Phase</th><th>Runs / rework</th><th>Cost</th><th>Agent time</th><th>Turns</th><th>Models</th></tr></thead><tbody>' +
              (m.phases || []).map(phase => '<tr><td>' + e(phase.phase) + '</td><td>' + count(phase.runs) + ' / ' + count(phase.reworkRuns) + '</td><td>' + usd(phase.costUsd) + '</td><td>' + duration(phase.durationMs) + '</td><td>' + count(phase.turns) + '</td><td>' + e((phase.models || []).join(', ')) + '</td></tr>').join('') +
              '</tbody></table></div><p class="note">Rework is a floor; unclassified phase runs are not counted as rework.</p></section>' : '') +
            (data.diff ? '<section class="panel"><div class="panel-head"><h2>Delivered diff</h2></div><div class="result">' + (data.diffTruncated ? '<p class="note">Showing the last 64 KiB. Download the full diff below.</p>' : '') + '<pre>' + e(data.diff) + '</pre></div></section>' : '') +
            '<section class="panel"><div class="panel-head"><h2>Logs & artifacts</h2></div><div class="result">' +
              '<div class="toolbar"><label for="artifact">Preview</label><select id="artifact"><option value="">Choose an artifact…</option>' +
              (data.artifacts || []).map(item => '<option value="' + e(item.name) + '">' + e(item.name) + ' (' + count(item.bytes) + ' bytes)</option>').join('') +
              '</select><a id="download" class="action" hidden>Download full file</a></div><div id="artifact-preview"><p class="note">Inspect job, runner, or grading logs and raw JSON without leaving the attempt.</p></div></div></section>' +
          '</div><div class="stack">' +
            '<section class="panel"><div class="panel-head"><h2>Summary</h2></div><div class="reason">' + e(grade.reason || data.meta?.error || 'No grade recorded.') + '</div>' +
              '<div class="facts">' +
                '<div class="fact"><span>Outcome</span><strong>' + e(data.meta?.outcome || data.record.outcome) + '</strong></div>' +
                '<div class="fact"><span>Delivered</span><strong>' + e(grade.delivered == null ? 'Unknown' : grade.delivered ? 'Yes' : 'No') + '</strong></div>' +
                '<div class="fact"><span>Expected outcome</span><strong>' + e(data.record.expectedOutcomeMet ? 'Met' : 'Not met') + '</strong></div>' +
                '<div class="fact"><span>Cost</span><strong>' + e(usd(data.record.costUsd)) + '</strong></div>' +
                '<div class="fact"><span>Wall time</span><strong>' + e(duration(data.record.wallMs)) + '</strong></div>' +
              '</div>' +
              facts([['Agent time', duration(data.record.agentMs)], ['Review wait', duration(data.record.reviewWaitMs)],
                ['Input / output tokens', count(data.record.inputTokens) + ' / ' + count(data.record.outputTokens)],
                ['Phase / rework runs', count(data.record.phaseRuns) + ' / ' + count(data.record.reworkRuns)]]) +
              (data.meta?.error ? '<div class="reason error">' + e(data.meta.error) + '</div>' : '') + '</section>' +
            (data.meta?.delivery ? '<section class="panel"><div class="panel-head"><h2>Delivery</h2></div>' +
              facts([['Via', data.meta.delivery.via], ['Base', data.meta.delivery.baseSha], ['Head', data.meta.delivery.headSha],
                ['Branches', data.meta.delivery.branches.join(', ') || 'None'], ['Skipped branches', data.meta.delivery.skippedBranches.join(', ') || 'None']]) + '</section>' : '') +
            (m ? '<section class="panel"><div class="panel-head"><h2>Execution diagnostics</h2></div>' +
              facts([['Tool calls / failures', count(m.toolCalls) + ' / ' + count(m.toolFailures)], ['Rate limit retries', count(m.rateLimitRetries)],
                ['Cache read / write tokens', count(m.cacheReadInputTokens) + ' / ' + count(m.cacheCreationInputTokens)],
                ['Rework cost', usd(m.reworkCostUsd)], ['Attributed phase runs', count(m.attributedRuns) + ' / ' + count(m.phaseRuns)],
                ['Work items / PRs', count(m.workItemCount) + ' / ' + count(m.prCount)], ['Max loop count', count(m.maxLoopCount)]]) +
              ((m.failedTools || []).length ? facts(m.failedTools.map(tool => [tool.toolName, tool.failures + ' failures'])) : '') + '</section>' : '<section class="panel"><p class="note">Detailed metrics were not recorded for this attempt.</p></section>') +
            (grade.scope ? '<section class="panel"><div class="panel-head"><h2>Scope</h2></div><div class="facts">' +
              '<div class="fact"><span>Files changed</span><strong>' + e(grade.scope.filesChanged) + '</strong></div>' +
              '<div class="fact"><span>Lines</span><strong>+' + e(grade.scope.linesAdded) + ' / −' + e(grade.scope.linesRemoved) + '</strong></div>' +
              '<div class="fact"><span>Out of scope</span><strong>' + e((grade.scope.outOfScopeFiles || []).length) + '</strong></div></div>' +
              ((grade.scope.outOfScopeFiles || []).length ? '<div class="reason">' + e(grade.scope.outOfScopeFiles.join(', ')) + '</div>' : '') +
              (grade.scope.reference ? facts([['Reference files / lines', grade.scope.reference.filesChanged + ' / +' + grade.scope.reference.linesAdded + ' −' + grade.scope.reference.linesRemoved], ['Size vs reference', grade.scope.sizeRatio == null ? '—' : grade.scope.sizeRatio + '×']]) : '') + '</section>' : '') +
            (grade.judge ? '<section class="panel"><div class="panel-head"><h2>Judge</h2>' + status('mean ' + Number(grade.judge.mean || 0).toFixed(1), null) + '</div>' +
              '<p class="note">' + e(grade.judge.model) + ' · ' + e(grade.judge.validSamples + ' / ' + grade.judge.samples) + ' valid samples. Advisory only; never decides solved.</p>' +
              '<div class="facts">' + Object.entries(grade.judge.scores || {}).map(([key, value]) =>
                '<div class="fact"><span>' + e(key) + '</span><strong>' + e(value) + '</strong></div>').join('') + '</div>' +
              (grade.judge.summary ? '<div class="reason">' + e(grade.judge.summary) + '</div>' : '') +
              ((grade.judge.issues || []).length ? '<div class="result">' + grade.judge.issues.map(issue =>
                '<div class="result-head"><h3>' + e(issue.severity || 'issue') + '</h3><span class="meta">' + e(issue.file || '') + '</span></div>' +
                '<p class="meta" style="margin:0 0 10px">' + e(issue.summary) + '</p>').join('') + '</div>' : '') +
            '</section>' : '<section class="panel"><div class="panel-head"><h2>Judge</h2></div><p class="note">' + e(grade.judgeSkipped || 'No judge result recorded.') + '</p></section>') +
            '<section class="panel"><div class="panel-head"><h2>Timeline</h2></div><ol class="timeline">' +
              ((data.timeline?.entries || []).map(entry => '<li><strong>' + e(entry.phase || entry.status) + '</strong><small>' + e(date(entry.at)) + ' · ' + e(duration(entry.elapsedMs)) + ' · ' + e(entry.event || entry.status) + '</small></li>').join('') || '<li>No timeline recorded.</li>') +
            '</ol></section>' +
          '</div></div>';
        $('#back').addEventListener('click', () => openRun(runId));
        $('#artifact').addEventListener('change', async () => {
          const name = $('#artifact').value;
          const target = $('#artifact-preview');
          $('#download').hidden = !name;
          if (!name) { target.innerHTML = ''; return; }
          const url = '/api/runs/' + encodeURIComponent(runId) + '/attempts/' + encodeURIComponent(taskId) + '/' + encodeURIComponent(attempt) + '/artifacts/' + encodeURIComponent(name);
          $('#download').href = url + '?download=1';
          target.innerHTML = '<p class="note">Loading artifact…</p>';
          try {
            const file = await get(url);
            if (!target.isConnected || $('#artifact').value !== name) return;
            target.innerHTML = (file.truncated ? '<p class="note">Showing the last 64 KiB of ' + count(file.bytes) + ' bytes. Download for the complete file.</p>' : '') +
              '<pre>' + e(file.text || '(empty file)') + '</pre>';
          } catch (error) {
            if (target.isConnected && $('#artifact').value === name) target.innerHTML = '<div class="error">' + e(error.message) + '</div>';
          }
        });
        if (updateUrl) setLocation({ run: runId, task: taskId, attempt });
      } catch (error) {
        if (request === state.request) showError(error);
      }
    }

    function showError(error) {
      $('#view').innerHTML = '<div class="error">' + e(error instanceof Error ? error.message : error) + '</div>';
    }

    async function boot() {
      const request = ++state.request;
      try {
        const runs = await get('/api/runs');
        if (request !== state.request) return;
        state.runs = runs;
        const params = new URLSearchParams(location.search);
        const requested = params.get('run');
        const runId = requested || state.runs[0]?.runId;
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
        if (request === state.request) showError(error);
      }
    }

    $('#run-search').addEventListener('input', renderRunList);
    async function refresh() {
      $('#refresh').disabled = true;
      $('#refresh-status').textContent = 'Refreshing…';
      await boot();
      $('#refresh').disabled = false;
      $('#refresh-status').textContent = 'Last refresh request: ' + new Date().toLocaleTimeString();
    }
    $('#refresh').addEventListener('click', refresh);
    setInterval(() => { if ($('#auto-refresh').checked && !$('#refresh').disabled && !document.hidden) refresh(); }, 15000);
    addEventListener('popstate', boot);
    boot();
  </script>
</body>
</html>
`

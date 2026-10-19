/* NBA 日程とロスター — 依存なしの素の JS
 *
 * 画面
 *   #/            日程（日付ごと）
 *   #/teams       チーム一覧
 *   #/team/DEN    チームのロスターと日程
 *
 * データは public/data1/ の JSON を1回ずつ読んで使い回す。
 * duckdb も Parquet も使わない（合計 285KB）。
 */

const DATA = './public/data1';
const view = document.getElementById('view');

/* 読んだ JSON を覚えておく。同じものを2度取りにいかない */
const cache = {};
async function load(name) {
  if (cache[name]) return cache[name];
  const res = await fetch(`${DATA}/${name}.json`);
  if (!res.ok) throw new Error(`${name}.json が読めない (${res.status})`);
  cache[name] = await res.json();
  return cache[name];
}

/* ------------------------------------------------------------- 小道具 */

const esc = (s) => String(s ?? '').replace(/[&<>"']/g,
  (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const WD = ['日', '月', '火', '水', '木', '金', '土'];
function fmtDate(d) {
  const [y, m, dd] = d.split('-').map(Number);
  const w = WD[new Date(Date.UTC(y, m - 1, dd)).getUTCDay()];
  return `${m}月${dd}日(${w})`;
}
function shiftDate(d, n) {
  const [y, m, dd] = d.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, dd + n));
  return t.toISOString().slice(0, 10);
}
const todayISO = () => new Date().toISOString().slice(0, 10);

/* 「—」で埋めて桁を揃える */
const num = (v, dig = 1) => (v === null || v === undefined)
  ? '<span class="dim">—</span>' : Number(v).toFixed(dig);

/* ------------------------------------------------------------- 日程 */

async function renderSchedule(dateArg) {
  const sc = await load('schedule');
  const games = sc.games;
  const days = [...new Set(games.map((g) => g.d))].sort();
  const first = days[0], last = days[days.length - 1];

  /* 既定の日付: 今日に試合があれば今日、無ければ「今日以降で最初に試合がある日」 */
  let date = dateArg;
  if (!date) {
    const t = todayISO();
    date = days.includes(t) ? t : (days.find((d) => d >= t) || last);
  }
  if (date < first) date = first;
  if (date > last) date = last;

  const onDay = games.filter((g) => g.d === date);
  const prev = [...days].reverse().find((d) => d < date);
  const next = days.find((d) => d > date);

  const until = Math.round(
    (Date.UTC(...first.split('-').map((v, i) => i === 1 ? v - 1 : +v))
      - Date.UTC(...todayISO().split('-').map((v, i) => i === 1 ? v - 1 : +v)))
    / 86400000);

  view.innerHTML = `
    <h1>日程</h1>
    <p class="sub">
      ${esc(sc.season)} レギュラーシーズン ${games.length.toLocaleString()} 試合
      ${until > 0 ? `・<strong>開幕まであと ${until} 日</strong>` : ''}
    </p>

    <div class="datebar">
      <button id="prev" ${prev ? '' : 'disabled'}>← 前日</button>
      <input type="date" id="pick" value="${date}" min="${first}" max="${last}">
      <button id="next" ${next ? '' : 'disabled'}>翌日 →</button>
      <button id="open" class="today">開幕日</button>
      <span class="spacer"></span>
      <span class="count">${fmtDate(date)} · ${onDay.length} 試合</span>
    </div>

    ${onDay.length ? `<div class="games">${onDay.map(gameRow).join('')}</div>`
      : `<p class="empty">この日は試合がない。</p>`}
  `;

  document.getElementById('prev').onclick = () => go(`#/d/${prev}`);
  document.getElementById('next').onclick = () => go(`#/d/${next}`);
  document.getElementById('open').onclick = () => go(`#/d/${first}`);
  document.getElementById('pick').onchange = (e) => {
    const v = e.target.value;
    /* 試合の無い日を選んだら、その日以降で最初に試合がある日へ送る */
    go(`#/d/${days.includes(v) ? v : (days.find((d) => d >= v) || last)}`);
  };
}

function gameRow(g) {
  return `<div class="game">
    <div class="tip">${esc(g.t || '')}</div>
    <div class="match">
      <a href="#/team/${esc(g.a)}">${esc(g.a)}</a>
      <span class="at">＠</span>
      <a href="#/team/${esc(g.h)}">${esc(g.h)}</a>
      ${g.label ? `<span class="badge">${esc(g.label)}</span>` : ''}
    </div>
    <div class="meta">
      ${g.tv ? `<span class="tv">${esc(g.tv)}</span> · ` : ''}
      ${esc(g.city || '')}
    </div>
  </div>`;
}

/* ------------------------------------------------------------- チーム一覧 */

async function renderTeams() {
  const teams = await load('teams');
  const byConf = {};
  for (const t of teams) {
    (byConf[t.conference] ??= {});
    (byConf[t.conference][t.division] ??= []).push(t);
  }
  view.innerHTML = `
    <h1>チーム</h1>
    <p class="sub">30 チーム。クリックすると在籍選手と日程が出る。</p>
    <div class="confs">
      ${Object.entries(byConf).map(([conf, divs]) => `
        <section>
          <h2>${esc(conf)}</h2>
          ${Object.entries(divs).map(([div, ts]) => `
            <h2 style="margin-top:14px">${esc(div)}</h2>
            <div class="divgrid">
              ${ts.map((t) => `
                <a class="teamrow" href="#/team/${esc(t.tri)}">
                  <span>${esc(t.full_name)}</span>
                  <span class="tri">${esc(t.tri)}</span>
                </a>`).join('')}
            </div>`).join('')}
        </section>`).join('')}
    </div>`;
}

/* ------------------------------------------------------------- チーム */

async function renderTeam(tri, tab) {
  const [teams, rost, sc] = await Promise.all(
    [load('teams'), load('rosters'), load('schedule')]);
  const team = teams.find((t) => t.tri === tri);
  if (!team) { view.innerHTML = `<p class="err">チーム ${esc(tri)} が無い。</p>`; return; }

  const players = rost.teams[tri] || [];
  const games = sc.games.filter((g) => g.h === tri || g.a === tri);
  const cur = tab === 'schedule' ? 'schedule' : 'roster';

  view.innerHTML = `
    <div class="teamhead">
      <h1>${esc(team.full_name)}</h1>
      <span class="tri">${esc(tri)}</span>
      <span class="sub" style="margin:0">${esc(team.conference)} / ${esc(team.division)}</span>
    </div>
    <div class="tabs">
      <button data-t="roster"   class="${cur === 'roster' ? 'on' : ''}">
        ロスター（${players.length}）</button>
      <button data-t="schedule" class="${cur === 'schedule' ? 'on' : ''}">
        日程（${games.length}）</button>
    </div>
    <div id="pane">${cur === 'roster'
      ? rosterTable(players, rost.prev) : teamSchedule(games, tri)}</div>`;

  view.querySelectorAll('.tabs button').forEach((b) => {
    b.onclick = () => go(`#/team/${tri}/${b.dataset.t}`);
  });
}

function rosterTable(ps, prev) {
  if (!ps.length) return `<p class="empty">ロスターが無い。</p>`;
  const isNew = (p) => p.acq && /\/26$/.test(p.acq.trim());
  return `<div class="wrap"><table>
    <thead><tr>
      <th class="n">#</th><th>選手</th><th>Pos</th><th>身長</th>
      <th class="n">体重</th><th class="n">年齢</th><th class="n">年数</th>
      <th class="n">試合</th><th class="n">MPG</th><th class="n">PPG</th>
      <th class="n">RPG</th><th class="n">APG</th><th>加入</th>
    </tr></thead>
    <tbody>
    ${ps.map((p) => `<tr>
      <td class="n dim">${esc(p.num ?? '')}</td>
      <td>${esc(p.name)}
        ${p.tw ? '<span class="badge">TW</span>' : ''}
        ${isNew(p) ? '<span class="badge">新加入</span>' : ''}</td>
      <td class="dim">${esc(p.pos ?? '')}</td>
      <td class="dim">${esc(p.ht ?? '')}</td>
      <td class="n dim">${esc(p.wt ?? '')}</td>
      <td class="n">${num(p.age, 0)}</td>
      <td class="n dim">${esc(p.exp ?? '')}</td>
      <td class="n">${p.g ?? '<span class="dim">—</span>'}</td>
      <td class="n">${num(p.mpg)}</td>
      <td class="n">${num(p.ppg)}</td>
      <td class="n">${num(p.rpg)}</td>
      <td class="n">${num(p.apg)}</td>
      <td class="dim" style="font-size:12px">${esc(p.acq ?? '')}</td>
    </tr>`).join('')}
    </tbody>
  </table></div>
  <p class="sub" style="margin-top:12px">
    試合〜APG は <strong>${esc(prev)}</strong> レギュラーシーズンの平均。
    「—」は前季に出場が無い選手（新人・新規契約）。
    TW = two-way 等の補足契約。
  </p>`;
}

function teamSchedule(gs, tri) {
  if (!gs.length) return `<p class="empty">日程が無い。</p>`;
  const t = todayISO();
  return `<div class="wrap"><table>
    <thead><tr><th>日付</th><th class="n">時刻(ET)</th><th>対戦</th>
      <th>H/A</th><th>会場</th><th>TV</th></tr></thead>
    <tbody>
    ${gs.map((g) => {
      const home = g.h === tri;
      const opp = home ? g.a : g.h;
      return `<tr${g.d < t ? ' class="dim"' : ''}>
        <td>${fmtDate(g.d)}</td>
        <td class="n dim">${esc(g.t || '')}</td>
        <td><a href="#/team/${esc(opp)}">${esc(opp)}</a>
            ${g.label ? `<span class="badge">${esc(g.label)}</span>` : ''}</td>
        <td class="dim">${home ? 'ホーム' : 'アウェイ'}</td>
        <td class="dim" style="font-size:12px">${esc(g.city || '')}</td>
        <td class="dim">${esc(g.tv || '')}</td>
      </tr>`;
    }).join('')}
    </tbody></table></div>`;
}

/* ------------------------------------------------------------- 経路 */

function go(hash) {
  if (location.hash === hash) route();
  else location.hash = hash;
}

async function route() {
  const parts = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean);
  const nav = { schedule: 'on', teams: '' };
  try {
    view.innerHTML = '<p class="loading">読み込み中…</p>';
    if (parts[0] === 'teams') {
      nav.schedule = ''; nav.teams = 'on';
      await renderTeams();
    } else if (parts[0] === 'team' && parts[1]) {
      nav.schedule = ''; nav.teams = 'on';
      await renderTeam(parts[1].toUpperCase(), parts[2]);
    } else if (parts[0] === 'd' && parts[1]) {
      await renderSchedule(parts[1]);
    } else {
      await renderSchedule(null);
    }
  } catch (e) {
    view.innerHTML = `<p class="err">読み込みに失敗した: ${esc(e.message)}</p>`;
    return;
  }
  document.querySelectorAll('header nav a').forEach((a) => {
    a.className = nav[a.dataset.nav] || '';
  });
  window.scrollTo(0, 0);
}

window.addEventListener('hashchange', route);
route();

/* 取得日をフッタに出す */
load('manifest').then((m) => {
  document.getElementById('gen').textContent =
    (m.generated_at || '').slice(0, 10);
}).catch(() => {});

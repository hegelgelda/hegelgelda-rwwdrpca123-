/* NBA 日程とロスター — 依存なしの素の JS
 *
 * 画面
 *   #/            日程（日付ごと）
 *   #/teams       チーム一覧
 *   #/team/DEN    チームのロスターと日程
 *   #/game/0022600001  試合の結果（クォーター別・ラインナップ推移・injury）
 *
 * データは public/data1/ の JSON を1回ずつ読んで使い回す。
 * duckdb も Parquet も使わない（合計 285KB）。
 */

const DATA = './public/data1';
/* public/data1/ の中身のハッシュ。tools/stamp_assets.py が書き換える。
   これが無いと、JSON を作り直しても GitHub Pages の 10 分キャッシュに
   邪魔されて古いデータが使われ続ける（新しい列が抜けて見える） */
const DATA_V = '3253535c';
const view = document.getElementById('view');

/* 読んだ JSON を覚えておく。同じものを2度取りにいかない */
const cache = {};
async function load(name) {
  if (cache[name]) return cache[name];
  const res = await fetch(`${DATA}/${name}.json?v=${DATA_V}`);
  if (!res.ok) throw new Error(`${name}.json が読めない (${res.status})`);
  cache[name] = await res.json();
  return cache[name];
}

/* 終わった試合の最終スコア。games_index.json を1回読んで使い回す。
   ★ 無くても日程は出す。シーズン頭で1試合も終わっていないときや、
     JSON を作り直す前でも日程が壊れないように、失敗は空で飲む */
let RESULTS = null;
async function results() {
  if (RESULTS) return RESULTS;
  try {
    const ix = await load('games_index');
    RESULTS = Object.fromEntries(ix.games.map((g) => [g.id, g]));
  } catch (e) {
    RESULTS = {};
  }
  return RESULTS;
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

/* その日が含まれる週の月曜日。
   schedule.json の `d` は ET の試合日なので、ここは文字列のまま扱えばよい
   （実行環境の TZ は関係しない）。getUTCDay は日曜=0 なので月曜起点に直す */
function monday(d) {
  const [y, m, dd] = d.split('-').map(Number);
  const w = new Date(Date.UTC(y, m - 1, dd)).getUTCDay();
  return shiftDate(d, -((w + 6) % 7));
}
const WEEK = (start) => Array.from({ length: 7 }, (_, i) => shiftDate(start, i));

/* 「—」で埋めて桁を揃える */
const num = (v, dig = 1) => (v === null || v === undefined)
  ? '<span class="dim">—</span>' : Number(v).toFixed(dig);

/* 日本時間。`tj` は build_page1.py が Asia/Tokyo に落とした時刻、
   `tjo` は ET の試合日から見た日付のずれ（ET 夜の試合はほぼ翌日になる）。
   ET→JST は夏時間で +13h / +14h と変わるので、ここでは足し算しない */
function jst(g) {
  if (!g.tj) return '';
  const o = g.tjo || 0;
  return (o === 1 ? '翌' : o === -1 ? '前' : '') + g.tj;
}

/* ロスター表の「ブレ」セル。DDI と帯内パーセンタイルを縦に積む。
   ★ 生の DDI だけを並べると出番の長い選手が一律に低く見えるので、
     パーセンタイルを必ず添える（DDI_2627.md §7） */
function ddiCell(p) {
  if (p.ddi === null || p.ddi === undefined) {
    return '<span class="dim">—</span>';
  }
  const pct = (p.ddip === null || p.ddip === undefined)
    ? '' : `<span class="pct">(${p.ddip.toFixed(0)})</span>`;
  return `<span class="ddiv">${p.ddi.toFixed(1)}</span>${pct}`;
}

/* 率は .561 の形で出す（頭の 0 を落とす） */
const pc = (v) => (v === null || v === undefined)
  ? '<span class="dim">—</span>' : Number(v).toFixed(3).replace(/^0/, '');

/* ------------------------------------------------------------- 日程 */

async function renderSchedule(dateArg) {
  const sc = await load('schedule');
  await results();
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
      <button id="week">今週 ▾</button>
      <span class="spacer"></span>
      <span class="count">${fmtDate(date)} · ${onDay.length} 試合</span>
    </div>

    ${onDay.length ? `<div class="games">${onDay.map(gameRow).join('')}</div>`
      : `<p class="empty">この日は試合がない。</p>`}
  `;

  document.getElementById('prev').onclick = () => go(`#/d/${prev}`);
  document.getElementById('next').onclick = () => go(`#/d/${next}`);
  document.getElementById('open').onclick = () => go(`#/d/${first}`);
  document.getElementById('week').onclick = () => go(`#/w/${monday(date)}`);
  document.getElementById('pick').onchange = (e) => {
    const v = e.target.value;
    /* 試合の無い日を選んだら、その日以降で最初に試合がある日へ送る */
    go(`#/d/${days.includes(v) ? v : (days.find((d) => d >= v) || last)}`);
  };
}

/* ------------------------------------------------------------- 日程（週） */

async function renderWeek(dateArg) {
  const sc = await load('schedule');
  await results();
  const games = sc.games;
  const days = [...new Set(games.map((g) => g.d))].sort();
  const first = days[0], last = days[days.length - 1];

  /* 既定は今週。シーズン前後で今週に1試合も無ければ、
     試合のある最寄りの週へ送る（空の枠だけ見せても仕方がない） */
  let start = monday(dateArg || todayISO());
  if (!dateArg && !days.some((d) => d >= start && d <= shiftDate(start, 6))) {
    start = monday(days.find((d) => d >= todayISO()) || last);
  }
  if (start < monday(first)) start = monday(first);
  if (start > monday(last)) start = monday(last);

  const week = WEEK(start);
  const end = week[6];
  const inWeek = games.filter((g) => g.d >= start && g.d <= end);

  /* 前週 / 翌週は週単位。試合のある週が先に無ければ押せない */
  const prev = days.some((d) => d < start) ? shiftDate(start, -7) : null;
  const next = days.some((d) => d > end) ? shiftDate(start, 7) : null;
  const thisWeek = monday(todayISO());

  view.innerHTML = `
    <h1>今週の試合</h1>
    <p class="sub">
      ${esc(sc.season)} レギュラーシーズン
      ${start === thisWeek ? '・<strong>今週</strong>' : ''}
    </p>

    <div class="datebar">
      <button id="prev" ${prev ? '' : 'disabled'}>← 前週</button>
      <button id="now" class="today">今週</button>
      <button id="next" ${next ? '' : 'disabled'}>翌週 →</button>
      <button id="day">日別 ▾</button>
      <span class="spacer"></span>
      <span class="count">
        ${fmtDate(start)} 〜 ${fmtDate(end)} · ${inWeek.length} 試合
      </span>
    </div>

    <div class="weekgrid">
      ${week.map((d) => {
        const gs = inWeek.filter((g) => g.d === d);
        return `<section class="weekday ${d === todayISO() ? 'is-today' : ''}">
          <h2><a href="#/d/${d}">${fmtDate(d)}</a>
            <span class="dim">${gs.length ? `${gs.length} 試合` : '—'}</span>
          </h2>
          ${gs.length ? `<div class="games">${gs.map(gameRow).join('')}</div>`
            : `<p class="empty">試合なし</p>`}
        </section>`;
      }).join('')}
    </div>`;

  document.getElementById('prev').onclick = () => go(`#/w/${prev}`);
  document.getElementById('next').onclick = () => go(`#/w/${next}`);
  document.getElementById('now').onclick = () => go(`#/w/${thisWeek}`);
  document.getElementById('day').onclick = () => go('#/');
}

/* ★ `.map(gameRow)` で呼ぶので引数を増やせない。結果は RESULTS から引く */
function gameRow(g) {
  const r = (RESULTS || {})[g.game_id];
  const done = r && r.ap !== null && r.ap !== undefined
                 && r.hp !== null && r.hp !== undefined;
  const ot = done && r.np > 4
    ? `<span class="badge">OT${r.np - 4 > 1 ? r.np - 4 : ''}</span>` : '';
  /* ★ `p: 0` は「個別ページを作っていない試合」。容量のため一部のチームが
     絡む試合はページを作っていない（tools/build_games.py の EXCLUDE_TRI）。
     スコアは索引にあるので出すが、リンクにはしない */
  const page = done && r.p !== 0;
  const score = `<span class="tri${r.ap > r.hp ? ' win' : ''}">${esc(g.a)}</span>
     <span class="pts${r.ap > r.hp ? ' win' : ''}">${r.ap}</span>
     <span class="at">－</span>
     <span class="pts${r.hp > r.ap ? ' win' : ''}">${r.hp}</span>
     <span class="tri${r.hp > r.ap ? ' win' : ''}">${esc(g.h)}</span>`;
  /* 終わった試合は対戦の部分がそのまま試合ページへの入口。
     まだの試合は従来どおりチームページへ */
  const match = page
    ? `<a class="result" href="#/game/${esc(g.game_id)}">${score}</a>${ot}`
    : done
      ? `<span class="result nolink" title="この試合は個別ページを作っていない"
           >${score}</span>${ot}`
      : `<a href="#/team/${esc(g.a)}">${esc(g.a)}</a>
         <span class="at">＠</span>
         <a href="#/team/${esc(g.h)}">${esc(g.h)}</a>`;
  return `<div class="game${done ? ' is-done' : ''}">
    <div class="tip">
      <span class="et">${esc(g.t || '')}</span>
      <span class="jst">${esc(jst(g))}</span>
    </div>
    <div class="match">
      ${match}
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

  /* 既定は前季 MPG の多い順。出場が無い選手（null）は末尾へ回す。
     元配列は破壊しない（キャッシュした rosters.json をそのまま持っている） */
  const sorted = [...ps].sort((a, b) => {
    if (a.mpg == null && b.mpg == null) return 0;
    if (a.mpg == null) return 1;
    if (b.mpg == null) return -1;
    return b.mpg - a.mpg;
  });

  return `<div class="wrap"><table>
    <thead><tr>
      <th class="n">#</th><th>選手</th><th>Pos</th><th>身長</th>
      <th class="n">体重</th><th class="n">年齢</th><th class="n">年数</th>
      <th class="n">試合</th><th class="n">MPG</th><th class="n">PPG</th>
      <th class="n">RPG</th><th class="n">APG</th>
      <th class="n">ブレ<span class="hdrsub">${esc(prev)}</span></th>
    </tr></thead>
    <tbody>
    ${sorted.map((p) => `<tr>
      <td class="n dim">${esc(p.num ?? '')}</td>
      <td><a href="#/p/${esc(p.id)}">${esc(p.name)}</a>
        ${p.tw ? '<span class="badge">TW</span>' : ''}
        ${isNew(p) ? '<span class="badge new">new</span>' : ''}</td>
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
      <td class="n">${ddiCell(p)}</td>
    </tr>`).join('')}
    </tbody>
  </table></div>
  <p class="sub" style="margin-top:12px">
    試合〜APG は <strong>${esc(prev)}</strong> レギュラーシーズンの平均。
    <strong>MPG の多い順</strong>に並べている。
    「—」は前季に出場が無い選手（新人・新規契約）で、末尾にまとめている。
    TW = two-way 等の補足契約。
  </p>
  <p class="sub" style="margin-top:8px">
    <strong>ブレ</strong>は起用ブレ指数（DDI、${esc(prev)} の1季）。
    1試合ごとの出場時間の散らばりで、リーグ平均が 100。
    小さいほど出番が読める。
    ★ 出場時間が長い選手ほど低めに出るので、
    <strong>選手どうしを比べるなら括弧内の帯内パーセンタイル</strong>
    （同じ出場時間帯の中での順位。0 に近いほど安定）を見ること。
    試合数が少ない選手は順位を出していない。
    各選手のページに期間別の値と読み方がある。
  </p>`;
}

function teamSchedule(gs, tri) {
  if (!gs.length) return `<p class="empty">日程が無い。</p>`;
  const t = todayISO();
  return `<div class="wrap"><table>
    <thead><tr><th>日付</th><th class="n">ET</th><th class="n">日本時間</th>
      <th>対戦</th><th>H/A</th><th>会場</th><th>TV</th></tr></thead>
    <tbody>
    ${gs.map((g) => {
      const home = g.h === tri;
      const opp = home ? g.a : g.h;
      return `<tr${g.d < t ? ' class="dim"' : ''}>
        <td>${fmtDate(g.d)}</td>
        <td class="n dim">${esc(g.t || '')}</td>
        <td class="n">${esc(jst(g))}</td>
        <td><a href="#/team/${esc(opp)}">${esc(opp)}</a>
            ${g.label ? `<span class="badge">${esc(g.label)}</span>` : ''}</td>
        <td class="dim">${home ? 'ホーム' : 'アウェイ'}</td>
        <td class="dim" style="font-size:12px">${esc(g.city || '')}</td>
        <td class="dim">${esc(g.tv || '')}</td>
      </tr>`;
    }).join('')}
    </tbody></table></div>`;
}

/* ------------------------------------------------------------- 選手 */

/* ロスターから選手を探す。チーム名も要るので tri ごと返す */
function findPlayer(rost, id) {
  for (const [tri, ps] of Object.entries(rost.teams)) {
    const p = ps.find((x) => String(x.id) === String(id));
    if (p) return { p, tri };
  }
  return null;
}

async function renderPlayer(id) {
  const [teams, rost] = await Promise.all([load('teams'), load('rosters')]);
  const hit = findPlayer(rost, id);
  const team = hit ? teams.find((t) => t.tri === hit.tri) : null;

  /* 成績は選手ごとの JSON。2014-15 以降に出場が無い選手はファイルが無い */
  let car = null;
  try {
    car = await load(`players/${id}`);
  } catch (e) {
    if (!hit) {
      view.innerHTML = `<p class="err">選手 ${esc(id)} が無い。</p>`;
      return;
    }
  }

  const name = (hit && hit.p.name) || (car && car.name) || id;
  /* 期待値モデルは MP を状態として持つ。選手が変わったら 30 分に戻す */
  curPlayer = car;
  curMp = 30;
  const p = hit ? hit.p : null;

  view.innerHTML = `
    <div class="teamhead stick">
      <h1>${esc(name)}</h1>
      ${p && p.num ? `<span class="tri">#${esc(p.num)}</span>` : ''}
      ${team ? `<span class="sub" style="margin:0">
        <a href="#/team/${esc(team.tri)}">${esc(team.full_name)}</a>
      </span>` : ''}
    </div>
    ${p ? `<p class="sub">
      ${[p.pos, p.ht, p.wt ? `${p.wt} lb` : null,
         p.age ? `${Math.round(p.age)} 歳` : null,
         p.exp === 'R' ? 'ルーキー' : (p.exp ? `${p.exp} 年目` : null),
         p.school].filter(Boolean).map(esc).join(' · ')}
    </p>` : ''}
    ${car ? careerTable(car)
      : `<p class="empty">2021-22 以降の出場記録が無い。</p>`}
    ${car ? distBlock(car) : ''}
    ${car ? modelBlock(car) : ''}`;

  bindModel();
}

function careerTable(car) {
  const ST = { R: '', P: 'プレーオフ', I: 'プレーイン' };
  const row = (s) => `<tr class="${s.label ? 'total' : ''}">
    <td>${esc(s.label || s.y)}</td>
    <td class="dim">${esc(s.teams || '')}
      ${s.st && ST[s.st] ? `<span class="badge">${ST[s.st]}</span>` : ''}</td>
    <td class="n">${s.g}</td>
    <td class="n">${s.gs ?? '<span class="dim">—</span>'}</td>
    <td class="n">${num(s.mpg)}</td>
    <td class="n">${num(s.fgm)}</td><td class="n">${num(s.fga)}</td>
    <td class="n">${pc(s.fg)}</td>
    <td class="n">${num(s.tpm)}</td><td class="n">${num(s.tpa)}</td>
    <td class="n">${pc(s.tp)}</td>
    <td class="n">${num(s.ftm)}</td><td class="n">${num(s.fta)}</td>
    <td class="n">${pc(s.ft)}</td>
    <td class="n">${num(s.oreb)}</td><td class="n">${num(s.dreb)}</td>
    <td class="n">${num(s.reb)}</td>
    <td class="n">${num(s.ast)}</td><td class="n">${num(s.stl)}</td>
    <td class="n">${num(s.blk)}</td><td class="n">${num(s.tov)}</td>
    <td class="n">${num(s.pf)}</td>
    <td class="n"><strong>${num(s.pts)}</strong></td>
    <td class="n">${pc(s.ts)}</td>
  </tr>`;

  /* レギュラーが先。プレーオフなどは畳んで下に置く */
  const reg = car.seasons.filter((s) => s.st === 'R');
  const post = car.seasons.filter((s) => s.st !== 'R');

  const head = `<thead><tr>
      <th>シーズン</th><th>チーム</th><th class="n">試合</th>
      <th class="n">先発</th><th class="n">MP</th>
      <th class="n">FGM</th><th class="n">FGA</th><th class="n">FG%</th>
      <th class="n">3PM</th><th class="n">3PA</th><th class="n">3P%</th>
      <th class="n">FTM</th><th class="n">FTA</th><th class="n">FT%</th>
      <th class="n">OR</th><th class="n">DR</th><th class="n">REB</th>
      <th class="n">AST</th><th class="n">STL</th><th class="n">BLK</th>
      <th class="n">TOV</th><th class="n">PF</th><th class="n">PTS</th>
      <th class="n">TS%</th>
    </tr></thead>`;

  return `<div class="wrap"><table class="career">
    ${head}
    <tbody>
      ${reg.map(row).join('')}
      ${car.career ? row(car.career) : ''}
    </tbody>
  </table></div>
  ${post.length ? `<details class="post">
    <summary>ポストシーズン（${post.length} シーズン）</summary>
    <div class="wrap"><table class="career">
      ${head}
      <tbody>${post.map(row).join('')}</tbody>
    </table></div>
  </details>` : ''}
  <p class="sub" style="margin-top:12px">
    試合・先発以外は1試合平均。通算はレギュラーシーズンのみ。
    FG% / 3P% / FT% / TS% は<strong>合計から計算</strong>している
    （試合ごとの率の平均ではない）。
    <strong>${esc(car.first)}</strong> 以降のシーズンのみ。
  </p>`;
}

/* --------------------------------------------------- 出場時間の分布 */

/* 1枚ぶんのヒストグラム。
   y は「試合に占める割合」。1シーズンと3シーズンでは母数が3倍ちがうので、
   件数のままだと形を比べられない。x は 0〜48分で両方そろえる。 */
/* 画面が狭いときは viewBox も小さく取る。
   viewBox は実寸ではなく比率なので、横 640 のまま 375px に縮めると
   目盛りの文字まで 0.6 倍になって読めなくなる */
const narrow = () => window.innerWidth < 560;

function histSvg(h, binW, title, note, top, b0, b1) {
  const sm = narrow();
  const W = sm ? 330 : 640, H = sm ? 190 : 176;
  const L = sm ? 30 : 42, R = sm ? 8 : 14, T = 30, B = 30;
  const iw = W - L - R, ih = H - T - B;
  const nb = h.bins.length;
  /* ★ 空の箱は描かずに詰める。b0/b1 は2枚で共通なので形は比べられる。
     出番の短い選手は 0 分側にも試合があるので、一律に切ることはしない */
  const shown = b1 - b0 + 1;
  const bw = iw / shown;

  /* ★ 上端は2枚で共通。panel ごとに変えると形の比較が歪む */
  const y = (v) => T + ih - (v / top) * ih;
  const xOf = (min) => L + ((min - b0 * binW) / (shown * binW)) * iw;

  const bars = h.bins.map((c, i) => {
    if (!c || i < b0 || i > b1) return '';
    const hgt = Math.max(1, ih - (y(c / h.n) - T));
    /* 棒どうしは 2px あけて、地の色が見えるようにする */
    const w = Math.max(1, bw - 2);
    const r = Math.min(3, w / 2);
    const lo = i * binW, hi = i === nb - 1 ? '+' : `–${(i + 1) * binW}`;
    return `<rect x="${(L + (i - b0) * bw + 1).toFixed(1)}" y="${
      y(c / h.n).toFixed(1)}"
      width="${w.toFixed(1)}" height="${hgt.toFixed(1)}" rx="${r.toFixed(1)}"
      fill="var(--accent)"><title>${lo}${hi} 分: ${c} 試合（${
      (c / h.n * 100).toFixed(0)}%）</title></rect>`;
  }).join('');

  /* 目盛りは描いた範囲の中の切りのいい分数だけ */
  const minLo = b0 * binW, minHi = (b1 + 1) * binW;
  const step = sm ? 12 : 6;
  const ticks = [];
  for (let m = Math.ceil(minLo / step) * step; m <= minHi; m += step) {
    ticks.push(m);
  }

  /* 中央値だけ直に書く。棒ごとに数字は振らない */
  const mx = xOf(h.med);

  return `<figure class="hist">
    <figcaption>
      <span class="t">${esc(title)}</span>
      <span class="dim">${esc(note)} · ${h.n} 試合 · 中央値 ${h.med} 分</span>
    </figcaption>
    <svg viewBox="0 0 ${W} ${H}" role="img"
         aria-label="${esc(title)} の出場時間の分布。${h.n} 試合、中央値 ${h.med} 分">
      <line x1="${L}" y1="${T}" x2="${W - R}" y2="${T}" class="grid"/>
      <line x1="${L}" y1="${T + ih}" x2="${W - R}" y2="${T + ih}" class="axis"/>
      <text x="${L - 6}" y="${T + 4}" class="tick end">${
        (top * 100).toFixed(0)}%</text>
      <text x="${L - 6}" y="${T + ih + 4}" class="tick end">0</text>
      ${bars}
      <line x1="${mx.toFixed(1)}" y1="${T - 6}" x2="${mx.toFixed(1)}"
            y2="${T + ih}" class="med-halo"/>
      <line x1="${mx.toFixed(1)}" y1="${T - 6}" x2="${mx.toFixed(1)}"
            y2="${T + ih}" class="med"/>
      <text x="${mx.toFixed(1)}" y="${T - 10}" class="tick mid lab">中央値 ${
        h.med}</text>
      ${ticks.map((m, i) => `<text x="${xOf(m).toFixed(1)}"
        y="${T + ih + 16}" class="tick mid">${
        i === ticks.length - 1 ? m + '分' : m}</text>`).join('')}
    </svg>
  </figure>`;
}

/* 起用ブレ指数（DDI）。分布の図の真下に、対応する期間のぶんを置く。
   which = '25'（直近1シーズン）か '3'（直近3シーズン）。
   ★ 生の DDI は出場時間の水準と独立ではない（相関 −0.16）。
     選手どうしを並べるのは帯内パーセンタイルの側。 */
function ddiRow(dd, which) {
  if (!dd) return '';
  if (dd.nodata) {
    return `<p class="ddi none">起用ブレ DDI
      <span class="dim">データなし（2023-24 以降に出場が無い）</span></p>`;
  }
  const v = which === '25' ? dd.d25 : dd.d3;
  const p = which === '25' ? dd.p25 : dd.p3;
  const n = which === '25' ? dd.n25 : dd.n3;
  const need = which === '25' ? 20 : 40;
  if (v === null || v === undefined) return '';

  /* 100 がリーグの真ん中。下＝安定、上＝ブレが大きい */
  const side = v < 100 ? '安定寄り' : 'ブレ大きめ';

  return `<div class="ddi">
    <div class="v">
      <span class="num">${v.toFixed(1)}</span>
      <span class="dim">起用ブレ DDI<strong>${
        which === '25' ? '（1シーズン）' : '（3シーズン）'}</strong>
        · リーグ平均 100 · ${esc(side)}</span>
    </div>
    ${p === null || p === undefined ? `<p class="dim note">
        帯内の順位は出していない（この期間の出場が ${n} 試合で、
        ${need} 試合に足りない）</p>`
      : `<div class="meter" role="img"
           aria-label="${esc(dd.band)}分帯の中で ${p} パーセンタイル">
          <div class="scale">
            <span class="end">0</span>
            <span class="track"><i style="left:${p.toFixed(1)}%"></i></span>
            <span class="end">100</span>
          </div>
          <p class="dim note">
            <strong>${esc(dd.band)} 分帯</strong>の中で
            <strong>${p.toFixed(0)} パーセンタイル</strong>
            （0 に近いほど安定・100 に近いほどブレが大きい）${
            dd.merged ? '・帯を合併して算出' : ''}</p>
        </div>`}
  </div>`;
}

function ddiNote(dd) {
  if (!dd || dd.nodata) return '';
  return `<details class="post ddi-note">
    <summary>DDI の読み方</summary>
    <div class="sub">
      <p>
        1試合ごとの出場時間が、その時点で見込まれる時間からどれだけ
        散らばったかを指数にしたもの。<strong>100 がリーグの真ん中</strong>で、
        全体の SD は 7 前後。大きいほど試合ごとの出番が読みにくい。
      </p>
      <p>
        ★ <strong>欠場そのものは入っていない。</strong>
        「出た試合の出場時間のブレ」なので、ロード管理で休む選手でも
        出れば決まった時間を踏むなら DDI は小さく出る。
      </p>
      <p>
        ★ <strong>選手どうしを並べるならパーセンタイルの側を見る。</strong>
        生の DDI は出場時間の水準と完全には独立ではなく（相関 −0.16）、
        出番の長い選手ほど低めに出る。
        そのため同じ出場時間帯の中での順位を併記している。
      </p>
    </div>
  </details>`;
}

/* ------------------------------------------------- 期待値モデル */

/* 直近3季（r3）の合計から「1分あたり」を出す。
   ★ 通算（2021-22 以降）ではなく 2023-24 以降だけを使う。
     役割が変わった選手で、古い季の率を混ぜないため。
   per game で持っているが、割れば1分あたりは同じ（g が約分される）。
   p は得点でも 1 未満なので、分を試行とする二項分布が成り立つ。 */
const STATS = [
  { k: 'pts', label: '得点' },
  { k: 'ast', label: 'アシスト' },
  { k: 'reb', label: 'リバウンド' },
];

/* 二項分布の確率質量。n ≤ 48 なので漸化式で十分
   pmf[0] = (1-p)^n,  pmf[k] = pmf[k-1] × (n-k+1)/k × p/(1-p) */
function binomPmf(n, p) {
  if (p <= 0) { const a = new Array(n + 1).fill(0); a[0] = 1; return a; }
  if (p >= 1) { const a = new Array(n + 1).fill(0); a[n] = 1; return a; }
  const out = new Array(n + 1);
  out[0] = Math.pow(1 - p, n);
  const r = p / (1 - p);
  for (let k = 1; k <= n; k++) out[k] = out[k - 1] * ((n - k + 1) / k) * r;
  return out;
}

/* 1つの項目ぶん。mp 分出たときの分布と、ライン未満（under）の確率 */
function statModel(car, st, mp) {
  const c = car.r3;
  const lam = c[st.k] / c.mpg;          /* 1分あたりの期待値 */
  const p = Math.min(1, Math.max(0, lam));
  const n = Math.max(1, Math.round(mp));
  const pmf = binomPmf(n, p);

  /* 累積。under(L) = P(X ≤ floor(L)) */
  const cdf = [];
  let acc = 0;
  for (let k = 0; k <= n; k++) { acc += pmf[k]; cdf[k] = Math.min(1, acc); }

  const mean = n * p;
  const sd = Math.sqrt(n * p * (1 - p));
  const lo = Math.max(0, Math.floor(mean - 4 * sd));
  const hi = Math.min(n, Math.ceil(mean + 4 * sd) + 1);

  /* ベッティングのラインに合わせて .5 刻みで並べる（同点が出ない） */
  const base = Math.round(mean);
  const lines = [-1.5, -0.5, 0.5, 1.5]
    .map((d) => base + d).filter((L) => L > 0);

  return { lam, p, n, pmf, cdf, mean, sd, lo, hi, lines, st };
}

function modelChart(m) {
  const sm = narrow();
  const W = sm ? 330 : 640, H = sm ? 170 : 160;
  const L = sm ? 30 : 42, R = sm ? 8 : 14, T = 26, B = 28;
  const iw = W - L - R, ih = H - T - B;
  const nb = m.hi - m.lo + 1;
  const bw = iw / nb;
  const top = Math.max(0.02, Math.ceil(Math.max(
    ...m.pmf.slice(m.lo, m.hi + 1)) * 20) / 20);
  const y = (v) => T + ih - (v / top) * ih;
  const xMid = (k) => L + (k - m.lo + 0.5) * bw;

  const bars = [];
  for (let k = m.lo; k <= m.hi; k++) {
    const v = m.pmf[k] || 0;
    if (v <= 0) continue;
    const w = Math.max(1, bw - 2);
    const hgt = Math.max(1, ih - (y(v) - T));
    bars.push(`<rect x="${(L + (k - m.lo) * bw + 1).toFixed(1)}"
      y="${y(v).toFixed(1)}" width="${w.toFixed(1)}" height="${hgt.toFixed(1)}"
      rx="${Math.min(3, w / 2).toFixed(1)}" fill="var(--accent)"
      ><title>${k} ${esc(m.st.label)}: ${(v * 100).toFixed(1)}%
 ／ ${k} 以下に収まる確率 ${(m.cdf[k] * 100).toFixed(1)}%</title></rect>`);
  }

  /* 目盛りは端と中央だけ。棒ごとに数字は振らない */
  const ticks = [m.lo, Math.round((m.lo + m.hi) / 2), m.hi]
    .filter((v, i, a) => a.indexOf(v) === i);
  const mx = L + (m.mean - m.lo + 0.5) * bw;

  return `<svg viewBox="0 0 ${W} ${H}" role="img"
      aria-label="${esc(m.st.label)}の分布。期待値 ${m.mean.toFixed(1)}">
    <line x1="${L}" y1="${T}" x2="${W - R}" y2="${T}" class="grid"/>
    <line x1="${L}" y1="${T + ih}" x2="${W - R}" y2="${T + ih}" class="axis"/>
    <text x="${L - 6}" y="${T + 4}" class="tick end">${
      (top * 100).toFixed(0)}%</text>
    <text x="${L - 6}" y="${T + ih + 4}" class="tick end">0</text>
    ${bars.join('')}
    <line x1="${mx.toFixed(1)}" y1="${T - 4}" x2="${mx.toFixed(1)}"
          y2="${T + ih}" class="med-halo"/>
    <line x1="${mx.toFixed(1)}" y1="${T - 4}" x2="${mx.toFixed(1)}"
          y2="${T + ih}" class="med"/>
    <text x="${mx.toFixed(1)}" y="${T - 8}" class="tick mid lab">期待値 ${
      m.mean.toFixed(1)}</text>
    ${ticks.map((k) => `<text x="${xMid(k).toFixed(1)}" y="${T + ih + 16}"
      class="tick mid">${k}</text>`).join('')}
  </svg>`;
}

function statBlock(car, st, mp) {
  const m = statModel(car, st, mp);
  return `<figure class="model">
    <figcaption>
      <span class="t">${esc(st.label)}</span>
      <span class="dim">1分あたり ${m.lam.toFixed(3)} ×
        ${m.n} 分 = 期待値 <strong>${m.mean.toFixed(1)}</strong>
        （SD ${m.sd.toFixed(1)}）</span>
    </figcaption>
    ${modelChart(m)}
    <table class="under"><thead><tr>
      <th>ライン</th>${m.lines.map((L) => `<th class="n">${L.toFixed(1)}</th>`)
        .join('')}
    </tr></thead><tbody><tr>
      <th>under</th>${m.lines.map((L) => `<td class="n">${
        (m.cdf[Math.floor(L)] * 100).toFixed(1)}%</td>`).join('')}
    </tr></tbody></table>
  </figure>`;
}

/* MP を変えたときに作り直すのはこの中だけ */
function modelInner(car, mp) {
  return `<div class="mpbar">
      <button data-mp="-5">−5</button>
      <button data-mp="-1">−1</button>
      <input type="range" id="mprange" min="1" max="48" step="1" value="${mp}">
      <button data-mp="1">+1</button>
      <button data-mp="5">+5</button>
      <span class="now"><strong>${mp}</strong> 分</span>
      <button data-mp="reset" class="today">30 分に戻す</button>
    </div>
    ${STATS.map((st) => statBlock(car, st, mp)).join('')}`;
}

let curPlayer = null;
let curMp = 30;

function modelBlock(car) {
  /* 2023-24 以降に出場が無い選手は率が出せないので、この枠ごと出さない */
  if (!car || !car.r3 || !car.r3.mpg) return '';
  return `<section class="modelbox">
    <h2>出場時間からの期待値モデル</h2>
    <p class="sub">
      <strong>${esc(car.r3.label)}</strong>のレギュラーシーズン
      （${car.r3.g} 試合）の合計から<strong>1分あたりの期待値</strong>を出し、
      <strong>1分を1回の試行とする二項分布</strong>で、
      指定した出場時間のときの分布とライン未満（under）の確率を出す。
    </p>
    <div id="model">${modelInner(car, curMp)}</div>
    <details class="post">
      <summary>このモデルの前提と限界</summary>
      <div class="sub">
        <p>
          1分あたりの率は<strong>直近3季の合計 ÷ 同じ期間の出場時間</strong>。
          上の出場時間の分布と同じ範囲を使っている。
          それより古い季（2021-22・2022-23）は入れていない。
          直近の調子や相手、ホーム／アウェイは見ていない。
        </p>
        <p>
          ★ <strong>得点は2点・3点とまとまって入る</strong>ので、
          1分1回の試行に置き換えるとばらつきを小さく見積もる。
          得点の under 確率は実際より極端（0% / 100% 寄り）に出る。
          アシストとリバウンドは1つずつ増えるので、この前提とよく合う。
        </p>
        <p>
          ★ 実際の試合は二項分布より<strong>ばらつきが大きい</strong>
          （相手・役割・ファウル・試合展開）。
          ここでの確率は目安で、そのまま賭けの期待値には使えない。
        </p>
        <p>
          ★ 出場時間そのものの不確実性は入っていない。
          「30 分出たら」という条件つきの分布なので、
          実際に何分出るかは上の分布と DDI のほうを見ること。
        </p>
      </div>
    </details>
  </section>`;
}

/* MP のつまみ。#model の中だけ作り直す */
function bindModel() {
  const box = document.getElementById('model');
  if (!box) return;
  const redraw = () => {
    box.innerHTML = modelInner(curPlayer, curMp);
    bindModel();
  };
  box.querySelectorAll('.mpbar button').forEach((b) => {
    b.onclick = () => {
      const d = b.dataset.mp;
      curMp = d === 'reset' ? 30
        : Math.min(48, Math.max(1, curMp + Number(d)));
      redraw();
    };
  });
  const r = document.getElementById('mprange');
  if (r) r.oninput = (e) => { curMp = Number(e.target.value); redraw(); };
}

function distBlock(car) {
  const d = car.dist;
  if (!d || (!d.s1 && !d.s3)) return '';
  /* 2枚で同じ y 軸を使う。片方だけ高いと形が違って見えてしまう */
  const peak = Math.max(...[d.s1, d.s3].filter(Boolean)
    .map((h) => Math.max(...h.bins) / h.n));
  const top = Math.max(0.05, Math.ceil(peak * 20) / 20);
  /* 両端の空の箱を落として横に広げる。2枚で同じ範囲を使う */
  const hs = [d.s1, d.s3].filter(Boolean);
  const nb = hs[0].bins.length;
  let b0 = nb - 1, b1 = 0;
  for (const h of hs) {
    for (let i = 0; i < nb; i++) {
      if (h.bins[i]) { if (i < b0) b0 = i; if (i > b1) b1 = i; }
    }
  }
  if (b0 > b1) { b0 = 0; b1 = nb - 1; }
  return `<section class="dist">
    <h2>出場時間の分布</h2>
    <p class="sub">
      1試合ごとの出場時間を2分刻みで数えたもの。レギュラーシーズンのみ。
      平均だけでは「毎試合 30 分」と「40 分と出番なしの往復」を区別できない。
    </p>
    ${d.s1 ? histSvg(d.s1, d.bin, '直近1シーズン', car.d1, top, b0, b1)
      + ddiRow(car.ddi, '25') : ''}
    ${d.s3 ? histSvg(d.s3, d.bin, '直近3シーズン', car.d3, top, b0, b1)
      + ddiRow(car.ddi, '3') : ''}
    ${ddiNote(car.ddi)}
  </section>`;
}

/* ------------------------------------------------------------- 経路 */

function go(hash) {
  if (location.hash === hash) route();
  else location.hash = hash;
}

/* ------------------------------------------------------------- レポート */

/* 日次レポート。中身は publish 側（nba_live/tools/fetch_reports.py）が
   Markdown から HTML にして JSON に詰めている。
   ★ ここで Markdown を解釈しない。サイトは依存ライブラリなしを保つ。 */

async function renderReports() {
  const idx = await load('reports_index');
  const rows = (idx.reports || []);
  if (!rows.length) {
    view.innerHTML = '<h1>日次レポート</h1><p class="sub">まだ無い。</p>';
    return;
  }
  view.innerHTML = `
    <h1>日次レポート</h1>
    <p class="sub">${rows.length} 日分。ET の試合日ごとに、インジャリーレポートの
      status 変化・ラインの動き・報道を並べたもの。</p>
    <ul class="reports">
      ${rows.map((r) => `
        <li>
          <a href="#/report/${esc(r.day)}">${esc(r.day)}</a>
          ${r.summary ? `<span class="sub">${esc(r.summary)}</span>` : ''}
        </li>`).join('')}
    </ul>`;
}

async function renderReport(day) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) {
    view.innerHTML = '<p class="err">日付が不正。</p>';
    return;
  }
  let rep;
  try {
    rep = await load(`reports/${day}`);
  } catch (e) {
    view.innerHTML = `<p class="err">${esc(day)} のレポートが無い。
      <a href="#/reports">一覧へ</a></p>`;
    return;
  }
  view.innerHTML = `
    <p class="sub"><a href="#/reports">&larr; レポート一覧</a></p>
    <div class="report">${rep.html}</div>`;
}

/* ------------------------------------------------------------- 試合 */

/* 試合全体の長さ（秒）。延長は 5 分 = 300 秒ずつ */
const gameSec = (np) => 2880 + Math.max(0, np - 4) * 300;

/* ピリオドの境目（秒）。ガントと得点推移の目盛りに使う */
function bounds(np) {
  const out = [];
  for (let k = 1; k < np; k++) out.push(k <= 4 ? k * 720 : 2880 + (k - 4) * 300);
  return out;
}

const STATUS_CLS = {
  Out: 'st-out', Doubtful: 'st-d', Questionable: 'st-q',
  Probable: 'st-p', Available: 'st-a',
};
const STATUS_ORDER = ['Out', 'Doubtful', 'Questionable', 'Probable', 'Available'];
const stTag = (v) => v
  ? `<span class="st ${STATUS_CLS[v] || ''}">${esc(v)}</span>`
  : '<span class="dim">—</span>';

const mmss = (sec) => (sec === null || sec === undefined) ? '—'
  : `${Math.floor(sec / 60)}:${String(Math.round(sec % 60)).padStart(2, '0')}`;

/* クォーター別得点。
   ★ 出どころを混ぜている。Q1-4 は公式の line_score、延長は PBP 集計しか無い。
     PBP から採った欄には印を付ける（`quarter_src`） */
function quarterTable(g) {
  const tris = [g.away, g.home];
  const head = g.periods.map((x) => `<th class="n">${esc(x)}</th>`).join('');
  const rows = tris.map((tri) => {
    const q = g.quarters[tri] || [];
    const src = g.quarter_src[tri] || [];
    const tot = q.reduce((a, b) => a + (b || 0), 0);
    const cells = q.map((v, k) => {
      const pbp = src[k] === 'pbp';
      const t = pbp ? ' title="PBP 集計（公式のクォーター別には延長の欄が無い）"' : '';
      const val = (v === null || v === undefined) ? '<span class="dim">—</span>' : v;
      return `<td class="n${pbp ? ' frompbp' : ''}"${t}>${val}</td>`;
    }).join('');
    return `<tr><th>${esc(tri)}</th>${cells}<td class="n tot">${tot}</td></tr>`;
  }).join('');
  return `<div class="wrap"><table class="qtab">
    <thead><tr><th>チーム</th>${head}<th class="n">計</th></tr></thead>
    <tbody>${rows}</tbody></table></div>`;
}

/* 得点差の推移。ホーム側から見た差を折れ線で出す */
function scorePath(g) {
  const path = g.score_path || [];
  if (path.length < 2) return '';
  const T = gameSec(g.periods.length);
  const W = 1000, H = 150, PAD = 18;
  const bs = bounds(g.periods.length);
  const mx = Math.max(10, ...path.map(([, h, a]) => Math.abs(h - a)));
  const X = (sec) => (sec / T) * W;
  const Y = (m) => (H / 2) - (m / mx) * (H / 2 - PAD);
  const pts = path.map(([sec, h, a]) => `${X(sec).toFixed(1)},${Y(h - a).toFixed(1)}`)
    .join(' ');
  const grid = bs
    .map((b) => `<line x1="${X(b)}" y1="0" x2="${X(b)}" y2="${H}" class="gl"/>`)
    .join('');
  const labels = g.periods.map((nm, k) => {
    const a = k === 0 ? 0 : bs[k - 1];
    const b = k === g.periods.length - 1 ? T : bs[k];
    return `<text x="${(X(a) + X(b)) / 2}" y="${H - 3}" class="pl">${esc(nm)}</text>`;
  }).join('');
  /* ★ preserveAspectRatio="none" にしてはいけない。横に引き伸ばされて
       ラベルの字まで歪む。等比で拡縮して高さは CSS の auto に任せる */
  return `<svg class="spath" viewBox="0 0 ${W} ${H}">
    ${grid}
    <line x1="0" y1="${H / 2}" x2="${W}" y2="${H / 2}" class="zero"/>
    <polyline points="${pts}" class="line"/>
    ${labels}
    <text x="6" y="14" class="pl lead">${esc(g.home)} +${mx}</text>
    <text x="6" y="${H - 16}" class="pl lead">${esc(g.away)} +${mx}</text>
  </svg>`;
}

/* ラインナップ推移。選手ごとの出場区間を帯で出す（HTML のまま。SVG にしない）。
   ★ 検算に落ちた試合では呼ばない。ピリオド開始5人の推定が外れている可能性があり、
     黙って出すと「ベンチにいた選手がコートにいる」表示になる */
function gantt(g, tri) {
  const list = g.stints[tri] || [];
  if (!list.length) return '';
  const T = gameSec(g.periods.length);
  const bs = bounds(g.periods.length);
  const seps = bs
    .map((b) => `<i class="sep" style="left:${(b / T * 100).toFixed(2)}%"></i>`)
    .join('');
  const rows = list.map((p) => {
    const sec = p.iv.reduce((a, [x, y]) => a + (y - x), 0);
    const bars = p.iv.map(([x, y]) =>
      `<i class="bar" style="left:${(x / T * 100).toFixed(2)}%;`
      + `width:${((y - x) / T * 100).toFixed(2)}%" title="${mmss(x)}〜${mmss(y)}"></i>`
    ).join('');
    return `<div class="row">
      <span class="nm">${esc(p.name)}</span>
      <span class="track">${seps}${bars}</span>
      <span class="mp">${mmss(sec)}</span>
    </div>`;
  }).join('');
  const axis = g.periods.map((nm, k) => {
    const a = k === 0 ? 0 : bs[k - 1];
    const b = k === g.periods.length - 1 ? T : bs[k];
    return `<span style="width:${((b - a) / T * 100).toFixed(2)}%">${esc(nm)}</span>`;
  }).join('');
  return `<div class="gantt">${rows}
    <div class="row axis"><span class="nm"></span>
      <span class="track">${axis}</span><span class="mp"></span></div>
  </div>`;
}

/* ボックススコア。`key` が 'all' なら試合全体、'Q1' などならそのクォーター。
   ★ クォーター別には +/- と USG% を出さない。`player_quarter_fixed` に無く、
     出せない数字を 0 で埋めると「0 だった」と読めてしまう */
function boxTable(g, tri, key) {
  if (key && key !== 'all') return qboxTable(g, tri, key);
  const list = g.box[tri] || [];
  if (!list.length) return '<p class="empty">ボックススコアが無い。</p>';
  const rows = list.map((p) => `<tr>
    <td><a href="#/p/${p.pid}">${esc(p.name)}</a></td>
    <td class="n">${mmss(p.sec)}</td>
    <td class="n b">${p.pts ?? 0}</td>
    <td class="n">${p.reb ?? 0}</td>
    <td class="n">${p.ast ?? 0}</td>
    <td class="n">${p.fgm ?? 0}-${p.fga ?? 0}</td>
    <td class="n">${p.fg3m ?? 0}-${p.fg3a ?? 0}</td>
    <td class="n">${p.ftm ?? 0}-${p.fta ?? 0}</td>
    <td class="n">${p.stl ?? 0}</td>
    <td class="n">${p.blk ?? 0}</td>
    <td class="n">${p.tov ?? 0}</td>
    <td class="n">${p.pf ?? 0}</td>
    <td class="n ${p.pm > 0 ? 'up' : p.pm < 0 ? 'down' : ''}">${
      p.pm > 0 ? '+' : ''}${p.pm ?? 0}</td>
    <td class="n">${(p.usg === null || p.usg === undefined)
      ? '<span class="dim">—</span>' : (p.usg * 100).toFixed(1)}</td>
  </tr>`).join('');
  return `<div class="wrap"><table class="boxtab">
    <thead><tr><th>選手</th><th class="n">分</th><th class="n">得点</th>
      <th class="n">Reb</th><th class="n">Ast</th><th class="n">FG</th>
      <th class="n">3P</th><th class="n">FT</th><th class="n">Stl</th>
      <th class="n">Blk</th><th class="n">TO</th><th class="n">PF</th>
      <th class="n">+/-</th><th class="n">USG%</th></tr></thead>
    <tbody>${rows}</tbody></table></div>`;
}

function qboxTable(g, tri, key) {
  const list = ((g.qbox || {})[tri] || {})[key] || [];
  if (!list.length) {
    return `<p class="empty">${esc(key)} の記録が無い。</p>`;
  }
  const rows = list.map((p) => `<tr>
    <td><a href="#/p/${p.pid}">${esc(p.name)}</a></td>
    <td class="n">${p.sec === null || p.sec === undefined
      ? '<span class="dim">—</span>' : mmss(p.sec)}</td>
    <td class="n b">${p.pts ?? 0}</td>
    <td class="n">${p.reb ?? 0}</td>
    <td class="n">${p.ast ?? 0}</td>
    <td class="n">${p.fgm ?? 0}-${p.fga ?? 0}</td>
    <td class="n">${p.fg3m ?? 0}-${p.fg3a ?? 0}</td>
    <td class="n">${p.ftm ?? 0}-${p.fta ?? 0}</td>
    <td class="n">${p.stl ?? 0}</td>
    <td class="n">${p.blk ?? 0}</td>
    <td class="n">${p.tov ?? 0}</td>
    <td class="n">${p.pf ?? 0}</td>
  </tr>`).join('');
  return `<div class="wrap"><table class="boxtab">
    <thead><tr><th>選手</th><th class="n">分</th><th class="n">得点</th>
      <th class="n">Reb</th><th class="n">Ast</th><th class="n">FG</th>
      <th class="n">3P</th><th class="n">FT</th><th class="n">Stl</th>
      <th class="n">Blk</th><th class="n">TO</th><th class="n">PF</th></tr></thead>
    <tbody>${rows}</tbody></table></div>`;
}

/* injury report。
   ★ 初出と最終の両方を出す。NBA はティップまでに必ず Questionable を
     Out / Available へ解決するので、最終だけだと Questionable が常にゼロになる。
     試合前の不確定さは初出にしか残らない */
function injuryTable(g, tri) {
  const list = (g.injury[tri] || []).slice().sort((x, y) =>
    STATUS_ORDER.indexOf(x.first) - STATUS_ORDER.indexOf(y.first)
    || String(x.name).localeCompare(String(y.name)));
  const out = g.inactive[tri] || [];
  if (!list.length && !out.length) {
    return `<p class="empty">${esc(tri)}: injury report の記録が無い。</p>`;
  }
  const rows = list.map((p) => `<tr>
    <td>${esc(p.name)}</td>
    <td>${stTag(p.first)}</td>
    <td>${(p.final && p.final !== p.first) ? stTag(p.final)
      : '<span class="dim">変化なし</span>'}</td>
    <td class="dim">${esc(p.reason || '')}</td>
  </tr>`).join('');
  const n = {};
  for (const p of list) n[p.first] = (n[p.first] || 0) + 1;
  const summary = STATUS_ORDER.filter((k) => n[k]).map((k) => `${k} ${n[k]}`).join(' / ');
  return `<h3>${esc(tri)}</h3>
    <p class="sub">初出の時点で ${esc(summary || '記載なし')}${
      out.length ? `・実際の欠場 ${out.length} 名` : ''}</p>
    ${list.length ? `<div class="wrap"><table class="injtab">
      <thead><tr><th>選手</th><th>初出</th><th>最終</th><th>理由</th></tr></thead>
      <tbody>${rows}</tbody></table></div>` : ''}
    ${out.length ? `<p class="sub">実際の欠場: ${out.map(esc).join(' / ')}</p>` : ''}`;
}

/* ---- 試合前のオッズ -------------------------------------------------- */

const ODDS_META = {
  ml:     { label: 'マネーライン', unit: '%',
            note: (g) => `${esc(g.home)}（ホーム）が勝つ確率。`, ref: 50 },
  spread: { label: 'スプレッド', unit: '点',
            note: (g) => `${esc(g.home)}（ホーム）のハンディ。負ほどホーム有利。`,
            ref: 0 },
  total:  { label: 'トータル', unit: '点',
            note: () => '両チームの合計得点。', ref: null },
};

const hhmm = (min) => {
  const m = Math.abs(min);
  return m >= 60 ? `${Math.round(m / 60)}時間前` : `${m}分前`;
};

/* 折れ線。`series` は [{name, pts:[[x,y]], cls, dot}]。x は試合開始からの分（負） */
function lineChart(series, ref, unit) {
  const live = series.filter((s) => s.pts && s.pts.length);
  if (!live.length) return '<p class="empty">この系列のデータが無い。</p>';
  const W = 1000, H = 230, L = 52, R = 12, T = 12, B = 26;
  const xs = live.flatMap((s) => s.pts.map((p) => p[0]));
  const ys = live.flatMap((s) => s.pts.map((p) => p[1]));
  let x0 = Math.min(...xs), x1 = Math.max(...xs, 0);
  if (x1 === x0) x1 = x0 + 1;
  let y0 = Math.min(...ys), y1 = Math.max(...ys);
  const pad = (y1 - y0) * 0.12 || 1;
  y0 -= pad; y1 += pad;
  /* ★ 基準線（50% / 0点）に合わせて縦軸を広げない。線が基準から離れている試合で
     上下に空白ができて、肝心の動きが潰れる（スプレッド -7 の試合で実際にそうなった）。
     基準線は範囲に入っているときだけ引く */
  const showRef = (ref !== null && ref !== undefined && ref >= y0 && ref <= y1);
  const X = (v) => L + ((v - x0) / (x1 - x0)) * (W - L - R);
  const Y = (v) => T + (1 - (v - y0) / (y1 - y0)) * (H - T - B);

  /* 目盛り。横は 12 時間ごと、縦は 4 本 */
  const step = (x1 - x0) > 1500 ? 720 : (x1 - x0) > 600 ? 360 : 120;
  const xt = [];
  for (let v = 0; v >= x0; v -= step) xt.push(v);
  const yt = [0, 1, 2, 3, 4].map((k) => y0 + (y1 - y0) * k / 4);

  const grid = xt.map((v) => `<line class="gl" x1="${X(v).toFixed(1)}" y1="${T}"
      x2="${X(v).toFixed(1)}" y2="${H - B}"/>`).join('')
    + yt.map((v) => `<line class="gl" x1="${L}" y1="${Y(v).toFixed(1)}"
      x2="${W - R}" y2="${Y(v).toFixed(1)}"/>`).join('');
  const refLine = !showRef ? ''
    : `<line class="zero" x1="${L}" y1="${Y(ref).toFixed(1)}"
         x2="${W - R}" y2="${Y(ref).toFixed(1)}"/>`;
  const lines = live.map((s) => {
    const d = s.pts.map((p) => `${X(p[0]).toFixed(1)},${Y(p[1]).toFixed(1)}`).join(' ');
    const dots = s.dot ? s.pts.map((p) =>
      `<circle class="pt ${s.cls}" cx="${X(p[0]).toFixed(1)}"
         cy="${Y(p[1]).toFixed(1)}" r="3"/>`).join('') : '';
    return `<polyline class="ln ${s.cls}" points="${d}"/>${dots}`;
  }).join('');
  const ylab = yt.map((v) => `<text class="ax" x="${L - 6}" y="${(Y(v) + 4).toFixed(1)}"
      text-anchor="end">${v.toFixed(Math.abs(v) >= 100 ? 0 : 1)}</text>`).join('');
  /* ★ 右端は text-anchor:middle だと枠の外に出て切れる */
  const xlab = xt.map((v) => `<text class="ax" x="${X(v).toFixed(1)}" y="${H - 8}"
      text-anchor="${v === 0 ? 'end' : 'middle'}">${
        v === 0 ? 'ティップ' : hhmm(v)}</text>`).join('');

  const legend = live.map((s) =>
    `<span class="lg ${s.cls}">${esc(s.name)}</span>`).join('');
  return `<svg class="odds" viewBox="0 0 ${W} ${H}">
      ${grid}${refLine}${lines}${ylab}${xlab}
    </svg>
    <p class="sub legend">${legend}　単位: ${esc(unit)}</p>`;
}

function oddsPane(g, key) {
  const meta = ODDS_META[key];
  const d = (g.odds || {})[key] || {};
  const series = [
    { name: 'Kalshi（15 分刻み）', pts: d.kalshi, cls: 'k' },
    { name: 'ブック 9 社の中央値', pts: d.book, cls: 'b', dot: true },
  ];
  const close = (g.odds_close || {})[key];
  return `<p class="sub">${meta.note(g)}
      ${close === undefined || close === null ? ''
        : `<strong>ティップ直前 ${close}${esc(meta.unit)}</strong>`}</p>
    ${lineChart(series, meta.ref, meta.unit)}`;
}

async function renderGame(gid) {
  let g;
  try {
    g = await load(`games/${gid}`);
  } catch (e) {
    /* 容量のため一部のチームが絡む試合はページを作っていない。
       日程からはリンクしないが、URL を直打ちされることはある */
    view.innerHTML = `<p class="err">${esc(gid)} の個別ページは作っていない。
      <a href="#/">日程へ</a></p>`;
    return;
  }
  const aw = g.score.away, hm = g.score.home;
  const warn = [];
  if (g.check && g.check.quarter_vs_box) {
    for (const [tri, v] of Object.entries(g.check.quarter_vs_box)) {
      warn.push(`${tri}: クォーター別の合計 ${v[0]} と公式ボックスの合計 ${v[1]} が合わない`);
    }
  }
  if (g.check && g.check.official_vs_pbp) {
    for (const [tri, qs] of Object.entries(g.check.official_vs_pbp)) {
      warn.push(`${tri}: 公式のクォーター別と PBP 集計が Q${qs.join(', Q')} で合わない`);
    }
  }

  view.innerHTML = `
    <p class="sub"><a href="#/d/${esc(g.date)}">&larr; ${fmtDate(g.date)}の日程</a></p>

    <div class="gamehead">
      <div class="side">
        <a href="#/team/${esc(g.away)}" class="tri">${esc(g.away)}</a>
        <span class="pts ${aw > hm ? 'win' : ''}">${aw ?? '—'}</span>
      </div>
      <div class="vs">－</div>
      <div class="side home">
        <span class="pts ${hm > aw ? 'win' : ''}">${hm ?? '—'}</span>
        <a href="#/team/${esc(g.home)}" class="tri">${esc(g.home)}</a>
      </div>
    </div>
    <p class="sub center">
      ${fmtDate(g.date)}${g.tip_et
        ? `・${esc(g.tip_et)} ET（日本 ${esc(g.tip_jst)}）` : ''}${g.arena
        ? `・${esc(g.arena)}` : ''}${g.city ? `（${esc(g.city)}）` : ''}${
        g.periods.length > 4 ? `・<strong>延長 ${g.periods.length - 4}</strong>` : ''}
    </p>

    ${warn.length ? `<p class="err">${warn.map(esc).join(' / ')}</p>` : ''}

    <h2>クォーター別</h2>
    ${quarterTable(g)}
    ${scorePath(g)}

    <h2>ラインナップ推移</h2>
    ${g.stint_ok ? `<p class="sub">${g.stint_src === 'rotation'
      ? '公式のローテーション記録（GameRotation）から。'
      : 'PBP の交代記録から再構成。各ピリオドの開始5人は推定で、検算に通っている。'}</p>`
      : ''}
    ${g.stint_ok
      ? [g.away, g.home].map((t) => `<h3>${esc(t)}</h3>${gantt(g, t)}`).join('')
      : `<p class="empty">この試合は出場区間の検算に通らなかったので出さない。
         PBP には各ピリオドの<strong>開始5人</strong>が記録されておらず
         交代記録から推定するため、合わない試合は出すと誤りになる。
         公式のローテーション記録でも埋まらなかった。</p>`}

    <h2>試合前のオッズ</h2>
    ${Object.keys(g.odds || {}).length ? `
      <div class="qtabs" id="otabs">
        ${Object.keys(ODDS_META).filter((k) => (g.odds || {})[k])
          .map((k, n) => `<button class="${n ? '' : 'on'}" data-o="${k}">${
            ODDS_META[k].label}</button>`).join('')}
      </div>
      <div id="oddswrap"></div>`
      : `<p class="empty">この試合のオッズは無い。収集を始めたのが
         2026-10-23 なので、それより前の試合には記録がない。</p>`}

    <h2>injury report</h2>
    ${[g.away, g.home].map((t) => injuryTable(g, t)).join('')}

    <h2>ボックススコア</h2>
    <div class="qtabs" id="qtabs">
      <button class="on" data-q="all">全体</button>
      ${g.periods.map((q) => `<button data-q="${esc(q)}">${esc(q)}</button>`).join('')}
    </div>
    <div id="boxwrap"></div>
  `;

  /* オッズの切り替え。既定はマネーライン */
  const ow = document.getElementById('oddswrap');
  if (ow) {
    const drawOdds = (key) => { ow.innerHTML = oddsPane(g, key); };
    drawOdds(Object.keys(ODDS_META).find((k) => (g.odds || {})[k]));
    document.getElementById('otabs').onclick = (e) => {
      const b = e.target.closest('button[data-o]');
      if (!b) return;
      document.querySelectorAll('#otabs button').forEach(
        (x) => { x.className = x === b ? 'on' : ''; });
      drawOdds(b.dataset.o);
    };
  }

  /* クォーターの切り替え。既定は「全体」で、押した枠だけ描き直す */
  const wrap = document.getElementById('boxwrap');
  const draw = (key) => {
    wrap.innerHTML = [g.away, g.home]
      .map((t) => `<h3>${esc(t)}</h3>${boxTable(g, t, key)}`).join('');
  };
  draw('all');
  document.getElementById('qtabs').onclick = (e) => {
    const b = e.target.closest('button[data-q]');
    if (!b) return;
    document.querySelectorAll('#qtabs button').forEach(
      (x) => { x.className = x === b ? 'on' : ''; });
    draw(b.dataset.q);
  };
}

async function route() {
  const parts = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean);
  const nav = { schedule: 'on', teams: '', reports: '' };
  try {
    view.innerHTML = '<p class="loading">読み込み中…</p>';
    if (parts[0] === 'teams') {
      nav.schedule = ''; nav.teams = 'on';
      await renderTeams();
    } else if (parts[0] === 'team' && parts[1]) {
      nav.schedule = ''; nav.teams = 'on';
      await renderTeam(parts[1].toUpperCase(), parts[2]);
    } else if (parts[0] === 'p' && parts[1]) {
      nav.schedule = ''; nav.teams = 'on';
      await renderPlayer(parts[1]);
    } else if (parts[0] === 'game' && parts[1]) {
      await renderGame(parts[1]);
    } else if (parts[0] === 'reports') {
      nav.schedule = ''; nav.reports = 'on';
      await renderReports();
    } else if (parts[0] === 'report' && parts[1]) {
      nav.schedule = ''; nav.reports = 'on';
      await renderReport(parts[1]);
    } else if (parts[0] === 'w') {
      await renderWeek(parts[1]);
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

/* 貼り付ける位置はサイトヘッダの下。
   ヘッダは折り返しで高さが変わるので、測って CSS 変数に入れる */
function setHeaderHeight() {
  const h = document.querySelector('header.site');
  if (h) {
    document.documentElement.style.setProperty(
      '--hdr', `${Math.round(h.getBoundingClientRect().height)}px`);
  }
}
setHeaderHeight();
window.addEventListener('resize', setHeaderHeight);

window.addEventListener('hashchange', route);

/* 幅が breakpoint をまたいだときだけ描き直す（回転・ウィンドウ操作）。
   毎回の resize で作り直すと無駄なので、またいだ時だけ */
let wasNarrow = narrow();
let resizeTimer = null;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    if (narrow() === wasNarrow) return;
    wasNarrow = narrow();
    if (location.hash.startsWith('#/p/')) route();
  }, 200);
});

route();

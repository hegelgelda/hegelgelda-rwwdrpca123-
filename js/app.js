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
const DATA_V = '51bcdf8b';
const view = document.getElementById('view');

/* ---- 板と odds の図（Cloudflare Pages。C:\polymarket\scripts\book_viz が毎時作って上げる） ----
   一覧 index.json の id は `日付(ET)_AWAY-HOME`（チームの略号はこのサイトと同じ）。
   ★ 読めなくても日程は出す。一覧が無い・Cloudflare が止まっているときはリンクを出さないだけ */
const BOOKS_URL = 'https://hegelgelda-nba-books.pages.dev';
let BOOKS = null;
async function books() {
  if (BOOKS) return BOOKS;
  try {
    const res = await fetch(`${BOOKS_URL}/index.json`, { cache: 'no-cache' });
    if (!res.ok) throw new Error(res.status);
    const ix = await res.json();
    BOOKS = Object.fromEntries((ix.games || []).map((b) => [`${b.d}_${b.a}-${b.h}`, b]));
  } catch (e) {
    BOOKS = {};
  }
  return BOOKS;
}
const bookLink = (d, a, h) => {
  const b = (BOOKS || {})[`${d}_${a}-${h}`];
  return b ? `<a class="booklink" href="${BOOKS_URL}/v.html#${encodeURIComponent(b.id)}"
      target="_blank" rel="noopener" title="moneyline の確率の推移と、任意の時点の板">板</a>` : '';
};

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

/* 段階1 の出力（未実施試合の予測とレーティング）。
   ★ 無くても日程は出す。`predict_upcoming.py` をまだ回していない環境や、
     JSON を作り直す前でも壊れないように、失敗は空で飲む */
let MODEL = null;
async function model() {
  if (MODEL) return MODEL;
  try {
    MODEL = await load('model');
  } catch (e) {
    MODEL = { games: {}, ratings: [] };
  }
  return MODEL;
}

/* ------------------------------------------------------------- 小道具 */

/* ★ 注目チーム。日程・チーム一覧・試合ページで色を変える。
   片方だけなら `fav`（琥珀）、注目チーム同士なら `fav2`（紫）。
   増やす / 減らすのはここだけ。CSS 側は --fav / --fav2 */
const FAV = new Set(['DET', 'NYK', 'OKC', 'SAS', 'DEN']);
/* ★ 個別ページを作っていないチーム。**注記を出すためだけ**の写しで、
   本当の判定は索引の `p: 0`（tools/build_games.py の EXCLUDE_TRI）。
   2026-11-01 に除外をやめたので空。また外すなら両方を直すこと */
const EXCLUDE_NOTE = [];
const favCls = (a, h) => {
  const n = (FAV.has(a) ? 1 : 0) + (FAV.has(h) ? 1 : 0);
  return n === 2 ? ' fav2' : n ? ' fav' : '';
};
/* 色の意味を 1 行添える。凡例が無いと何色なのか分からない。
   `both` が偽なら「注目同士」の紫は出さない（順位表のように
   1 行 1 チームの画面では紫が出ないため） */
const favLegend = (both = true) => `<span class="favkey">注目 ${
  [...FAV].join(' ')}</span>`
  + (both ? `<span class="favkey k2">注目同士</span>` : '');

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
  await model();
  await books();
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
      ${favLegend()}
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
  await model();
  await books();
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
      ${favLegend()}
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
  /* まだの試合にはモデルの予想を添える。`pred` はホーム基準の得点差 */
  const mp = done ? null : ((MODEL && MODEL.games) || {})[g.game_id];
  /* ★ 今季このカードが何回目か（schedule.json の `sn` / `sc`）。
       **日程の行だけ**に出す。終わった試合には出さない（勝率の右隣という
       位置なので、対象は「これからの対戦」に限る）。
     ★ `sc` は確定ぶんだけの分母。NBA Cup のノックアウトが 12 月に
       追加されると増えるので、「最後の対戦」と読ませる文言にはしない */
  const sn = (done || !g.sn) ? '' : `<span class="sn" title="今季の対戦 ${
    g.sc} 試合のうち ${g.sn} 戦目">${g.sn}戦目</span>`;
  /* ★ `pred` / `p` が欠けた予測は**この行だけ**落とす。
       以前は `p.toFixed()` が例外になり、1 試合の欠けで日程のページが
       丸ごと白くなった（2026-11-02。σ が NaN で p_home が null になった）。
       書き出し側（build_page1.py）でも落としているが、ここでも守る */
  const ok = mp && mp.pred !== null && mp.pred !== undefined
                && mp.p !== null && mp.p !== undefined;
  const mpred = !ok ? '' : (() => {
    const homeFav = mp.pred >= 0;
    const tri = homeFav ? g.h : g.a;
    const pts = Math.abs(mp.pred).toFixed(1);
    const p = homeFav ? mp.p : 100 - mp.p;
    /* `av: 1` は injury report を織り込めた試合。0 は欠場を見ていない */
    return `<span class="mpred" title="${mp.av
        ? '段階1 の予測（injury report を織り込み済み）'
        : '段階1 の予測。この試合の injury report はまだ出ていない'}"
      >${esc(tri)} −${pts}<span class="pp">${p.toFixed(0)}%</span>${sn}${
      mp.av ? '<span class="avok" title="欠場を織り込み済み">injury</span>' : ''
      }</span>`;
  })();
  /* ★ `p: 0` は「個別ページを作っていない試合」。容量のため一部のチームが
     絡む試合はページを作っていない（tools/build_games.py の EXCLUDE_TRI）。
     スコアは索引にあるので出すが、リンクにはしない */
  const page = done && r.p !== 0;
  /* 注目チームの側だけ色を変える。注目同士なら枠ごと別色になる（CSS） */
  const fa = FAV.has(g.a) ? ' is-fav' : '', fh = FAV.has(g.h) ? ' is-fav' : '';
  /* ★ `done` でないと `r` が無い。テンプレート文字列は即時に評価されるので、
     ここを三項の外に出すと未実施の試合で `r.ap` を読んで全体が落ちる */
  const score = !done ? '' : `<span class="tri${r.ap > r.hp ? ' win' : ''}${fa}">${esc(g.a)}</span>
     <span class="pts${r.ap > r.hp ? ' win' : ''}${fa}">${r.ap}</span>
     <span class="at">－</span>
     <span class="pts${r.hp > r.ap ? ' win' : ''}${fh}">${r.hp}</span>
     <span class="tri${r.hp > r.ap ? ' win' : ''}${fh}">${esc(g.h)}</span>`;
  /* 終わった試合は対戦の部分がそのまま試合ページへの入口。
     まだの試合は従来どおりチームページへ */
  const match = page
    ? `<a class="result" href="#/game/${esc(g.game_id)}">${score}</a>${ot}`
    : done
      ? `<span class="result nolink" title="この試合は個別ページを作っていない"
           >${score}</span>${ot}`
      : `<a class="tm${fa}" href="#/team/${esc(g.a)}">${esc(g.a)}</a>
         <span class="at">＠</span>
         <a class="tm${fh}" href="#/team/${esc(g.h)}">${esc(g.h)}</a>`;
  return `<div class="game${done ? ' is-done' : ''}${favCls(g.a, g.h)}">
    <div class="tip">
      <span class="et">${esc(g.t || '')}</span>
      <span class="jst">${esc(jst(g))}</span>
    </div>
    <div class="match">
      ${match}
      ${g.label ? `<span class="badge">${esc(g.label)}</span>` : ''}
      ${mpred || sn}
      ${bookLink(g.d, g.a, g.h)}
    </div>
    <div class="meta">
      ${g.tv ? `<span class="tv">${esc(g.tv)}</span> · ` : ''}
      ${esc(g.city || '')}
    </div>
  </div>`;
}

/* ---- コメント記録の一覧と出し入れ ----------------------------------
   ★ 保存先は localStorage なので、**その端末のそのブラウザにしか残らない**。
     別の端末から見たい / 消えても困らないようにしたいなら、ここで
     書き出して `C:\nba\reports\game_notes.json` に置く。次の日次ビルドで
     `build_games.py` が試合ページに焼き込み、誰でも見られるようになる。
   ★ 書き出しの形は `build_games.py` が読む形と**同じ**。往復できる。 */

const NOTE_PREFIX = 'nba.note.';

function notesAll() {
  const out = [];
  let keys = [];
  try { keys = Object.keys(localStorage); } catch (e) { keys = []; }
  for (const k of keys) {
    if (!k.startsWith(NOTE_PREFIX)) continue;
    const gid = k.slice(NOTE_PREFIX.length);
    for (const n of notesLoad(gid)) out.push({ gid, ...n });
  }
  out.sort((x, y) => String(y.t).localeCompare(String(x.t)));
  return out;
}

function notesExport() {
  const notes = {};
  for (const n of notesAll()) (notes[n.gid] ??= []).push({ t: n.t, c: n.c });
  const blob = new Blob(
    [JSON.stringify({ generated_at: new Date().toISOString(), notes }, null, 1)],
    { type: 'application/json' });
  const u = URL.createObjectURL(blob);
  const a2 = document.createElement('a');
  a2.href = u;
  a2.download = 'game_notes.json';
  a2.click();
  setTimeout(() => URL.revokeObjectURL(u), 1000);
}

/* 読み込みは**併合**。同じ試合の同じ時刻の記録は 1 つに畳む */
function notesImport(obj) {
  const src = (obj && obj.notes) || {};
  let add = 0;
  for (const [gid, list] of Object.entries(src)) {
    if (!Array.isArray(list)) continue;
    const cur = notesLoad(gid);
    const seen = new Set(cur.map((n) => `${n.t}|${n.c}`));
    for (const n of list) {
      if (!n || !n.c || seen.has(`${n.t}|${n.c}`)) continue;
      cur.push({ t: n.t || new Date().toISOString(), c: String(n.c) });
      add += 1;
    }
    cur.sort((x, y) => String(y.t).localeCompare(String(x.t)));
    notesSave(gid, cur);
  }
  return add;
}

/* ★ 下の `<code>` の中は `\` で書く。テンプレート文字列なので `
` と
   `
` はそのままだと改行と復帰になり「C: ba eports...」と出る。
   ★ ここに HTML コメントで説明を書かないこと。コメントの中にバッククォートを
   入れるとテンプレート文字列がそこで閉じて、ページ全体が落ちる（実際に落ちた）。 */
async function renderNotes() {
  await results();
  const list = notesAll();
  const row = (n) => {
    const g = (RESULTS || {})[n.gid];
    const label = g ? `${g.a} @ ${g.h}` : n.gid;
    return `<tr>
      <td class="n dim">${esc(noteStamp(n.t))}</td>
      <td><a href="#/game/${esc(n.gid)}">${esc(label)}</a>
        ${g ? `<span class="dim"> ${esc(g.d)}</span>` : ''}</td>
      <td class="nc2">${esc(n.c)}</td>
    </tr>`;
  };
  view.innerHTML = `
    <h1>コメント記録</h1>
    <p class="sub">試合ページで書いた記録の一覧。
      <strong>保存先はこの端末のこのブラウザ</strong>（localStorage）なので、
      別の端末からは見えないし、閲覧データを消すと消える。</p>
    <div class="lbar">
      <button id="nexp" ${list.length ? '' : 'disabled'}>書き出す（JSON）</button>
      <button id="nimp">読み込む</button>
      <input id="nfile" type="file" accept="application/json" hidden>
      <span class="spacer"></span>
      <span class="count">${list.length} 件</span>
    </div>
    ${list.length ? `<div class="wrap"><table class="career notetab">
      <thead><tr><th class="n">記録した日時</th><th>試合</th><th>本文</th></tr></thead>
      <tbody>${list.map(row).join('')}</tbody>
    </table></div>` : '<p class="empty">まだ記録が無い。</p>'}
    <p class="sub">書き出した JSON を <code>C:\\nba\\reports\\game_notes.json</code>
      に置くと、次の日次ビルドで試合ページに焼き込まれ、
      <strong>どの端末からでも見られる</strong>ようになる。
      読み込みは併合で、同じ内容は重複しない。</p>`;

  document.getElementById('nexp').onclick = notesExport;
  const f = document.getElementById('nfile');
  document.getElementById('nimp').onclick = () => f.click();
  f.onchange = async () => {
    const file = f.files && f.files[0];
    if (!file) return;
    try {
      const n = notesImport(JSON.parse(await file.text()));
      alert(`${n} 件を読み込んだ。`);
      route();
    } catch (e) {
      alert(`読み込めなかった: ${e.message}`);
    }
  };
}

/* ------------------------------------------------------- 市場の事後検証

   ★ これは「市場がどれだけ当てたか」を測る画面で、こちらのモデルの
     評価ではない（段階1 の予測を未実施試合に出す経路はまだ無い）。
   ★ 標本が小さい。n が数十のうちは **SE を必ず併記する**。
     いくつも指標を並べているので、どれか1つが 2 シグマに届いても
     それだけで「市場の誤り」と読まないこと。 */

const mean = (v) => v.reduce((s, x) => s + x, 0) / v.length;
const sd = (v) => {
  if (v.length < 2) return null;
  const m = mean(v);
  return Math.sqrt(v.reduce((s, x) => s + (x - m) ** 2, 0) / (v.length - 1));
};
const se = (v) => (v.length < 2 ? null : sd(v) / Math.sqrt(v.length));
const clamp01 = (p) => Math.min(Math.max(p, 1e-6), 1 - 1e-6);
const logLoss1 = (p, y) => -(y * Math.log(clamp01(p)) + (1 - y) * Math.log(1 - clamp01(p)));

function mlStats(rows, tag) {
  const use = rows.filter((g) => g[`${tag}_ml`] !== undefined
                              && g[`${tag}_ml`] !== null);
  if (!use.length) return null;
  const p = use.map((g) => g[`${tag}_ml`] / 100);
  const y = use.map((g) => (g.hp > g.ap ? 1 : 0));
  const per = p.map((v, i) => logLoss1(v, y[i]));
  const brier = p.map((v, i) => (v - y[i]) ** 2);
  const hit = p.filter((v, i) => (v > 0.5) === (y[i] === 1)).length / use.length;
  const mins = use.map((g) => g[`${tag}_ml_m`]).sort((x, z) => x - z);
  return {
    n: use.length, ll: mean(per), llse: se(per),
    brier: mean(brier), hit,
    med: mins[Math.floor(mins.length / 2)],
    p, y,
  };
}

function lineStats(rows, tag, key, actual) {
  const use = rows.filter((g) => g[`${tag}_${key}`] !== undefined
                              && g[`${tag}_${key}`] !== null);
  if (!use.length) return null;
  /* spread は「ホームのハンディ」。予想得点差は符号を反転した値なので、
     誤差 = 実際の得点差 − (−spread) = 得点差 + spread */
  const err = use.map((g) => (key === 'sp'
    ? (g.hp - g.ap) + g[`${tag}_sp`]
    : (g.hp + g.ap) - g[`${tag}_tt`]));
  const over = err.filter((e) => e > 0).length / use.length;
  const mins = use.map((g) => g[`${tag}_${key}_m`]).sort((x, z) => x - z);
  return {
    n: use.length,
    mae: mean(err.map(Math.abs)), rmse: Math.sqrt(mean(err.map((e) => e * e))),
    bias: mean(err), bse: se(err), over,
    med: mins[Math.floor(mins.length / 2)],
  };
}

function calib(s) {
  const EDGE = [0, 0.35, 0.45, 0.55, 0.65, 1.001];
  const out = [];
  for (let i = 0; i < EDGE.length - 1; i++) {
    const ix = s.p.map((v, k) => k).filter((k) => s.p[k] >= EDGE[i] && s.p[k] < EDGE[i + 1]);
    if (!ix.length) continue;
    out.push({
      lo: EDGE[i], hi: Math.min(EDGE[i + 1], 1), n: ix.length,
      pred: mean(ix.map((k) => s.p[k])),
      act: mean(ix.map((k) => s.y[k])),
    });
  }
  return out;
}

async function renderMarket() {
  const d = await load('market');
  const rows = d.games;
  if (!rows.length) {
    view.innerHTML = `<h1>市場の事後検証</h1>
      <p class="empty">オッズと結果がそろった試合がまだ無い。</p>`;
    return;
  }
  const K = mlStats(rows, 'k'), B = mlStats(rows, 'b');
  const hr = mean(rows.map((g) => (g.hp > g.ap ? 1 : 0)));
  const baseHome = -(hr * Math.log(hr) + (1 - hr) * Math.log(1 - hr));
  const p1 = (v) => (v === null || v === undefined) ? '—' : v.toFixed(1);
  const p3 = (v) => (v === null || v === undefined) ? '—' : v.toFixed(3);
  const pc1 = (v) => (v === null || v === undefined) ? '—' : `${(v * 100).toFixed(1)}%`;
  const pm = (v, dig = 2) => (v > 0 ? '+' : '') + v.toFixed(dig);

  const mlRow = (nm, s) => s ? `<tr>
    <td>${nm}</td><td class="n">${s.n}</td>
    <td class="n b">${p3(s.ll)}</td><td class="n dim">±${p3(s.llse)}</td>
    <td class="n">${p3(s.brier)}</td><td class="n">${pc1(s.hit)}</td>
    <td class="n dim">${s.med} 分前</td></tr>` : '';

  const line = (key, nm, actual) => {
    const k = lineStats(rows, 'k', key), b = lineStats(rows, 'b', key);
    const r = (lab, s) => s ? `<tr><td>${lab}</td><td class="n">${s.n}</td>
      <td class="n b">${p1(s.mae)}</td><td class="n">${p1(s.rmse)}</td>
      <td class="n ${Math.abs(s.bias) > 2 * s.bse ? 'warnv' : ''}">${pm(s.bias)}</td>
      <td class="n dim">±${p1(s.bse)}</td>
      <td class="n">${pc1(s.over)}</td>
      <td class="n dim">${s.med} 分前</td></tr>` : '';
    return `<h3>${nm}</h3>
      <div class="wrap"><table class="career">
        <thead><tr><th>出どころ</th><th class="n">n</th><th class="n">MAE</th>
          <th class="n">RMSE</th><th class="n">偏り</th><th class="n">SE</th>
          <th class="n">${actual}</th><th class="n">終値</th></tr></thead>
        <tbody>${r('Kalshi', k)}${r('ブック 9 社', b)}</tbody>
      </table></div>`;
  };

  const cal = calib(K).map((c) => `<tr>
    <td class="n">${(c.lo * 100).toFixed(0)}–${(c.hi * 100).toFixed(0)}%</td>
    <td class="n">${c.n}</td>
    <td class="n">${pc1(c.pred)}</td>
    <td class="n b">${pc1(c.act)}</td>
    <td class="n ${Math.abs(c.act - c.pred)
      > 2 * Math.sqrt(c.pred * (1 - c.pred) / c.n) ? 'warnv' : 'dim'}">${
      pm((c.act - c.pred) * 100, 1)}pt</td></tr>`).join('');

  /* 外れの大きかった試合。勝ったほうの事前確率が低い順。
     ★ `k_ml` は**ホームの**勝率。アウェイが勝った試合は 100 から引く
       （最初ここを逆にして、番狂わせが 72.5% と出ていた） */
  const miss = rows.filter((g) => g.k_ml !== undefined && g.k_ml !== null)
    .map((g) => ({ g, s: (g.hp > g.ap ? g.k_ml : 100 - g.k_ml) }))
    .sort((x, z) => x.s - z.s).slice(0, 8)
    .map(({ g, s }) => `<tr>
      <td class="n">${esc(g.d.slice(5).replace('-', '/'))}</td>
      <td><a href="#/game/${esc(g.id)}">${esc(g.a)} @ ${esc(g.h)}</a></td>
      <td class="n">${g.ap}-${g.hp}</td>
      <td class="n">${p1(g.k_ml)}%</td>
      <td class="n b">${p1(s)}%</td></tr>`).join('');

  /* ---- 未実施試合: モデルと市場を並べる
     ★ `pred` と市場の `-m_sp` はどちらも**ホーム基準の得点差**。
       差が正なら、モデルのほうがホームを高く買っている。 */
  const up = d.upcoming || [];
  const upTable = !up.length ? '' : `
    <h2>これからの試合：モデル vs 市場</h2>
    <p class="sub">${up.length} 試合。モデルは段階1、市場は Kalshi の最新値。
      <strong>どちらもホーム基準</strong>で、得点差は正がホーム有利。
      差はモデル − 市場。<strong>どちらもまだ動く</strong>（終値ではない）。
      右の 2 列は「その値がティップの何時間前のものか」で、
      <strong>公平に比べるにはこの 2 つが揃っている必要がある</strong>。
      <span class="avok">injury</span> はその試合の
      injury report を織り込めた予測。</p>
    <div class="wrap"><table class="career vstab">
      <thead><tr><th class="n">日付</th><th>対戦</th>
        <th class="n">モデル</th><th class="n">市場</th><th class="n">差</th>
        <th class="n">モデル%</th><th class="n">市場%</th><th class="n">差</th>
        <th class="n">モデルの時点</th>
        <th class="n">市場の時点</th></tr></thead>
      <tbody>${up.map((g) => `<tr>
        <td class="n dim">${esc(g.d.slice(5).replace('-', '/'))}</td>
        <td><a href="#/team/${esc(g.a)}">${esc(g.a)}</a>
          <span class="at">＠</span>
          <a href="#/team/${esc(g.h)}">${esc(g.h)}</a></td>
        <td class="n">${g.pred > 0 ? '+' : ''}${num(g.pred)}</td>
        <td class="n">${g.m_sp === undefined ? '—'
          : (-g.m_sp > 0 ? '+' : '') + num(-g.m_sp)}</td>
        <td class="n ${Math.abs(g.d_sp ?? 0) >= 3 ? 'warnv' : 'dim'}">${
          g.d_sp === undefined ? '—' : (g.d_sp > 0 ? '+' : '') + num(g.d_sp)}</td>
        <td class="n">${num(g.p)}%</td>
        <td class="n">${num(g.m_ml)}%</td>
        <td class="n ${Math.abs(g.d_p ?? 0) >= 8 ? 'warnv' : 'dim'}">${
          g.d_p === undefined ? '—' : (g.d_p > 0 ? '+' : '') + num(g.d_p)}pt</td>
        <td class="n dim">${g.lead === undefined || g.lead === null
          ? '—' : hhmm(g.lead * 60)}${g.av ? '<span class="avok">injury</span>' : ''}</td>
        <td class="n dim">${hhmm(g.m_ml_m)}</td>
      </tr>`).join('')}</tbody>
    </table></div>
    <p class="sub">★ 差が大きい試合は<strong>どちらかが外している</strong>という
      意味で、どちらが正しいかは結果が出るまで分からない。
      モデルは<strong>欠場を一切見ていない</strong>（v1）ので、
      主力が離脱している試合ほど市場のほうが正しいはず。</p>`;

  view.innerHTML = `
    <h1>市場の事後検証</h1>
    <p class="sub">${esc(d.season)}・オッズと結果がそろった <strong>${
      rows.length} 試合</strong>。終値は<strong>各ソースでティップに一番近い点</strong>
      （Kalshi は 15 分刻み、ブックは 1 日 4 回なので古いことがある）。
      <strong>これは市場の成績であって、こちらのモデルの評価ではない。</strong></p>

    ${upTable}

    <h2>マネーライン（終わった試合）</h2>
    <div class="wrap"><table class="career">
      <thead><tr><th>出どころ</th><th class="n">n</th><th class="n">logloss</th>
        <th class="n">SE</th><th class="n">Brier</th><th class="n">的中率</th>
        <th class="n">終値</th></tr></thead>
      <tbody>${mlRow('Kalshi', K)}${mlRow('ブック 9 社', B)}
        <tr class="total"><td>五分（p=0.5）</td><td class="n">${rows.length}</td>
          <td class="n">${p3(Math.log(2))}</td><td class="n dim">—</td>
          <td class="n">0.250</td><td class="n dim">—</td><td class="n dim">—</td></tr>
        <tr class="total"><td>ホーム勝率一定（${pc1(hr)}）</td>
          <td class="n">${rows.length}</td><td class="n">${p3(baseHome)}</td>
          <td class="n dim">—</td><td class="n">${p3(hr * (1 - hr))}</td>
          <td class="n dim">—</td><td class="n dim">—</td></tr>
      </tbody>
    </table></div>

    <h3>較正（Kalshi）</h3>
    <div class="wrap"><table class="career">
      <thead><tr><th class="n">予測の帯</th><th class="n">n</th>
        <th class="n">予測の平均</th><th class="n">実測</th>
        <th class="n">差</th></tr></thead>
      <tbody>${cal}</tbody>
    </table></div>
    <p class="sub">色が付くのは<strong>二項の 2 SE を超えた帯</strong>だけ
      （n = 10 なら ±30 ポイントまでは誤差の範囲）。帯が 5 つあるので、
      1 つくらい超えるのはむしろ普通。${rows.length} 試合では較正の
      良し悪しは決まらない。</p>

    ${line('sp', 'スプレッド（ホームの得点差）', 'ホームがカバー')}
    ${line('tt', 'トータル（合計得点）', 'オーバー')}

    <h2>大きく外した試合</h2>
    <div class="wrap"><table class="career">
      <thead><tr><th class="n">日付</th><th>対戦</th><th class="n">結果</th>
        <th class="n">ホーム勝率</th><th class="n">勝った側の事前</th></tr></thead>
      <tbody>${miss}</tbody>
    </table></div>

    <p class="sub">
      ★ <strong>標本が小さい。</strong>logloss の SE は ±0.04 前後で、
      ここに並ぶ差のほとんどは誤差に埋もれる。偏りの欄で色が付くのは
      「2 SE を超えた」という印にすぎず、いくつも指標を並べている以上
      それだけで市場の誤りとは読めない。試合が積み上がるまで結論は保留。
      <br>★ オッズがあるのは収集を始めた 2026-10-23 以降の試合だけなので、
      この標本は今季全体とは別物（この標本のホーム勝率 ${pc1(hr)}）。
    </p>`;
}

/* ------------------------------------------------------------- 順位表 */

/* ★ `team_standings_daily` は使っていない。派生表で進行中の季に
     追いついていないため、`build_page1.py` が raw から作り直している。 */
async function renderStandings() {
  const st = await load('standings');
  const md = await model();
  const CONF = ['East', 'West'];
  const table = (conf) => {
    const rows = st.teams.filter((t) => t.conf === conf);
    if (!rows.length) return '';
    return `<section>
      <h2>${conf === 'East' ? 'イースタン' : 'ウェスタン'}</h2>
      <div class="wrap"><table class="stand">
        <thead><tr>
          <th class="n">#</th><th>チーム</th>
          <th class="n">勝</th><th class="n">敗</th><th class="n">勝率</th>
          <th class="n">GB</th><th class="n">ホーム</th><th class="n">アウェイ</th>
          <th class="n">直近10</th><th class="n">連</th>
          <th class="n">得点</th><th class="n">失点</th><th class="n">得失</th>
          <th class="n">ORtg</th><th class="n">DRtg</th><th class="n">Net</th>
          <th class="n">Pace</th>
        </tr></thead>
        <tbody>${rows.map((t, i) => `<tr class="${FAV.has(t.tri) ? 'fav' : ''}">
          <td class="n dim">${i + 1}</td>
          <td><a class="tm${FAV.has(t.tri) ? ' is-fav' : ''}"
                 href="#/team/${esc(t.tri)}">${esc(t.tri)}</a>
              <span class="dim nm">${esc(t.name)}</span></td>
          <td class="n b">${t.w}</td><td class="n">${t.l}</td>
          <td class="n">${t.pct.toFixed(3).replace(/^0/, '')}</td>
          <td class="n dim">${t.gb ? num(t.gb) : '—'}</td>
          <td class="n dim">${t.hw}-${t.hl}</td>
          <td class="n dim">${t.aw}-${t.al}</td>
          <td class="n dim">${t.w10}-${t.l10}</td>
          <td class="n ${t.stk[0] === 'W' ? 'up' : 'down'}">${esc(t.stk)}</td>
          <td class="n">${num(t.pf)}</td><td class="n">${num(t.pa)}</td>
          <td class="n ${t.diff > 0 ? 'up' : t.diff < 0 ? 'down' : ''}">${
            t.diff > 0 ? '+' : ''}${num(t.diff)}</td>
          <td class="n">${num(t.ortg)}</td><td class="n">${num(t.drtg)}</td>
          <td class="n ${t.net > 0 ? 'up' : t.net < 0 ? 'down' : ''}">${
            t.net > 0 ? '+' : ''}${num(t.net)}</td>
          <td class="n dim">${num(t.pace)}</td>
        </tr>`).join('')}</tbody>
      </table></div>
    </section>`;
  };
  view.innerHTML = `
    <h1>順位</h1>
    <p class="sub">${esc(st.season)} レギュラーシーズン・${
      esc(st.asof || '')} 時点。${favLegend(false)}</p>
    <div class="standgrid">${CONF.map(table).join('')}</div>
    <p class="sub">GB はカンファレンス首位との差。ORtg / DRtg は
      <strong>ポゼッションで重み付けした</strong>平均（試合ごとの率の単純平均
      ではない）。Net = ORtg − DRtg。</p>

    ${(md.ratings || []).length ? `
      <h2>モデルのレーティング</h2>
      <p class="sub">段階1（リッジ・半減期 80 日・罰則 3）が
        <strong>${esc(md.as_of || '')} 時点</strong>で推定した実力。
        上の表と違って<strong>相手の強さで補正してあり、古い試合は軽い</strong>。
        単位は 100 ポゼッションあたりの点。
        <strong>def は正が良い守備</strong>で、総合 = off + def。
        ${(md.model || '').includes('out_pre')
          ? `可用性は<strong>インジャリーレポートから</strong>織り込む（v2）。
             いまレポートが出ている試合は ${md.n_av} 件。`
          : '可用性（欠場）は<strong>使っていない</strong>（v1）。'}</p>
      <div class="wrap"><table class="career rate">
        <thead><tr><th class="n">#</th><th>チーム</th><th class="n">攻撃</th>
          <th class="n">守備</th><th class="n">総合</th></tr></thead>
        <tbody>${md.ratings.map((t, i) => `<tr class="${
          FAV.has(t.tri) ? 'fav' : ''}">
          <td class="n dim">${i + 1}</td>
          <td><a class="tm${FAV.has(t.tri) ? ' is-fav' : ''}"
                 href="#/team/${esc(t.tri)}">${esc(t.tri)}</a></td>
          <td class="n ${t.off > 0 ? 'up' : t.off < 0 ? 'down' : ''}">${
            t.off > 0 ? '+' : ''}${num(t.off, 2)}</td>
          <td class="n ${t.def > 0 ? 'up' : t.def < 0 ? 'down' : ''}">${
            t.def > 0 ? '+' : ''}${num(t.def, 2)}</td>
          <td class="n b ${t.net > 0 ? 'up' : t.net < 0 ? 'down' : ''}">${
            t.net > 0 ? '+' : ''}${num(t.net, 2)}</td>
        </tr>`).join('')}</tbody>
      </table></div>
      <p class="sub">予想得点差の σ は <strong>${num(md.sigma, 1)} 点</strong>。
        これも推定値で、序盤はレーティングの誤差が大きいぶん広い。</p>` : ''}`;
}

/* ------------------------------------------------------- 選手一覧（今季） */

/* 並べ替えの状態。列キーと向き（-1 が大きい順） */
let LSORT = { k: 'pts', d: -1 };
let LMIN = 1;      /* 最低試合数 */
let LQ = '';       /* 名前・チームの絞り込み */

const LCOLS = [
  { k: 'n', t: '選手', s: 0 },
  { k: 't', t: 'チーム', s: 0 },
  { k: 'g', t: '試合' }, { k: 'gs', t: '先発' }, { k: 'mpg', t: 'MP' },
  { k: 'pts', t: 'PTS' }, { k: 'reb', t: 'REB' }, { k: 'ast', t: 'AST' },
  { k: 'stl', t: 'STL' }, { k: 'blk', t: 'BLK' }, { k: 'tov', t: 'TOV' },
  { k: 'fg', t: 'FG%' }, { k: 'tp', t: '3P%' }, { k: 'ft', t: 'FT%' },
  { k: 'ts', t: 'TS%' }, { k: 'pm', t: '+/-' },
];

function leagueRows(all) {
  const q = fold(LQ.trim());
  const list = all.filter((p) => p.g >= LMIN
    && (!q || fold(p.n).includes(q) || fold(p.t).includes(q)));
  const k = LSORT.k;
  list.sort((x, y) => {
    const vx = x[k], vy = y[k];
    if (typeof vx === 'string' || typeof vy === 'string') {
      return String(vx).localeCompare(String(vy)) * LSORT.d * -1;
    }
    /* null は常に下へ。向きに関わらず */
    if (vx === null || vx === undefined) return 1;
    if (vy === null || vy === undefined) return -1;
    return (vx - vy) * LSORT.d;
  });
  return list;
}

function leagueBody(all) {
  const list = leagueRows(all);
  if (!list.length) return '<tr><td colspan="16" class="empty">該当なし</td></tr>';
  const p3 = (v) => (v === null || v === undefined) ? '—'
    : v.toFixed(3).replace(/^0/, '');
  return list.map((p) => `<tr>
    <td><a href="#/p/${p.id}">${esc(p.n)}</a></td>
    <td><a class="tm${FAV.has(p.t) ? ' is-fav' : ''}"
           href="#/team/${esc(p.t)}">${esc(p.t)}</a></td>
    <td class="n">${p.g}</td>
    <td class="n dim">${p.gs ?? '—'}</td>
    <td class="n">${num(p.mpg)}</td>
    <td class="n b">${num(p.pts)}</td>
    <td class="n">${num(p.reb)}</td>
    <td class="n">${num(p.ast)}</td>
    <td class="n">${num(p.stl)}</td>
    <td class="n">${num(p.blk)}</td>
    <td class="n">${num(p.tov)}</td>
    <td class="n">${p3(p.fg)}</td>
    <td class="n">${p3(p.tp)}</td>
    <td class="n">${p3(p.ft)}</td>
    <td class="n">${p3(p.ts)}</td>
    <td class="n ${p.pm > 0 ? 'up' : p.pm < 0 ? 'down' : ''}">${
      p.pm > 0 ? '+' : ''}${num(p.pm)}</td>
  </tr>`).join('');
}

async function renderLeague() {
  const d = await load('season_players');
  const all = d.players;
  const head = () => LCOLS.map((c) => `<th class="${c.s === 0 ? '' : 'n'} ${
    LSORT.k === c.k ? 'sorted' : ''}" data-k="${c.k}">${c.t}${
    LSORT.k === c.k ? (LSORT.d < 0 ? ' ▾' : ' ▴') : ''}</th>`).join('');

  view.innerHTML = `
    <h1>選手（今季）</h1>
    <p class="sub">${esc(d.season)} レギュラーシーズンの1試合平均。
      ${all.length} 名。<strong>列の見出しを押すと並べ替え</strong>。
      率は合計から計算している（試合ごとの率の平均ではない）。</p>
    <div class="lbar">
      <input id="lq" type="search" placeholder="名前・チームで絞る"
             value="${esc(LQ)}" autocomplete="off">
      <label>最低試合数
        <input id="lmin" type="number" min="1" max="82" value="${LMIN}"></label>
      <span class="spacer"></span>
      <span class="count" id="lcount"></span>
    </div>
    <div class="wrap"><table class="career league">
      <thead><tr id="lhead">${head()}</tr></thead>
      <tbody id="lbody">${leagueBody(all)}</tbody>
    </table></div>`;

  const redraw = () => {
    document.getElementById('lbody').innerHTML = leagueBody(all);
    document.getElementById('lhead').innerHTML = head();
    bindHead();
    document.getElementById('lcount').textContent =
      `${leagueRows(all).length} 名`;
  };
  const bindHead = () => {
    document.getElementById('lhead').onclick = (e) => {
      const th = e.target.closest('th[data-k]');
      if (!th) return;
      const k = th.dataset.k;
      /* 同じ列をもう一度押したら向きを反転。別の列なら既定の向きから */
      if (LSORT.k === k) LSORT.d *= -1;
      else LSORT = { k, d: (k === 'n' || k === 't') ? 1 : -1 };
      redraw();
    };
  };
  bindHead();
  document.getElementById('lcount').textContent = `${leagueRows(all).length} 名`;
  document.getElementById('lq').oninput = (e) => { LQ = e.target.value; redraw(); };
  document.getElementById('lmin').onchange = (e) => {
    LMIN = Math.max(1, Number(e.target.value) || 1);
    redraw();
  };
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
                <a class="teamrow${FAV.has(t.tri) ? ' is-fav' : ''}"
                   href="#/team/${esc(t.tri)}">
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
  /* チームのシーズン指標。無くてもページは出す */
  let ts = null;
  try { ts = await load('team_stats'); } catch (e) { ts = null; }
  /* 今季の成績。順位表と同じ JSON から引く（無くてもページは出す） */
  let me = null;
  try {
    me = (await load('standings')).teams.find((t) => t.tri === tri) || null;
  } catch (e) { me = null; }
  await results();   /* 日程表の「結果」列から試合ページへ飛ばすため */
  const team = teams.find((t) => t.tri === tri);
  if (!team) { view.innerHTML = `<p class="err">チーム ${esc(tri)} が無い。</p>`; return; }

  const players = rost.teams[tri] || [];
  const games = sc.games.filter((g) => g.h === tri || g.a === tri);
  const TABS = ['roster', 'schedule', 'stats'];
  const cur = TABS.includes(tab) ? tab : 'roster';

  view.innerHTML = `
    <div class="teamhead">
      <h1>${esc(team.full_name)}</h1>
      <span class="tri${FAV.has(tri) ? ' is-fav' : ''}">${esc(tri)}</span>
      <span class="sub" style="margin:0">${esc(team.conference)} / ${esc(team.division)}</span>
    </div>
    ${me ? `<div class="statstrip">
      <div><span class="k">今季</span><span class="v">${me.w}勝 ${me.l}敗</span>
        <span class="k2">${me.pct.toFixed(3).replace(/^0/, '')}</span></div>
      <div><span class="k">得点 / 失点</span>
        <span class="v">${num(me.pf)} / ${num(me.pa)}</span>
        <span class="k2 ${me.diff > 0 ? 'up' : 'down'}">${
          me.diff > 0 ? '+' : ''}${num(me.diff)}</span></div>
      <div><span class="k">ORtg / DRtg</span>
        <span class="v">${num(me.ortg)} / ${num(me.drtg)}</span>
        <span class="k2 ${me.net > 0 ? 'up' : 'down'}">Net ${
          me.net > 0 ? '+' : ''}${num(me.net)}</span></div>
      <div><span class="k">Pace</span><span class="v">${num(me.pace)}</span></div>
      <div><span class="k">ホーム / アウェイ</span>
        <span class="v">${me.hw}-${me.hl} / ${me.aw}-${me.al}</span></div>
      <div><span class="k">直近10 / 連</span>
        <span class="v">${me.w10}-${me.l10}</span>
        <span class="k2 ${me.stk[0] === 'W' ? 'up' : 'down'}">${esc(me.stk)}</span></div>
    </div>` : ''}
    <div class="tabs">
      <button data-t="roster"   class="${cur === 'roster' ? 'on' : ''}">
        ロスター（${players.length}）</button>
      <button data-t="schedule" class="${cur === 'schedule' ? 'on' : ''}">
        日程（${games.length}）</button>
      ${ts && ts.cur[tri] ? `<button data-t="stats"
        class="${cur === 'stats' ? 'on' : ''}">シーズン成績</button>` : ''}
    </div>
    <div id="pane">${cur === 'roster' ? rosterTable(players, rost.prev)
      : cur === 'stats' ? teamStats(ts, tri) : teamSchedule(games, tri)}</div>`;

  view.querySelectorAll('.tabs button').forEach((b) => {
    b.onclick = () => go(`#/team/${tri}/${b.dataset.t}`);
  });
}

/* ------------------------------------------------- チームのシーズン成績

   指標の定義（並び・書式・良し悪しの向き）は `team_stats.json` の `metrics`
   が持っている。ここは描くだけ。増減は `build_page1.py` の TEAM_METRICS を
   直せば両方に効く。

   ★ 列の見出しは「攻撃 / 守備」。`DREB%` は相手に許した値ではなく自軍の
     守備リバウンド率、`TOV/100` の守備側は**奪った**数なので、
     「被」と書くと嘘になる。 */

function fmtM(v, f) {
  if (v === undefined || v === null) return '<span class="dim">—</span>';
  if (f === 'p') return (v * 100).toFixed(1) + '%';
  if (f === 0) return Math.round(v).toLocaleString();
  return v.toFixed(1);
}

/* 順位の色。1-10 を良い側、21-30 を悪い側に寄せる。
   向き 0（良し悪しが無い指標）は色を付けない */
function rkCell(rk, n, dir) {
  if (rk === undefined || rk === null) return '';
  let c = 'dim';
  if (dir) c = rk <= 10 ? 'up' : rk >= n - 9 ? 'down' : 'dim';
  return `<span class="rk ${c}">${rk}</span>`;
}

function teamStats(ts, tri) {
  const c = ts.cur[tri];
  const n = ts.n || 30;
  const hist = ts.hist[tri] || [];
  if (!c) return `<p class="empty">今季の成績がまだ無い。</p>`;

  const groups = ts.metrics.map((g) => `
    <tbody class="grp"><tr><th colspan="5">${esc(g.group)}</th></tr></tbody>
    <tbody>${g.rows.map((r) => `<tr>
      <td class="lbl">${esc(r.label)}</td>
      <td class="n">${fmtM(c[r.a], r.f)}</td>
      <td class="n">${rkCell(c.rk[r.a], n, r.da)}</td>
      <td class="n">${r.b ? fmtM(c[r.b], r.f) : ''}</td>
      <td class="n">${r.b ? rkCell(c.rk[r.b], n, r.db) : ''}</td>
    </tr>`).join('')}</tbody>`).join('');

  return `
    <h2>今季の指標<span class="hdrsub">${esc(ts.season)} / ${c.g} 試合</span></h2>
    <p class="sub">数字の右の小さい数は<strong>リーグ 30 チーム中の順位</strong>。
      <span class="rk up">緑</span> が上位 10、<span class="rk down">赤</span> が下位 10。
      ペースや 3PA 率のように良し悪しが決まらない指標には色を付けていない。
      率は<strong>カウントから直に</strong>出している（試合ごとの率の平均ではない）。
      ORtg / DRtg だけ<strong>ポゼッションで重み付け</strong>した加重平均。</p>
    <div class="wrap"><table class="tstat">
      <thead><tr><th>指標</th><th class="n">攻撃</th><th class="n">順</th>
        <th class="n">守備</th><th class="n">順</th></tr></thead>
      ${groups}
    </table></div>

    <h2>シーズン別<span class="hdrsub">レギュラーシーズン</span></h2>
    <div class="wrap"><table class="career">
      <thead><tr><th>シーズン</th><th class="n">試合</th><th class="n">勝敗</th>
        <th class="n">勝率</th><th class="n">conf</th>
        <th class="n">得点</th><th class="n">失点</th><th class="n">差</th>
        <th class="n">ORtg</th><th class="n">DRtg</th><th class="n">Net</th>
        <th class="n">ペース</th><th class="n">eFG%</th><th class="n">被eFG%</th>
        <th class="n">3PA率</th></tr></thead>
      <tbody>${hist.map((h) => `<tr class="${
        h.season === ts.season ? 'nowrow' : ''}">
        <td>${esc(h.season)}</td>
        <td class="n dim">${h.g}</td>
        <td class="n">${h.w}-${h.l}</td>
        <td class="n">${h.pct === null ? '—'
          : h.pct.toFixed(3).replace(/^0/, '')}</td>
        <td class="n dim">${h.rk_conf ?? '—'}</td>
        <td class="n">${num(h.pf)}</td>
        <td class="n">${num(h.pa)}</td>
        <td class="n ${h.diff > 0 ? 'up' : 'down'}">${
          h.diff > 0 ? '+' : ''}${num(h.diff)}</td>
        <td class="n">${num(h.ortg)}</td>
        <td class="n">${num(h.drtg)}</td>
        <td class="n ${h.net > 0 ? 'up' : 'down'}">${
          h.net > 0 ? '+' : ''}${num(h.net)}</td>
        <td class="n dim">${num(h.pace)}</td>
        <td class="n">${fmtM(h.efg, 'p')}</td>
        <td class="n">${fmtM(h.efg_op, 'p')}</td>
        <td class="n dim">${fmtM(h.tpa_rate, 'p')}</td>
      </tr>`).join('')}</tbody>
    </table></div>
    <p class="sub">conf はカンファレンス内の順位（勝率順。<strong>この表から
      計算している</strong>。派生表は進行中の季に追いついていないので使っていない）。
      今季の行は<strong>途中の値</strong>で、試合数が少ないので大きく動く。
      得点の内訳とトラッキングは今季ぶんだけ上の表に出している。</p>`;
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
      <th>対戦</th><th>結果</th><th>H/A</th><th>会場</th><th>TV</th></tr></thead>
    <tbody>
    ${gs.map((g) => {
      const home = g.h === tri;
      const opp = home ? g.a : g.h;
      /* 終わった試合は「結果」が試合ページへの入口。`p: 0` の試合は
         個別ページを作っていないのでリンクにしない（日程の一覧と同じ） */
      const r = (RESULTS || {})[g.game_id];
      const done = r && r.ap !== null && r.ap !== undefined
                     && r.hp !== null && r.hp !== undefined;
      const mine = done ? (home ? r.hp : r.ap) : null;
      const they = done ? (home ? r.ap : r.hp) : null;
      const score = done
        ? `<span class="wl ${mine > they ? 'w' : 'l'}">${mine > they ? '○' : '●'}</span>`
          + `${mine}-${they}${r.np > 4 ? ` <span class="ot">OT</span>` : ''}`
        : '';
      const res = !done ? '<span class="dim">—</span>'
        : r.p === 0
          ? `<span class="res nolink" title="この試合は個別ページを作っていない"
               >${score}</span>`
          : `<a class="res" href="#/game/${esc(g.game_id)}">${score}</a>`;
      /* 注目チーム同士の試合は行ごと色を変える */
      const cls = [g.d < t ? 'dim' : '', favCls(tri, opp).trim()]
        .filter(Boolean).join(' ');
      return `<tr${cls ? ` class="${cls}"` : ''}>
        <td>${fmtDate(g.d)}</td>
        <td class="n dim">${esc(g.t || '')}</td>
        <td class="n">${esc(jst(g))}</td>
        <td><a class="tm${FAV.has(opp) ? ' is-fav' : ''}"
               href="#/team/${esc(opp)}">${esc(opp)}</a>
            ${g.label ? `<span class="badge">${esc(g.label)}</span>` : ''}</td>
        <td>${res}</td>
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
  await results();   /* 今季の試合ログから試合ページへ飛ばすため */
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
    ${car ? gameLog(car) : ''}
    ${car ? injTable(car) : ''}
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

/* ------------------------------------------------- 今季の試合ごとの成績
   ★ **出場した試合しか出ない。** DNP と欠場は `player_game_base` に
     行が無いので、ここには現れない（「試合数」は出場した数）。
   ★ 先発は `player_track.position`。最新日の試合はトラッキングが
     まだ返らないので、その試合だけ不明（`null`）になる。 */

function gameLog(car) {
  const log = car.log || [];
  const season = car.season || '';
  if (!log.length) {
    return `<h2>今季の試合</h2>
      <p class="empty">${esc(season)} の出場記録がまだ無い。</p>`;
  }
  /* 平均はシーズン行をそのまま使う（careerTable と同じ数字になる） */
  const cur = (car.seasons || []).find((s) => s.y === season && s.st === 'R');
  const w = log.filter((r) => r.w).length;
  const sum = `<p class="sub">
    ${log.length} 試合（<strong>${w} 勝 ${log.length - w} 敗</strong>）${
      cur && cur.gs !== null && cur.gs !== undefined
        ? `・先発 ${cur.gs}` : ''}${cur ? `・1 試合平均
    <strong>${num(cur.mpg)} 分 / ${num(cur.pts)} 点 /
    ${num(cur.reb)} REB / ${num(cur.ast)} AST</strong>` : ''}</p>`;

  const rows = log.map((r) => {
    const res = (RESULTS || {})[r.g];
    const vs = `${r.h ? 'vs' : '@'} ${esc(r.o)}`;
    const sc = `<span class="wl ${r.w ? 'w' : 'l'}">${r.w ? '○' : '●'}</span
      >${esc(r.sc)}`;
    /* ★ 対戦と結果の**両方**を試合ページへの入口にする。チームページの
       日程表は「結果」列が入口なので、そろえておかないと迷う。
       個別ページを作っていない試合（EXCLUDE_TRI）はリンクにしない */
    const to = (inner) => (res && res.p !== 0)
      ? `<a class="res" href="#/game/${esc(r.g)}">${inner}</a>`
      : `<span class="dim nolink" title="この試合は個別ページを作っていない"
           >${inner}</span>`;
    return `<tr>
      <td class="n">${esc(r.d.slice(5).replace('-', '/'))}</td>
      <td>${to(vs)}</td>
      <td class="n">${to(sc)}</td>
      <td class="n">${r.s === 1 ? '先発'
        : r.s === 0 ? '<span class="dim">—</span>'
          : '<span class="dim" title="トラッキングがまだ来ていない">?</span>'}</td>
      <td class="n">${esc(r.mp)}</td>
      <td class="n b">${r.pts}</td>
      <td class="n">${r.reb}</td>
      <td class="n">${r.ast}</td>
      <td class="n">${r.fgm}-${r.fga}</td>
      <td class="n">${r.tpm}-${r.tpa}</td>
      <td class="n">${r.ftm}-${r.fta}</td>
      <td class="n">${r.stl}</td>
      <td class="n">${r.blk}</td>
      <td class="n">${r.tov}</td>
      <td class="n">${r.pf}</td>
      <td class="n ${r.pm > 0 ? 'up' : r.pm < 0 ? 'down' : ''}">${
        r.pm > 0 ? '+' : ''}${r.pm ?? 0}</td>
    </tr>`;
  }).join('');

  return `<h2>今季の試合</h2>${sum}
    <div class="wrap"><table class="career loggame">
      <thead><tr><th class="n">日付</th><th>対戦</th><th class="n">結果</th>
        <th class="n">先発</th><th class="n">MP</th><th class="n">PTS</th>
        <th class="n">REB</th><th class="n">AST</th><th class="n">FG</th>
        <th class="n">3P</th><th class="n">FT</th><th class="n">STL</th>
        <th class="n">BLK</th><th class="n">TOV</th><th class="n">PF</th>
        <th class="n">+/-</th></tr></thead>
      <tbody>${rows}</tbody>
    </table></div>
    <p class="sub">新しい順。<strong>出場した試合だけ</strong>で、DNP と欠場は
      入らない。<strong>対戦と結果</strong>を押すとその試合のページへ飛ぶ。${
      EXCLUDE_NOTE.length ? `灰色の行は個別ページを作っていない試合
      （${EXCLUDE_NOTE.join(' / ')} が絡む試合）。` : ''}</p>`;
}

/* ------------------------------------------- 今季の injury report（選手別）
   ★ 「載った」と「欠場した」は別物。Questionable で載って出場した試合も
     ここに出る。出場したかどうかは試合ログの有無で判る。
   ★ ティップより後の版は VPS 側で切ってある（`slot_ts_utc <= tip_utc`）。 */

function injTable(car) {
  const list = car.inj || [];
  if (!list.length) return '';
  const played = new Set((car.log || []).map((r) => r.g));
  const n = {};
  for (const r of list) n[r.first] = (n[r.first] || 0) + 1;
  const sum = STATUS_ORDER.filter((k) => n[k]).map((k) => `${k} ${n[k]}`).join(' / ');
  const rows = list.map((r) => `<tr>
    <td class="n">${esc((r.d || '').slice(5).replace('-', '/'))}</td>
    <td>${(RESULTS || {})[r.g]
      ? `<a href="#/game/${esc(r.g)}">${r.h ? 'vs' : '@'} ${esc(r.o || '')}</a>`
      : `<span class="dim">${r.h ? 'vs' : '@'} ${esc(r.o || '')}</span>`}</td>
    <td>${stTag(r.first)}<span class="hb">${beforeTip(r.fh)}</span></td>
    <td>${(r.final && r.final !== r.first) ? stTag(r.final)
      : '<span class="dim">変化なし</span>'}<span class="hb">${
      beforeTip(r.lh)}</span></td>
    <td class="n">${!(RESULTS || {})[r.g]
      ? '<span class="dim">結果待ち</span>'
      : played.has(r.g)
        ? '<span class="wl w">○</span>出場'
        : '<span class="wl l">●</span>欠場'}</td>
    <td class="dim rsn2">${esc(r.reason || '')}</td>
  </tr>`).join('');
  return `<h2>今季の injury report</h2>
    <p class="sub">${list.length} 試合で名前が載った（初出の時点で ${
      esc(sum || '記載なし')}）。
      <strong>載った＝欠場ではない</strong>。Questionable から出場した試合も入る。
      ★ ボックススコアがまだ入っていない試合は<strong>「結果待ち」</strong>。
      欠場と区別している（injury は VPS が 15 分ごと、結果は 1 日 1 回なので
      injury のほうが先に入る）。</p>
    <div class="wrap"><table class="career injlog">
      <thead><tr><th class="n">日付</th><th>対戦</th><th>初出</th><th>最終</th>
        <th class="n">結果</th><th>理由</th></tr></thead>
      <tbody>${rows}</tbody>
    </table></div>
    <p class="sub">時刻は試合の何時間前か。ティップより後の版は除いてある。</p>`;
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
  /* ★ 3P は **成功数**（tpm）。試投（tpa）ではない。
     1本ずつ増える量なので、1分1回の試行という前提にはよく合う。 */
  { k: 'tpm', label: '3P 成功' },
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
  /* ★ 率が 0 の項目は図を出さない。二項分布に p = 0 を入れると
     「0 以外は起こらない」という分布になり、over が 0% と出る。
     3P は該当が多い（記録のある選手の 1 割強が直近3季で 0 本）。 */
  const ok = (st) => Number.isFinite(car.r3[st.k]) && car.r3[st.k] > 0;
  const live = STATS.filter(ok);
  const dead = STATS.filter((st) => !ok(st));
  return `<div class="mpbar">
      <button data-mp="-5">−5</button>
      <button data-mp="-1">−1</button>
      <input type="range" id="mprange" min="1" max="48" step="1" value="${mp}">
      <button data-mp="1">+1</button>
      <button data-mp="5">+5</button>
      <span class="now"><strong>${mp}</strong> 分</span>
      <button data-mp="reset" class="today">30 分に戻す</button>
    </div>
    ${live.map((st) => statBlock(car, st, mp)).join('')}
    ${!dead.length ? '' : `<p class="sub">★ ${dead.map((st) => esc(st.label))
      .join('・')}は、この期間（${esc(car.r3.label)}）の記録が
      <strong>0</strong> なので出していない。
      率を 0 と置くと「絶対に記録しない」という分布になり、
      <strong>over が 0% と出てしまう</strong>（実際は小さいだけで 0 ではない）。
      それより古い季に記録があるかは、上のシーズン別の表を見ること。</p>`}`;
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
          <strong>3P 成功・アシスト・リバウンドは1つずつ増える</strong>ので、
          この前提とよく合う。
        </p>
        <p>
          ★ 3P は<strong>試投と成功率の積</strong>なので、
          1分あたりの成功数だけを見ると
          「打っていないのか、入っていないのか」が区別できない。
          上のシーズン別の 3PA / 3P% と併せて見ること。
          当たり外れが日によってまとまる（よく言われる「当たっている日」）ぶん、
          実際のばらつきは二項分布より大きい。
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
          <a href="#/report/${esc(r.day)}">${esc(repName(r.day))}</a>
          ${r.summary ? `<span class="sub">${esc(r.summary)}</span>` : ''}
        </li>`).join('')}
    </ul>`;
}

/* 速報（`2026-11-04-first`）は確定版と別ファイル。一覧の見出しに出す名前 */
const repName = (day) => (day.endsWith('-first')
  ? `${day.slice(0, 10)} 速報` : day);

async function renderReport(day) {
  /* ★ 速報は `YYYY-MM-DD-first`。ここを `YYYY-MM-DD` だけにすると
     **速報を開いたときに「日付が不正」になる**（2026-11-04 に出た）。
     JSON も一覧も出来ていて、この検査だけが弾いていた */
  if (!/^\d{4}-\d{2}-\d{2}(-first)?$/.test(day)) {
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

/* ★ **先に秒を丸めてから割ること。** 分と秒を別々に丸めると、
   1139.6 秒が floor(18) と round(59.6)=60 で **`18:60`** になる
   （2026-11-02 に本番で出た）。 */
const mmss = (sec) => {
  if (sec === null || sec === undefined) return '—';
  const s = Math.round(sec);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

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

/* 版の時刻を「試合の何時間前か」に直す。1 時間未満は分で出す */
const beforeTip = (h) => (h === null || h === undefined) ? ''
  : h < 0 ? `${(-h).toFixed(1)}時間後`
    : h < 0.05 ? 'ティップ直前'
      : h < 1 ? `${Math.round(h * 60)}分前` : `${h.toFixed(1)}時間前`;

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
    <td>${esc(p.name)}${p.reason
      ? `<span class="rsn">${esc(p.reason)}</span>` : ''}</td>
    <td>${stTag(p.first)}<span class="hb">${beforeTip(p.fh)}</span></td>
    <td>${(p.final && p.final !== p.first) ? stTag(p.final)
      : '<span class="dim">変化なし</span>'}<span class="hb">${
      beforeTip(p.lh)}</span></td>
  </tr>`).join('');
  const n = {};
  for (const p of list) n[p.first] = (n[p.first] || 0) + 1;
  const summary = STATUS_ORDER.filter((k) => n[k]).map((k) => `${k} ${n[k]}`).join(' / ');
  /* 記載がいつ始まっていつ最後に動いたか。最も早い初出と最も遅い最終を取る */
  const fh = list.map((p) => p.fh).filter((v) => v || v === 0);
  const lh = list.map((p) => p.lh).filter((v) => v || v === 0);
  const span = fh.length
    ? `<br>記載は ${beforeTip(Math.max(...fh))} 〜 ${beforeTip(Math.min(...lh))}`
    : '';
  return `<h3>${esc(tri)}</h3>
    <p class="sub">初出の時点で ${esc(summary || '記載なし')}${
      out.length ? `・実際の欠場 ${out.length} 名` : ''}${span}</p>
    ${list.length ? `<div class="wrap"><table class="injtab">
      <thead><tr><th>選手</th><th>初出</th><th>最終</th></tr></thead>
      <tbody>${rows}</tbody></table></div>` : ''}
    ${out.length ? `<p class="sub">実際の欠場: ${out.map(esc).join(' / ')}</p>` : ''}`;
}

/* ---- コメント記録 -----------------------------------------------------
   ★ このサイトは GitHub Pages の静的ページで、書き込み先のサーバが無い。
     記録は **ブラウザの localStorage** に置く。つまり
     **その端末のそのブラウザにしか残らない**（別の端末からは見えないし、
     閲覧データを消すと消える）。リポジトリに残したいなら、別途
     書き出して `build_games.py` 側で JSON に焼き込む仕掛けが要る。
   ★ プライベートウィンドウや設定によっては読み書きで例外が飛ぶので、
     必ず try で囲んで「読めなくても画面は出る」ようにする */

const NOTE_KEY = (gid) => `nba.note.${gid}`;

function notesLoad(gid) {
  try {
    const v = JSON.parse(localStorage.getItem(NOTE_KEY(gid)) || '[]');
    return Array.isArray(v) ? v : [];
  } catch (e) { return []; }
}

function notesSave(gid, list) {
  try { localStorage.setItem(NOTE_KEY(gid), JSON.stringify(list)); return true; }
  catch (e) { return false; }
}

const noteStamp = (iso) => {
  const d = new Date(iso);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
    + ` ${p(d.getHours())}:${p(d.getMinutes())}`;
};

function notesHtml(list) {
  if (!list.length) return '<p class="empty">まだ記録が無い。</p>';
  return list.map((n, i) => `<div class="nitem">
    <div class="nhead"><span class="nt">${esc(noteStamp(n.t))}</span>
      <button class="ndel" data-i="${i}" title="この記録を消す">×</button></div>
    <div class="nc">${esc(n.c)}</div>
  </div>`).join('');
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
  /* ★ injury と横に並べるので段が狭い。横長のままだと高さが潰れる */
  const W = 640, H = 300, L = 48, R = 10, T = 12, B = 30;
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

  /* 目盛り。縦は 4 本。横は幅が狭いので範囲に応じて粗くする */
  const span = x1 - x0;
  const step = span > 2880 ? 1440 : span > 1200 ? 720 : span > 480 ? 240 : 120;
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
  await books();
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
    <p class="sub"><a href="#/d/${esc(g.date)}">&larr; ${fmtDate(g.date)}の日程</a>
      ${bookLink(g.date, g.away, g.home)}</p>

    <div class="gamehead${favCls(g.away, g.home)}">
      <div class="side">
        <a href="#/team/${esc(g.away)}"
           class="tri${FAV.has(g.away) ? ' is-fav' : ''}">${esc(g.away)}</a>
        <span class="pts ${aw > hm ? 'win' : ''}">${aw ?? '—'}</span>
      </div>
      <div class="vs">－</div>
      <div class="side home">
        <span class="pts ${hm > aw ? 'win' : ''}">${hm ?? '—'}</span>
        <a href="#/team/${esc(g.home)}"
           class="tri${FAV.has(g.home) ? ' is-fav' : ''}">${esc(g.home)}</a>
      </div>
    </div>
    <p class="sub center">
      ${fmtDate(g.date)}${g.tip_et
        ? `・${esc(g.tip_et)} ET（日本 ${esc(g.tip_jst)}）` : ''}${g.arena
        ? `・${esc(g.arena)}` : ''}${g.city ? `（${esc(g.city)}）` : ''}${
        g.periods.length > 4 ? `・<strong>延長 ${g.periods.length - 4}</strong>` : ''}
    </p>

    ${warn.length ? `<p class="err">${warn.map(esc).join(' / ')}</p>` : ''}

    <div class="sidebyside">
      <section class="pane">
        <h2>クォーター別</h2>
        ${quarterTable(g)}
        ${scorePath(g)}
      </section>
      <section class="pane note">
        <h2>コメント記録</h2>
        <div class="notebox"><div class="noteinner">
          ${(g.pnotes || []).length ? `<div class="pubwrap">
            ${g.pnotes.map((n) => `<div class="pubnote">
              <span class="nt">${esc(noteStamp(n.t))}</span><span class="pub"
                >公開済み</span>
              <div class="nc">${esc(n.c)}</div></div>`).join('')}
          </div>` : ''}
          <div class="notelist" id="notelist"></div>
          <form id="noteform">
            <textarea id="notetext" rows="2"
              placeholder="この試合について（記録するとこの端末に残る）"></textarea>
            <button type="submit">記録</button>
          </form>
        </div></div>
      </section>
    </div>

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

    <div class="sidebyside">
      <section class="pane">
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
      </section>
      <section class="pane inj">
        <h2>injury report</h2>
        <div class="injbox"><div class="injscroll">
          ${[g.away, g.home].map((t) => injuryTable(g, t)).join('')}
        </div></div>
      </section>
    </div>

    <h2>ボックススコア</h2>
    <div class="qtabs" id="qtabs">
      <button class="on" data-q="all">全体</button>
      ${g.periods.map((q) => `<button data-q="${esc(q)}">${esc(q)}</button>`).join('')}
    </div>
    <div id="boxwrap"></div>
  `;

  /* コメント記録。保存先は localStorage（この端末のこのブラウザだけ） */
  const nl = document.getElementById('notelist');
  if (nl) {
    let notes = notesLoad(gid);
    const draw = () => { nl.innerHTML = notesHtml(notes); };
    draw();
    document.getElementById('noteform').onsubmit = (e) => {
      e.preventDefault();
      const ta = document.getElementById('notetext');
      const c = ta.value.trim();
      if (!c) return;
      const next = [{ t: new Date().toISOString(), c }, ...notes];
      if (!notesSave(gid, next)) {
        alert('この環境では記録を保存できない（localStorage が使えない）。');
        return;
      }
      notes = next;
      ta.value = '';
      draw();
    };
    nl.onclick = (e) => {
      const b = e.target.closest('button[data-i]');
      if (!b) return;
      const next = notes.filter((_, i) => i !== Number(b.dataset.i));
      notesSave(gid, next);
      notes = next;
      draw();
    };
  }

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

/* ----------------------------------------------------------- プロップ
   Pinnacle のプレイヤープロップ。`props.json` は PC 側の
   `fetch_props.py` が任意のタイミングで作る（定期更新ではない）。
   ★ Pinnacle は 1 選手 1 ライン（alternate を出さない）ので市場を列にした表に
     畳める。US のブックを混ぜるとラダーが来るのでセルに複数行並ぶ。
   ★ JSON が無い段階でも落ちないこと。取得前は案内だけ出す。 */

const TIP_ET = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hour12: false });
const TIP_JST = new Intl.DateTimeFormat('ja-JP', {
  timeZone: 'Asia/Tokyo', month: 'numeric', day: 'numeric',
  hour: '2-digit', minute: '2-digit', hour12: false });
const DAY_ET = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/New_York', month: '2-digit', day: '2-digit' });

/* アメリカン -> デシマル。+150 なら 2.50、-110 なら 1.91。
   ★ 小数2桁で丸める。1.909090… を 1.9 と書くと -111 と区別が付かない。 */
const dec = (v) => {
  if (v === null || v === undefined) return '—';
  const a = Number(v);
  if (!isFinite(a) || a === 0) return '—';
  return (a > 0 ? 1 + a / 100 : 1 + 100 / -a).toFixed(2);
};

const propsCell = (arr, labels) => {
  if (!arr || !arr.length) return '<span class="dim">—</span>';
  /* ラインが大きい順。Pinnacle なら 1 本しかない */
  return arr.slice().sort((a, b) => (a.pt ?? 0) - (b.pt ?? 0)).map((l) => `<span
    class="pl"><b>${l.pt === null || l.pt === undefined
      ? '—' : Number(l.pt).toFixed(1)}</b><span class="po">(${
      dec(l.o)} / ${dec(l.u)})</span></span>`).join('');
};

/* 月の表示。カレンダーの見出しと移動に使う */
const MONTH_JA = (ym) => {
  const [y, m] = ym.split('-');
  return y + ' 年 ' + Number(m) + ' 月';
};
const ymOf = (d) => d.slice(0, 7);
const addMonth = (ym, n) => {
  const [y, m] = ym.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1 + n, 1));
  return t.getUTCFullYear() + '-' + String(t.getUTCMonth() + 1).padStart(2, '0');
};

/* 最終更新の書き方。JST と UTC を並べる。
   ★ 「取得時刻」ではなく「最終更新」と呼ぶ。その日の板のうち一番新しい回。 */
const UPD_JST = new Intl.DateTimeFormat('ja-JP', {
  timeZone: 'Asia/Tokyo', year: 'numeric', month: 'numeric', day: 'numeric',
  hour: '2-digit', minute: '2-digit', hour12: false });
const updText = (iso) => {
  if (!iso) return '最終更新 不明';
  const t = new Date(iso);
  const age = (Date.now() - t) / 60000;
  const ago = !isFinite(age) ? '' : (age < 90
    ? ' （' + Math.round(age) + ' 分前）'
    : (age < 48 * 60 ? ' （' + (age / 60).toFixed(1) + ' 時間前）'
      : ' （' + Math.round(age / 1440) + ' 日前）'));
  return '最終更新 ' + UPD_JST.format(t) + ' JST / '
    + iso.replace('T', ' ').slice(0, 16) + ' UTC' + ago;
};

/* 覚えておく表示月。ハッシュには入れない（日付を選ぶのが主役なので） */
let PROPS_MONTH = null;

/* カレンダー。データのある日だけリンクにする。 */
function propsCalendar(ixMap, ym, sel) {
  const [y, m] = ym.split('-').map(Number);
  const first = new Date(Date.UTC(y, m - 1, 1));
  const days = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const lead = first.getUTCDay();
  const cells = [];
  for (let i = 0; i < lead; i += 1) cells.push('<td class="pad"></td>');
  for (let d = 1; d <= days; d += 1) {
    const iso = ym + '-' + String(d).padStart(2, '0');
    const row = ixMap[iso];
    const cls = ['pday'];
    if (iso === sel) cls.push('sel');
    if (!row) cls.push('none');
    const inner = row
      ? '<a href="#/props/' + iso + '"><span class="dnum">' + d + '</span>'
        + '<span class="dg">' + row.games + ' 試合</span></a>'
      : '<span class="dnum">' + d + '</span>';
    cells.push('<td class="' + cls.join(' ') + '">' + inner + '</td>');
  }
  while (cells.length % 7 !== 0) cells.push('<td class="pad"></td>');
  const weeks = [];
  for (let i = 0; i < cells.length; i += 7) {
    weeks.push('<tr>' + cells.slice(i, i + 7).join('') + '</tr>');
  }
  const names = ['日', '月', '火', '水', '木', '金', '土'];
  return '<div class="pcal">'
    + '<div class="pcalhd">'
    + '<button id="pprev" type="button">◀</button>'
    + '<strong>' + MONTH_JA(ym) + '</strong>'
    + '<button id="pnext" type="button">▶</button>'
    + '</div>'
    + '<table class="cal"><thead><tr>'
    + names.map((n) => '<th>' + n + '</th>').join('')
    + '</tr></thead><tbody>' + weeks.join('') + '</tbody></table></div>';
}

/* カレンダーの月送り。ハッシュを変えずに描き替える（選んだ日は保つ） */
function wireCal(ixMap, ym, sel) {
  const go = (n) => {
    const next = addMonth(ym, n);
    PROPS_MONTH = next;
    const host = view.querySelector('.pcal');
    if (!host) return;
    host.outerHTML = propsCalendar(ixMap, next, sel);
    wireCal(ixMap, next, sel);
  };
  const prev = view.querySelector('#pprev');
  const nxt = view.querySelector('#pnext');
  if (prev) prev.onclick = () => go(-1);
  if (nxt) nxt.onclick = () => go(1);
}

async function renderProps(day) {
  const how = '<p class="sub">収集は VPS が'
    + ' <strong>ティップの 10 時間前から 1 試合 10 回</strong>、近づくほど細かく'
    + '（90分間隔 → 30分間隔、最後は 5 分前）取る。injury report で status が'
    + '動いた試合は次の回を前倒しする。サイトへの貼り直しは PC の'
    + ' <code>NBA_Props_Publish</code>（30 分おき）。'
    + '過去の日付を作り直すなら'
    + ' <code>python fetch_props.py --export-only --all-dates</code>。'
    + '<strong>サイトのボタンにはできない</strong>：公開リポジトリの静的サイトなので'
    + 'API の鍵を置けず、書き込み先のサーバも無い。</p>';

  let ix = null;
  try {
    ix = await load('props/index');
  } catch (e) {
    ix = null;
  }
  const dates = (ix && ix.dates) || [];
  if (!dates.length) {
    view.innerHTML = '<h1>プレイヤープロップ</h1>'
      + '<p class="empty">まだ取得していない。</p>' + how;
    return;
  }
  const ixMap = Object.fromEntries(dates.map((r) => [r.d, r]));
  const newest = dates[dates.length - 1].d;
  if (day && !ixMap[day]) {
    PROPS_MONTH = ymOf(newest);
    view.innerHTML = '<h1>プレイヤープロップ</h1>'
      + '<p class="empty">' + esc(day) + ' の板は無い。</p>'
      + propsCalendar(ixMap, PROPS_MONTH, null) + how;
    wireCal(ixMap, PROPS_MONTH, null);
    return;
  }
  PROPS_MONTH = ymOf(day || newest);

  /* ★ 日付を選ぶまで中身は出さない。カレンダーと目次だけ。 */
  if (!day) {
    const list = dates.slice().reverse().slice(0, 14).map((r) => '<li>'
      + '<a href="#/props/' + r.d + '">' + r.d + '</a> <span class="dim">'
      + r.games + ' 試合 ・' + r.rows + ' 行 ・'
      + esc(updText(r.last_update_utc)) + '</span></li>').join('');
    view.innerHTML = '<h1>プレイヤープロップ</h1>'
      + '<p class="sub">日付を選ぶと、その日の板を出す。'
      + '<strong>記録のある日だけ</strong>が押せる（全 ' + dates.length + ' 日）。</p>'
      + propsCalendar(ixMap, PROPS_MONTH, null)
      + '<h2>最近の日付</h2><ul class="snaps">' + list + '</ul>'
      + how;
    wireCal(ixMap, PROPS_MONTH, null);
    return;
  }

  let b = null;
  try {
    b = await load('props/' + day);
  } catch (e) {
    b = null;
  }
  if (!b || !(b.games || []).length) {
    view.innerHTML = '<h1>プレイヤープロップ</h1>'
      + '<p class="empty">' + esc(day) + ' の板が読めない。</p>'
      + propsCalendar(ixMap, PROPS_MONTH, day) + how;
    wireCal(ixMap, PROPS_MONTH, day);
    return;
  }
  const labels = (ix && ix.labels) || {};

  const games = (b.games || []).map((g) => {
    const tip = g.tip_utc ? new Date(g.tip_utc) : null;
    /* ★ 試合ごとに取得時刻が違う（刻み表が試合ごとに回る）。全体の時刻で
       lead を計算すると、先に取った試合の板が新しく見えてしまう。 */
    const gf = g.fetched_at_utc ? new Date(g.fetched_at_utc) : null;
    const lead = (g.lead_min !== null && g.lead_min !== undefined)
      ? g.lead_min / 60 : ((tip && gf) ? (tip - gf) / 3600000 : null);
    const mks = g.markets || [];
    const head = mks.map((m) => '<th class="n">' + esc(labels[m] || m)
      + '</th>').join('');
    const body = (g.players || []).map((pp) => '<tr><td>'
      + (pp.person_id ? '<a href="#/p/' + pp.person_id + '">' + esc(pp.name) + '</a>'
        : esc(pp.name)) + '</td>'
      + mks.map((m) => '<td class="n pcell">'
        + propsCell((pp.lines || {})[m], labels) + '</td>').join('')
      + '</tr>').join('');
    return '<section class="propgame"><h2>'
      + '<a href="#/team/' + esc(g.away) + '">' + esc(g.away) + '</a>'
      + '<span class="at">＠</span>'
      + '<a href="#/team/' + esc(g.home) + '">' + esc(g.home) + '</a>'
      + (tip ? '<span class="dim">' + DAY_ET.format(tip) + ' ' + TIP_ET.format(tip)
        + ' ET ・' + TIP_JST.format(tip) + ' JST</span>' : '')
      + (lead === null ? '' : (lead > 0
        ? '<span class="lead">ティップの ' + lead.toFixed(1) + ' 時間前の板</span>'
        : '<span class="lead late">ティップ後</span>'))
      + (gf ? '<span class="dim">' + esc(updText(g.fetched_at_utc)) + '</span>' : '')
      + '</h2><div class="wrap"><table class="career props">'
      + '<thead><tr><th>選手</th>' + head + '</tr></thead>'
      + '<tbody>' + body + '</tbody></table></div></section>';
  }).join('');

  view.innerHTML = '<h1>プレイヤープロップ <span class="dim">' + esc(day)
    + '</span></h1>'
    + '<p class="sub"><strong>' + esc(updText(b.last_update_utc)) + '</strong>'
    + ' ・ブック ' + esc((b.books || []).join(', '))
    + ' ・' + (b.games || []).length + ' 試合 ・' + b.n_rows + ' 行'
    + (b.hold_median === null || b.hold_median === undefined ? ''
      : ' ・hold 中央 ' + (b.hold_median * 100).toFixed(2) + '%') + '</p>'
    + '<p class="sub">各セルは <b>ライン</b> と'
    + '<span class="po">(Over / Under のデシマルオッズ)</span>。'
    + '★ <strong>Pinnacle のプロップの hold は実測で 7.0%（片側 3.5%）</strong>で、'
    + '研究が閾値に使っている 2.4%（-110/-110 相当）より重い。'
    + '★ Pinnacle は <strong>1 選手 1 ライン</strong>（ラダーを出さない）。</p>'
    + propsCalendar(ixMap, PROPS_MONTH, day)
    + games
    + how;
  wireCal(ixMap, PROPS_MONTH, day);
}

async function route() {
  const parts = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean);
  const nav = { schedule: 'on', standings: '', teams: '', players: '',
                market: '', props: '', notes: '', reports: '' };
  try {
    view.innerHTML = '<p class="loading">読み込み中…</p>';
    if (parts[0] === 'notes') {
      nav.schedule = ''; nav.notes = 'on';
      await renderNotes();
    } else if (parts[0] === 'market') {
      nav.schedule = ''; nav.market = 'on';
      await renderMarket();
    } else if (parts[0] === 'props') {
      /* #/props はカレンダーだけ。#/props/2026-11-06 でその日の板を出す */
      nav.schedule = ''; nav.props = 'on';
      await renderProps(parts[1] || null);
    } else if (parts[0] === 'standings') {
      nav.schedule = ''; nav.standings = 'on';
      await renderStandings();
    } else if (parts[0] === 'players') {
      nav.schedule = ''; nav.players = 'on';
      await renderLeague();
    } else if (parts[0] === 'teams') {
      nav.schedule = ''; nav.teams = 'on';
      await renderTeams();
    } else if (parts[0] === 'team' && parts[1]) {
      nav.schedule = ''; nav.teams = 'on';
      await renderTeam(parts[1].toUpperCase(), parts[2]);
    } else if (parts[0] === 'p' && parts[1]) {
      nav.schedule = ''; nav.players = 'on';
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

/* ----------------------------------------------------------- 検索
   選手 526 名とチーム 30 を名前で引く。新しい JSON は作らず、
   既にある rosters.json と teams.json をそのまま使う。
   ★ 初回フォーカスまで読みにいかない（日程だけ見る人に読ませない） */

let FIND = null;

/* ★ アクセントを落としてから比べる。落とさないと `jokic` で
   「Nikola Jokić」が出ない（実際に出なかった）。NBA の名簿には
   ć / č / ö / Á などが普通に入っている */
const fold = (s) => String(s || '').normalize('NFD')
  .replace(/[̀-ͯ]/g, '').toLowerCase();

async function findIndex() {
  if (FIND) return FIND;
  const [teams, rost] = await Promise.all([load('teams'), load('rosters')]);
  FIND = [];
  for (const t of teams) {
    FIND.push({ k: fold(`${t.tri} ${t.full_name}`),
                h: `#/team/${t.tri}`, n: t.full_name, s: t.tri });
  }
  for (const [tri, ps] of Object.entries(rost.teams || {})) {
    for (const p of ps) {
      FIND.push({ k: fold(`${p.name} ${tri}`),
                  h: `#/p/${p.id}`, n: p.name, s: tri });
    }
  }
  return FIND;
}

function initFind() {
  const box = document.getElementById('q');
  const res = document.getElementById('qres');
  if (!box || !res) return;
  let hits = [];
  const draw = () => {
    if (!hits.length) { res.hidden = true; res.innerHTML = ''; return; }
    res.innerHTML = hits.map((x, i) => `<a href="${x.h}" data-i="${i}">
      <span>${esc(x.n)}</span><span class="dim">${esc(x.s)}</span></a>`).join('');
    res.hidden = false;
  };
  const run = async () => {
    const q = fold(box.value.trim());
    if (q.length < 1) { hits = []; draw(); return; }
    const ix = await findIndex();
    hits = ix.filter((x) => x.k.includes(q)).slice(0, 12);
    draw();
  };
  box.oninput = run;
  box.onfocus = run;
  box.onkeydown = (e) => {
    if (e.key === 'Enter' && hits.length) {
      go(hits[0].h); box.blur();
    } else if (e.key === 'Escape') {
      box.value = ''; hits = []; draw(); box.blur();
    }
  };
  res.onclick = () => { box.value = ''; hits = []; draw(); };
  /* 外を押したら閉じる。`blur` だとリンクを押す前に消える */
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.find')) { hits = []; draw(); }
  });
}

/* データがいつ時点かをフッタに出す。記録として読むときに要る */
async function showAsOf() {
  const el = document.getElementById('asof');
  if (!el) return;
  try {
    const m = await load('manifest');
    const d = new Date(m.generated_at);
    const p = (n) => String(n).padStart(2, '0');
    el.textContent = `データは ${d.getFullYear()}-${p(d.getMonth() + 1)}-${
      p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())} 時点`;
  } catch (e) { /* 出せなくても本体は動く */ }
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

initFind();
showAsOf();

route();

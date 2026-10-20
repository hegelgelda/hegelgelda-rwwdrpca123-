# NBA 日程とロスター

2026-27 シーズンの日程と、各チームの在籍選手を表示する静的サイト。
**依存ライブラリなし**。`fetch` で JSON を読むだけで動く。

## 画面

| URL | 内容 |
|---|---|
| `#/` | 日程。日付を前後に動かせる。既定は「今日以降で最初に試合がある日」 |
| `#/d/2026-10-28` | その日の試合 |
| `#/w` | 今週の試合。月曜〜日曜（ET）。前週 / 翌週で動かせる |
| `#/w/2026-10-26` | その週の試合 |
| `#/teams` | チーム一覧（カンファレンス / ディビジョン別） |
| `#/team/DEN` | ロスター（前季の平均成績つき） |
| `#/team/DEN/schedule` | そのチームの全日程 |
| `#/p/203999` | 選手のシーズン別成績・出場時間の分布・期待値モデル |

## 構成

```
.
├── index.html
├── css/style.css
├── js/app.js
├── .nojekyll              ← GitHub Pages で必須
├── public/data1/          ← ビルド成果物。コミットする
│   ├── teams.json           3.1 KB   30チーム
│   ├── schedule.json      197.8 KB   1,200試合（ET と日本時間）
│   ├── rosters.json       108.8 KB   526選手
│   ├── players/             902.5 KB 452ファイル（1人1ファイル）
│   ├── players_index.json   4.2 KB
│   └── manifest.json        0.2 KB
├── .github/workflows/
│   └── update-data.yml    ← 日次＋手動の自動更新
└── tools/                 ← データ生成。サイトの動作には不要
    ├── build_page1.py       public/data1/ を作り直す
    ├── build_players.py     選手別の成績 JSON を作り直す
    ├── stamp_assets.py      index.html の css/js に ?v=ハッシュ を付ける
    ├── ddi.py               その読み込み（build_page1 / build_players で共有）
    ├── ddi_2627.parquet     起用ブレ指数（別計算の成果物。526名 x 26列）
    ├── seed_ci_db.py        CI 用の空 DuckDB を作る
    ├── team_dim.csv         その種データ（30チーム）
    ├── build_schedule.py    日程を NBA API から取り直す
    └── fetch_rosters.py     ロスターを NBA API から取り直す
```

**1ページあたりの転送は 15〜40 KB**（gzip）。選手ページは必要な1人ぶん
（平均 2.0 KB）だけを足で取りにいくので、452ファイル 0.9 MB を
まとめて読むことはない。

## ローカルで見る

`file://` だと `fetch` が CORS で弾かれるので、簡易サーバを立てる。

```bash
python -m http.server 8731
# → http://127.0.0.1:8731/
```

VS Code の Live Server 拡張でもよい。

## GitHub Pages へ出す

1. GitHub Desktop で Publish repository
2. GitHub → Settings → Pages → Source を `main` / `(root)`
3. `https://<ユーザー名>.github.io/nba-site/` で見られる

`public/data1/*.json` は生成物だが**コミットする**。
GitHub Pages にはビルド処理が無いため。

## css / js / データを直したとき

GitHub Pages は静的ファイルを `max-age=600` で返すので、直しても
訪問済みのブラウザには最大10分届かない。参照 URL にハッシュを付けて
別ファイル扱いにさせる。**コミットの前に走らせる。**

```bash
python tools/stamp_assets.py          # index.html を書き換える
python tools/stamp_assets.py --check  # ずれていたら終了コード 1
```

中身が変わらなければハッシュも変わらないので、何度走らせても害はない。

`public/data1/` 全体のハッシュは `js/app.js` の `DATA_V` に埋まり、
JSON の fetch URL に付く。**データを作り直したときも走らせる。**
これが無いと、列を足しても古い JSON が使われて「新しい列だけ出ない」
という形で壊れる（実際そうなった）。

★ ただし `index.html` 自身も10分キャッシュされる。
新しいハッシュが読まれるまでは最大10分かかり、そこは消せない。
消えるのは「css だけ新しくて js が古い」というズレのほう。

## 自動更新（GitHub Actions）

★ **GitHub のランナーからは NBA API に届かない。日次実行は止めてある。**

`stats.nba.com` は接続はできるが応答を返さない（`ReadTimeout`、30秒）。
クラウドの IP を弾いているとみられる。同じコードが手元の PC からは
3.8 秒で 1,274 行を取れるので、コードではなく経路の問題。

    run#2  NBA API に届かない: ReadTimeout:
           HTTPSConnectionPool(host='stats.nba.com', port=443):
           Read timed out. (read timeout=30)

ワークフロー自体は残してある（`tools/**` を直して push すると走る）。
**セルフホストランナー**（自分の PC に runner を入れる）なら自宅の IP で
出ていくので動く。その場合は `runs-on: self-hosted` にして cron を戻す。

`tools/probe_nba_api.py` は届くかどうかだけを試し、結果を注釈に出す。
Actions のログは未サインインでは読めないので、切り分けはこれを見る。

更新されるのは次の3つだけ。

| ファイル | 更新 | 理由 |
|---|---|---|
| `schedule.json` | ○ | NBA API の ScheduleLeagueV2 から取り直す |
| `rosters.json` の在籍・背番号など | ○ | CommonTeamRoster から取り直す |
| `teams.json` | ○ | `tools/team_dim.csv` から作る |
| `rosters.json` の前季平均 | ✕ | 試合ログが要る。既存の値を据え置く |
| `players/*.json` | ✕ | 同上。ローカルで作り直す |

試合ログの表（`player_game_base` / `panel_start` / `team_game_adv`）は
929MB の `nba.duckdb` にしか無く、リポジトリにも CI にも置けない。
そのため CI では**既存の JSON を据え置く**作りにしてある
（`build_page1.py` の `has_table()`）。

★ **ブラウザ上の「更新ボタン」は作れない。**
`stats.nba.com` は CORS を返さず、`cdn.nba.com` も `Failed to fetch` になる。
静的サイトには JSON の保存先も無い。更新は必ずサーバ側（Actions かローカル）。

★ stats.nba.com がクラウドの IP を弾くことがある。
Actions で落ちるようならログを見て、ローカル実行に切り替える。

## データの更新

元データの `nba.duckdb`（929MB）は**このリポジトリに入っていない**。
`tools/` のスクリプトは `--db` で場所を渡すか、環境変数 `NBA_DUCKDB` を使う。

```bash
# 1. 表示用 JSON を作り直す（DB があればこれだけでよい）
python tools/build_page1.py
python tools/build_players.py                         # 選手ページぶん
python tools/build_page1.py --db D:/data/nba.duckdb   # 場所を変えるとき

# 2. 元データごと取り直す（NBA API を叩く。nba_api が要る）
python tools/build_schedule.py --db C:/nba/nba.duckdb --seasons 2026-27
python tools/fetch_rosters.py  --db C:/nba/nba.duckdb --season 2026-27
```

★ **NBA Cup のノックアウト 24 試合は未掲載**（現在 1,200 / 1,230 試合）。
12月に組分けが終わったら `build_schedule.py` を再実行すると入る。

## 実装メモ

- **試合時刻は ET。** `game_schedule.tip_et` は「ET の壁時計を UTC として
  格納した値」なので、そのまま読むと実行環境のタイムゾーンでずれる
  （JST だと開幕戦が 00:00 になる）。
  `build_page1.py` は `TimeZone='America/New_York'` のうえで **`tip_utc`**
  を整形している。検算として ET 日付と `game_date` が
  レギュラー 15,645 件すべて一致することを確認済み。
- **NaN を JSON に書かない。** pandas の `NaN` は真値なので
  `if v else None` では落とせず、`json.dump` が不正な `NaN` を書く。
  `clean()` を通し、`allow_nan=False` で書き出し時に失敗させている。
- **ロスターの前季成績**は 2025-26 レギュラーシーズンの平均。
  新人・新規契約は「—」になる（526名中 73名）。
- **現在籍は `team_roster`。** `player_index` は12シーズンの和集合で、
  最新でも前季時点。実ロスターと比べると 525名中 196名（37%）ずれる。
- 日程に**結果は入っていない**。2026-27 はまだ始まっていない。
- **配色は Hyperliquid 準拠。** 地 `#0f1a1e` / パネル `#0f1a1f` /
  境界 `#273035` / 本文 `#f6fefd` / ミント `#50d2c1`。
  向こうが常時ダークなので `prefers-color-scheme` での切り替えはやめ、
  `color-scheme: dark` を宣言している（`<input type=date>` 等も暗くなる）。
  地とパネルがほぼ同色でカードは境界線で見せるため、
  行のホバーだけ `--hover` を別に持っている。
- **週の区切りは月曜〜日曜（ET）。** `schedule.json` の `d` は ET の試合日
  なので、週の計算は文字列のままやれば実行環境の TZ に左右されない。
  `getUTCDay()` は日曜=0 なので `(w + 6) % 7` で月曜起点に直している。
- **ロスターは前季 MPG の降順**が既定。前季に出場が無い選手（null）は
  末尾へ回す。`rosters.json` はキャッシュして使い回すので、
  並べ替えはコピーに対して行い元配列を壊さない。
- **出場時間の分布**は選手ページの一番下。1試合ごとの出場時間を
  2分刻み24本で数える（レギュラーのみ）。直近1シーズンと直近3シーズンを
  並べ、**y 軸の上限は2枚で共通**にしてある。別々に取ると形が違って見える。
  y は件数ではなく割合。母数が3倍ちがうため。
  生のログではなく**集計済みの箱**を配る（1人あたり +0.2 KB）。
- 画面が狭いときは SVG の **viewBox 自体を取り直す**。
  横 640 のまま 375px に縮めると目盛りの文字まで 0.6 倍になって読めない。
- **起用ブレ指数（DDI）** はロスター表（1季版）と選手ページ（1季・3季）の
  両方に出す。ロスター表は `DDI(帯内パーセンタイル)` の形。分布の図の真下にも出す。別途計算した
  `tools/ddi_2627.parquet` を `build_players.py` が選手ごとに配るだけで、
  ここでは再計算しない。定義と検算は `DDI_2627.md`（このリポジトリ外）。
  `person_id` は NBA の player_id と同じで、526名が過不足なく一致する。
  - 100 がリーグの真ん中。全体の SD は 7 前後。大きいほどブレる
  - ★ **生の DDI は出場時間の水準と独立ではない**（相関 −0.16）。
    出番の長い選手ほど低めに出るので、**選手間の比較は帯内パーセンタイル**
    （`pct_25` / `pct_3y`）で行う。そのため両方を併記している
  - ★ DDI は「**出た試合の**出場時間のブレ」。欠場そのもの（ロード管理）は
    入らない。LeBron や Durant が下位（安定側）に来るのはそのため
  - `flag_no_data = 1` の 88名は DDI = 100 を置いただけの行なので、
    数値を出さず「データなし」と表示する
  - パーセンタイルは試合数の下限（1季 20 / 3季 40）を満たす選手のみ
- **期待値モデル**は分布の下。通算の合計から 1分あたりの率 λ を出し、
  指定した出場時間 MP に対して **Binomial(n = MP, p = λ)** で
  得点・アシスト・リバウンドの分布と under 確率を出す。既定は 30 分。
  データは既存の通算行だけで足りるので、JSON は増やしていない。
  - λ は得点でも最大 0.925（Embiid）で全員 1 未満なので、
    「1分 = 1試行」の二項分布が成立する
  - ★ **得点は2点・3点とまとまって入る**ので、1分1回の試行に
    置き換えるとばらつきを小さく見積もる（Jokić 30分で SD 2.3 だが
    実際の試合ごとの得点の SD はこれよりずっと大きい）。
    アシストとリバウンドは1つずつ増えるのでこの前提と合う
  - ★ 出場時間そのものの不確実性は入っていない。
    「MP 分出たら」という条件つきの分布
- 選手ページの**ポストシーズンは `<details>` で畳んである**。
  開けば表示されるが、既定ではレギュラーシーズンと通算だけを出す。
- **多チーム在籍の季のチーム順は時系列**。`string_agg(distinct ...)` は
  順序が不定で、ビルドのたびに `ATL/GSW` と `GSW/ATL` が入れ替わって
  無意味な差分が出ていた。`list_distinct(list(... order by game_date))` に
  変えて、再実行しても同じ出力になることを確認済み。
- **選手ページは 1人1ファイル。** 全選手を1つの JSON にすると 0.9 MB を
  毎回読むことになるので `players/<player_id>.json` に割った。
  2021-22 以降に出場が無い 74名はファイルを作らず、
  404 を catch して「出場記録が無い」と出している。
- **率は合計から出す。** FG% / 3P% / FT% / TS% を試合ごとの率の平均で
  求めると出場時間の短い試合に引っ張られる。
  `build_players.py` は成功数と試投数をそれぞれ合計してから割っている。
- **選手ページは 2021-22 以降**だけを出す（`build_players.py` の `FIRST`）。
  DB は 2014-15 から持っているので、増やすならここを変えて再生成する。
- **先発数は `panel_start`。** 2021-22 以降はこの表の欠けが無いことを
  確認済み（`player_game_base` と突き合わせて missing 0）。
- **日本時間はビルド時に出す。** ET→JST は夏時間で +13h / +14h と
  変わるため、ブラウザ側で足し算せず `tip_utc` を `Asia/Tokyo` に
  落とした値（`tj`）と日付のずれ（`tjo`）を JSON に入れている。
  実際 10/30 の 22:00 ET は翌 11:00、11/2 の 21:00 ET も翌 11:00 になる。
- ★ **`q()` に渡す SQL に `--` コメントを書かない。**
  `q()` が改行を潰すので、以降のクエリ全体がコメントとして消える。

## 次にやること

- [ ] 試合結果の表示（シーズンが進んでから）
- [ ] 選手ページに試合ログ（今はシーズン別平均だけ）
- [ ] ロスターの並べ替え（今は MPG 降順の固定）
- [ ] 順位表
- [ ] モデルの予測
      — 先に「ある日付時点のレーティングを保存して未実施試合に当てる」
      経路が要る（既存の予測データは評価済み試合ぶんしか無い）

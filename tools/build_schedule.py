"""
build_schedule.py — リーグ日程の取得（未実施試合を含む）

これまでの DB は**すべて実施済み試合の結果**で、未実施試合が1件も無かった。
日程が無いと「試合日程の表示」も「事前分析」も入口が作れない。

    T2a game_schedule   試合単位の日程（開始時刻・会場・放送・ラベル）
    T2b team_schedule   チーム単位に展開し、休養日数・B2B・直近7日試合数を付ける

【取得元】
    nba_api の ScheduleLeagueV2（stats.nba.com）。
    ★ CDN の静的 JSON（cdn.nba.com/.../scheduleLeagueV2_1.json）は 403 で不可。
    ★ 独自ヘッダは付けない（CLAUDE.md: stats.nba.com が無応答になる）。

【game_status】
    1 = 未実施 / 2 = 進行中 / 3 = 終了

【season_type の判定】
    game_id の**3文字目1桁**で決まる（'0022400001' なら '2'）。
      1 プレシーズン / 2 レギュラー / 3 オールスター / 4 プレーオフ / 5 PlayIn
    エンドポイントはプレシーズンも返すので、用途に応じて絞ること。

【as-of の注意】
    home_wins / away_wins などの勝敗列は「取得時点」の値で、
    過去シーズンを取り直すと最終成績が入る。**予測には使わないこと。**
    順位が必要なら team_standings_daily の prev_* を使う。

使い方:
    python build_schedule.py                       # 全シーズン（2014-15〜2026-27）
    python build_schedule.py --seasons 2026-27
    python build_schedule.py --report-only
"""

from __future__ import annotations

import argparse
import os
import sys
import time

import duckdb
import numpy as np
import pandas as pd

try:
    sys.stdout.reconfigure(errors="replace")
except Exception:
    pass

DB = "nba.duckdb"
SLEEP = 1.5          # NBA.com への配慮。短くしない
SEASONS = [f"{y}-{str(y + 1)[2:]}" for y in range(2014, 2027)]

# game_id の3文字目1桁が種別。'0022400001' なら '2' = レギュラーシーズン。
# ★ 3文字取ると '224' になって判定できない（実際に一度間違えた）。
TYPE_BY_DIGIT = {"1": "Pre Season", "2": "Regular Season", "3": "All-Star",
                 "4": "Playoffs", "5": "PlayIn"}


def hr(t: str) -> None:
    print("\n" + "=" * 76)
    print(t)
    print("=" * 76)


def sub(t: str) -> None:
    print("\n" + "-" * 76)
    print(t)
    print("-" * 76)


# ================================================================== 取得

def fetch_season(season: str, tries: int = 3) -> pd.DataFrame:
    from nba_api.stats.endpoints import scheduleleaguev2
    last = None
    for i in range(tries):
        try:
            e = scheduleleaguev2.ScheduleLeagueV2(season=season, league_id="00",
                                                 timeout=60)
            return e.get_data_frames()[0]
        except Exception as ex:
            last = ex
            time.sleep(SLEEP * (i + 2))
    raise RuntimeError(f"{season}: 取得失敗 {last}")


def normalize(d: pd.DataFrame, season: str) -> pd.DataFrame:
    def col(name, default=None):
        return d[name] if name in d.columns else pd.Series([default] * len(d))

    bc = [c for c in d.columns
          if c.startswith("nationalBroadcasters_")
          and c.endswith("_broadcasterAbbreviation")]
    if bc:
        tv = (d[bc].astype("object")
              .apply(lambda r: "/".join(sorted({str(x) for x in r
                                                if pd.notna(x) and str(x).strip()})),
                     axis=1))
    else:
        tv = pd.Series([""] * len(d))

    out = pd.DataFrame({
        "season": season,
        "game_id": col("gameId").astype(str),
        "game_code": col("gameCode"),
        "game_status": pd.to_numeric(col("gameStatus"), errors="coerce"),
        "game_status_text": col("gameStatusText"),
        "game_date": pd.to_datetime(col("gameDate"), errors="coerce").dt.date,
        "tip_et": pd.to_datetime(col("gameDateTimeEst"), errors="coerce"),
        "tip_utc": pd.to_datetime(col("gameDateTimeUTC"), errors="coerce"),
        "week_number": pd.to_numeric(col("weekNumber"), errors="coerce"),
        "week_name": col("weekName"),
        "home_team_id": pd.to_numeric(col("homeTeam_teamId"), errors="coerce"),
        "home_tri": col("homeTeam_teamTricode"),
        "away_team_id": pd.to_numeric(col("awayTeam_teamId"), errors="coerce"),
        "away_tri": col("awayTeam_teamTricode"),
        "arena_name": col("arenaName"),
        "arena_city": col("arenaCity"),
        "arena_state": col("arenaState"),
        "is_neutral": col("isNeutral"),
        "game_label": col("gameLabel"),
        "game_sub_label": col("gameSubLabel"),
        "series_text": col("seriesText"),
        "if_necessary": col("ifNecessary"),
        "postponed_status": col("postponedStatus"),
        "national_tv": tv,
        # 取得時点の勝敗。★予測には使わない
        "home_wins_snap": pd.to_numeric(col("homeTeam_wins"), errors="coerce"),
        "home_losses_snap": pd.to_numeric(col("homeTeam_losses"), errors="coerce"),
        "away_wins_snap": pd.to_numeric(col("awayTeam_wins"), errors="coerce"),
        "away_losses_snap": pd.to_numeric(col("awayTeam_losses"), errors="coerce"),
        "home_score_snap": pd.to_numeric(col("homeTeam_score"), errors="coerce"),
        "away_score_snap": pd.to_numeric(col("awayTeam_score"), errors="coerce"),
    })
    out["season_type"] = out.game_id.str[2].map(TYPE_BY_DIGIT).fillna("Other")
    # 対戦未定（NBA Cup のノックアウト）。表示では「対戦未定」と出すこと
    out["tbd"] = ((out.home_team_id.fillna(0) == 0)
                  | (out.away_team_id.fillna(0) == 0))
    out["fetched_at"] = pd.Timestamp.now("UTC").tz_localize(None)
    return out[out.game_id.notna() & (out.game_id != "nan")].reset_index(drop=True)


# ================================================================== T2b

def build_team_schedule(con) -> None:
    hr("T2b team_schedule — チーム単位に展開して日程要因を付ける")
    g = con.execute("""
        select season, season_type, game_id, game_date, tip_et, tip_utc,
               game_status, home_team_id as team_id, away_team_id as opp_id,
               1 as is_home, arena_city, is_neutral, national_tv,
               week_number, game_label, series_text
        from game_schedule
        union all
        select season, season_type, game_id, game_date, tip_et, tip_utc,
               game_status, away_team_id as team_id, home_team_id as opp_id,
               0 as is_home, arena_city, is_neutral, national_tv,
               week_number, game_label, series_text
        from game_schedule
    """).df()
    dim = con.execute("select team_id, tri from team_dim").df()
    g = g.merge(dim, on="team_id", how="left")
    g = g.merge(dim.rename(columns={"team_id": "opp_id", "tri": "opp_tri"}),
                on="opp_id", how="left")

    # NBA 30球団以外の行を落とす。2種類ある。
    #   team_id = 0  : NBA Cup のノックアウト（対戦未定）。12月に確定する
    #   50015 など   : プレシーズンの海外クラブ（毎シーズン数試合ある）
    # どちらも休養日数・B2B の計算対象にならないので team_schedule からは外す。
    # game_schedule 側には残してあるので、日程表示には使える。
    nba = set(dim.team_id)
    drop = ~(g.team_id.isin(nba) & g.opp_id.isin(nba))
    print(f"  NBA球団以外を除外: {int(drop.sum()):,} 行"
          f"（対戦未定 {int((g.team_id == 0).sum()):,} / "
          f"海外クラブ等 {int((drop & (g.team_id != 0)).sum()):,}）")
    g = g[~drop].reset_index(drop=True)

    # 日程要因は「そのシーズンの、プレシーズンとオールスターを除く試合」で計算する
    g["gd"] = pd.to_datetime(g.game_date)
    # ★ マスクは必ず並べ替え・インデックス振り直しの**後**に作ること。
    #   先に作ると g[mask] がラベルで整合してしまい、別の行が選ばれる
    #   （実際にこれで rest_days が 142 行欠損し、プレシーズンが混入した）。
    g = g.sort_values(["team_id", "season", "gd", "game_id"]).reset_index(drop=True)
    real = g.season_type.isin(["Regular Season", "Playoffs", "PlayIn"])
    sub_g = g[real].copy()
    grp = sub_g.groupby(["team_id", "season"], sort=False)
    sub_g["rest_days"] = grp.gd.diff().dt.days
    sub_g["b2b"] = (sub_g.rest_days == 1).astype("Int64")
    # 直近7日の試合数（当該試合を含まない）
    cnt = []
    for _, d in sub_g.groupby(["team_id", "season"], sort=False):
        dates = d.gd.to_numpy()
        cnt.append(pd.Series(
            [int(((dates >= x - np.timedelta64(7, "D")) & (dates < x)).sum())
             for x in dates], index=d.index))
    sub_g["games_last7"] = pd.concat(cnt).sort_index() if cnt else 0
    g = g.merge(sub_g[["game_id", "team_id", "rest_days", "b2b", "games_last7"]],
                on=["game_id", "team_id"], how="left")
    g = g.drop(columns="gd")
    con.execute("drop table if exists team_schedule")
    con.register("_t", g)
    con.execute("create table team_schedule as select * from _t")
    con.unregister("_t")
    print(f"  team_schedule: {len(g):,} 行")


# ================================================================== 検算

def report(con) -> None:
    hr("検算")
    sub("シーズン x 種別の試合数と状態")
    print(con.execute("""
        select season, season_type, count(*) 試合,
               sum(case when game_status = 3 then 1 else 0 end) 終了,
               sum(case when game_status = 1 then 1 else 0 end) 未実施,
               min(game_date) 最初, max(game_date) 最後
        from game_schedule group by 1, 2 order by 1, 2
    """).df().to_string(index=False))

    sub("既存の試合結果（team_game_adv）との突き合わせ")
    print(con.execute("""
        with s as (select season, season_type, game_id, game_date from game_schedule
                   where season_type in ('Regular Season','Playoffs','PlayIn')),
        a as (select distinct season_fetched as season, season_type, game_id,
                     cast(game_date as date) as game_date from team_game_adv)
        select coalesce(s.season, a.season) season,
               count(*) 突合,
               sum(case when a.game_id is null then 1 else 0 end) 日程のみ,
               sum(case when s.game_id is null then 1 else 0 end) 結果のみ,
               sum(case when s.game_id is not null and a.game_id is not null
                         and s.game_date <> a.game_date then 1 else 0 end) 日付不一致
        from s full outer join a using (game_id)
        group by 1 order by 1
    """).df().to_string(index=False))
    print("""
    「結果のみ」が 0 なら、既存の全試合が日程に含まれている。
    「日程のみ」は未実施試合（2026-27）と、プレシーズン除外分。""")

    sub("2026-27（未実施シーズン）の内容")
    print(con.execute("""
        select season_type, count(*) 試合, min(game_date) 開幕, max(game_date) 最終
        from game_schedule where season = '2026-27' group by 1 order by 1
    """).df().to_string(index=False))

    sub("直近の日程（今日以降の最初の10試合）")
    print(con.execute("""
        select game_date, tip_et, away_tri || ' @ ' || home_tri as カード,
               arena_city, national_tv, season_type
        from game_schedule
        where game_date >= current_date and season_type <> 'Pre Season'
        order by tip_utc limit 10
    """).df().to_string(index=False))

    sub("日程要因（B2B・休養日数）の分布 — レギュラーシーズン")
    print(con.execute("""
        select season, count(*) チーム試合,
               round(avg(rest_days), 3) 平均休養日,
               round(avg(b2b) * 100, 2) as "B2B率(%)",
               round(avg(games_last7), 3) as 直近7日試合数
        from team_schedule
        where season_type = 'Regular Season' and rest_days is not null
        group by 1 order by 1
    """).df().to_string(index=False))
    print("""
    team_game_adv から直接計算した B2B率と一致していれば日程の展開は正しい
    （2014-15 は 23.6%、近年は 16〜18%。年々 B2B が減っている）。
    欠損は各チームのシーズン初戦のみ（30行 x シーズン）が正常。""")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--db", default=DB)
    ap.add_argument("--seasons", default=None,
                    help="カンマ区切り。既定は 2014-15〜2026-27")
    ap.add_argument("--report-only", action="store_true")
    a = ap.parse_args()
    if not os.path.exists(a.db):
        print(f"[ERROR] {a.db} が見つかりません")
        sys.exit(1)

    if not a.report_only:
        seasons = ([x.strip() for x in a.seasons.split(",")] if a.seasons
                   else SEASONS)
        hr("T2a game_schedule — リーグ日程の取得")
        print(f"  対象 {len(seasons)} シーズン / 取得間隔 {SLEEP}s")
        frames = []
        for s in seasons:
            d = normalize(fetch_season(s), s)
            n_fut = int((d.game_status == 1).sum())
            print(f"  {s}: {len(d):>5,} 試合（未実施 {n_fut:,}）"
                  f" 種別 {dict(d.season_type.value_counts())}")
            frames.append(d)
            time.sleep(SLEEP)
        new = pd.concat(frames, ignore_index=True)

        con = duckdb.connect(a.db)
        exists = con.execute("select count(*) from information_schema.tables "
                             "where table_name = 'game_schedule'").fetchone()[0]
        con.register("_n", new)
        if exists:
            con.execute("delete from game_schedule where season in "
                        "(select distinct season from _n)")
            con.execute("insert into game_schedule by name select * from _n")
        else:
            con.execute("create table game_schedule as select * from _n")
        con.unregister("_n")
        print(f"\n  game_schedule: 累計 "
              f"{con.execute('select count(*) from game_schedule').fetchone()[0]:,} 行")
        build_team_schedule(con)
    else:
        con = duckdb.connect(a.db, read_only=True)

    report(con)
    con.close()
    print("\n完了")


if __name__ == "__main__":
    main()

"""
fetch_rosters.py — 在籍選手一覧（チームロスター）を取得して team_roster に入れる

出所: nba_api の CommonTeamRoster（stats.nba.com）

★ 同じリクエストに Coaches のデータセットも入っているが、**使わない**。
  CLAUDE.md の実測記録のとおり、Coaches は就任が1季ずれる型で系統的に壊れている。
  ロスター本体（get_data_frames()[0]）は正しいので、そちらだけ取る。

★ stats.nba.com は独自ヘッダを足すと無応答になる。nba_api の既定に任せること。
  curl で直接叩くと HTTP 000 で返ってこない（実測）。

テーブル team_roster
  season, team_id, tri, player_id, player_name, jersey, position,
  height, weight, birth_date, age, exp, school, how_acquired,
  supplemental_status, fetched_at

使い方:
    python fetch_rosters.py                      # 2026-27 を取得
    python fetch_rosters.py --season 2025-26
    python fetch_rosters.py --season 2026-27 --report-only
"""

from __future__ import annotations

import argparse
import os
import sys
import time
from datetime import datetime, timezone

import duckdb
import pandas as pd

try:
    sys.stdout.reconfigure(errors="replace")
except Exception:
    pass

DB = "nba.duckdb"
SLEEP = 1.0
TRIES = 3
TIMEOUT = 60


def hr(t: str) -> None:
    print("\n" + "=" * 76)
    print(t)
    print("=" * 76)


def fetch_team(team_id: int, season: str) -> pd.DataFrame:
    from nba_api.stats.endpoints import commonteamroster
    last = None
    for i in range(TRIES):
        try:
            e = commonteamroster.CommonTeamRoster(
                team_id=team_id, season=season, timeout=TIMEOUT)
            # ★ [0] がロスター。[1] は Coaches で壊れているので触らない
            return e.get_data_frames()[0]
        except Exception as ex:
            last = ex
            time.sleep(2.0 * (i + 1))
    raise RuntimeError(f"team {team_id} の取得に失敗: {last}")


def normalize(d: pd.DataFrame, season: str, tri: str) -> pd.DataFrame:
    def col(name, default=None):
        return d[name] if name in d.columns else default
    out = pd.DataFrame({
        "season": season,
        "team_id": col("TeamID"),
        "tri": tri,
        "player_id": pd.to_numeric(col("PLAYER_ID"), errors="coerce"),
        "player_name": col("PLAYER"),
        "jersey": col("NUM"),
        "position": col("POSITION"),
        "height": col("HEIGHT"),
        "weight": pd.to_numeric(col("WEIGHT"), errors="coerce"),
        "birth_date": col("BIRTH_DATE"),
        "age": pd.to_numeric(col("AGE"), errors="coerce"),
        "exp": col("EXP"),
        "school": col("SCHOOL"),
        "how_acquired": col("HOW_ACQUIRED"),
        # 1 = two-way 等の補足契約（stats.nba.com は 0/1 で返す）
        "supplemental_status": pd.to_numeric(
            col("SUPPLEMENTAL_STATUS"), errors="coerce").fillna(0).astype(int),
    })
    out["fetched_at"] = datetime.now(timezone.utc).isoformat()
    return out.dropna(subset=["player_id"])


def report(con, season: str) -> None:
    hr(f"検算 — team_roster（{season}）")
    n = con.execute("select count(*) from team_roster where season = ?",
                    [season]).fetchone()[0]
    t = con.execute("select count(distinct team_id) from team_roster "
                    "where season = ?", [season]).fetchone()[0]
    p = con.execute("select count(distinct player_id) from team_roster "
                    "where season = ?", [season]).fetchone()[0]
    print(f"  {n:,} 行 / {t} チーム / {p:,} 選手")
    if t != 30:
        print(f"  ★ チーム数が 30 でない（{t}）。取得漏れを確認すること")

    print("\n  チーム別の人数")
    d = con.execute("""
        select tri, count(*) n,
               sum(coalesce(supplemental_status, 0)) two_way
        from team_roster where season = ?
        group by 1 order by n desc""", [season]).df()
    print("   " + " / ".join(f"{r.tri} {r.n}" for r in d.itertuples()))
    print(f"   人数 最小 {d.n.min()} / 中央 {int(d.n.median())} / 最大 {d.n.max()}")

    dup = con.execute("""
        select player_id, count(*) n, list(tri) teams
        from team_roster where season = ?
        group by 1 having count(*) > 1""", [season]).df()
    print(f"\n  複数チームに重複して載る選手: {len(dup)} 名")
    if len(dup):
        print(dup.head(5).to_string(index=False))

    # 過去に出場履歴があるか（新人・新規加入は無くて当然）
    j = con.execute("""
        select count(*) n,
               sum(case when b.player_id is not null then 1 else 0 end) known
        from team_roster r
        left join (select distinct player_id from player_game_base) b
          using (player_id)
        where r.season = ?""", [season]).fetchone()
    print(f"\n  過去に出場履歴のある選手: {j[1]:,} / {j[0]:,} "
          f"（{100 * j[1] / max(j[0], 1):.1f}%）")
    print("   残りは新人・未出場の新規契約。ここが極端に低いなら ID の不一致を疑う")

    print("\n  直近の加入（how_acquired に 2026 を含む）")
    r = con.execute("""
        select tri, player_name, how_acquired from team_roster
        where season = ? and how_acquired like '%/26%'
        order by tri limit 8""", [season]).df()
    print(r.to_string(index=False) if len(r) else "   （該当なし）")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--db", default=DB)
    ap.add_argument("--season", default="2026-27")
    ap.add_argument("--report-only", action="store_true")
    a = ap.parse_args()
    if not os.path.exists(a.db):
        print(f"[ERROR] {a.db} が見つかりません")
        sys.exit(1)

    con = duckdb.connect(a.db, read_only=a.report_only)
    if not a.report_only:
        teams = con.execute("select team_id, tri from team_dim "
                            "order by tri").df()
        hr(f"team_roster — 在籍選手一覧の取得（{a.season}）")
        print(f"  {len(teams)} チーム / 取得間隔 {SLEEP}s")
        frames, failed = [], []
        for i, t in enumerate(teams.itertuples(), 1):
            try:
                d = normalize(fetch_team(int(t.team_id), a.season),
                              a.season, t.tri)
                frames.append(d)
                print(f"  [{i:2d}/30] {t.tri} {len(d):2d}名")
            except Exception as ex:
                failed.append(t.tri)
                print(f"  [{i:2d}/30] {t.tri} 失敗: {str(ex)[:80]}")
            time.sleep(SLEEP)
        if failed:
            print(f"\n  ★ 取得できなかったチーム: {', '.join(failed)}")
        if not frames:
            print("  1件も取得できなかった。中止する")
            sys.exit(1)

        new = pd.concat(frames, ignore_index=True)
        exists = con.execute(
            "select count(*) from information_schema.tables "
            "where table_name = 'team_roster'").fetchone()[0]
        con.register("_r", new)
        if exists:
            con.execute("delete from team_roster where season = ?", [a.season])
            con.execute("insert into team_roster by name select * from _r")
        else:
            con.execute("create table team_roster as select * from _r")
        con.unregister("_r")
        print(f"\n  team_roster: 累計 "
              f"{con.execute('select count(*) from team_roster').fetchone()[0]:,} 行")

    report(con, a.season)
    con.close()
    print("\n完了")


if __name__ == "__main__":
    main()

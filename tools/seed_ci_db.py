"""
seed_ci_db.py — GitHub Actions 用の空 DuckDB を作る

元データ `nba.duckdb`（929MB）はリポジトリに無い。
日程とロスターの取り直しに最低限要るのは `team_dim`（30行）だけなので、
`tools/team_dim.csv` から作って渡す。

    python tools/seed_ci_db.py --db ci.duckdb

このあと build_schedule.py → fetch_rosters.py → build_page1.py の順に走らせる。
試合ログの表（player_game_base など）は入らないので、
前季の平均成績と選手ページは既存の JSON が据え置かれる。
"""


from __future__ import annotations

import argparse
import os

import duckdb

HERE = os.path.dirname(os.path.abspath(__file__))
SEED = os.path.join(HERE, "team_dim.csv")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--db", required=True)
    a = ap.parse_args()

    # 作り直しを毎回同じ状態から始める
    for suffix in ("", ".wal"):
        p = a.db + suffix
        if os.path.exists(p):
            os.remove(p)

    con = duckdb.connect(a.db)
    con.execute(
        "create table team_dim as select * from read_csv(?, header = true)",
        [SEED])
    n = con.execute("select count(*) from team_dim").fetchone()[0]
    con.close()
    print(f"  {a.db}: team_dim {n} 行")
    if n != 30:
        raise SystemExit(f"  ! team_dim が {n} 行（30 のはず）")


if __name__ == "__main__":
    main()

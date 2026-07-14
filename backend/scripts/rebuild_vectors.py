"""存量向量重建脚本

为 knowledge_infos 中所有条目重新生成 embedding 并存入 vec_knowledge。

用途：首次部署 sqlite-vec + embedding 后，为存量数据生成向量。

运行方式（从项目根目录）：
    python -m backend.scripts.rebuild_vectors
"""

import json
import sys
import os

# 确保 backend 在 path 中
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))

from backend.database import get_db, init_db
from backend.services.embedding_service import get_embedding_service


def rebuild():
    print("=" * 60)
    print("Lubia 知识库向量重建")
    print("=" * 60)

    # 初始化数据库（确保表存在）
    init_db()

    # 加载 embedding 服务
    print("\n[1/3] 加载 embedding 模型...")
    svc = get_embedding_service()
    if not svc.is_available:
        print(f"错误：embedding 模型不可用")
        print(f"原因：{svc.load_error}")
        print("请先安装依赖: pip install sentence-transformers")
        return 1

    # 检查 sqlite-vec
    try:
        from sqlite_vec import serialize_float32
    except ImportError:
        print("错误：sqlite-vec 未安装")
        print("请先安装: pip install sqlite-vec")
        return 1

    # 读取所有条目
    print("\n[2/3] 读取知识库条目...")
    conn = get_db()
    try:
        rows = conn.execute(
            "SELECT id, category, content, keywords, is_visible FROM knowledge_infos"
        ).fetchall()
    finally:
        conn.close()

    total = len(rows)
    print(f"共 {total} 条记录")

    if total == 0:
        print("知识库为空，无需重建。")
        return 0

    # 逐条 embedding + 写入
    print(f"\n[3/3] 生成向量并写入 vec_knowledge...")
    succeeded = 0
    failed = 0

    conn = get_db()
    try:
        for i, row in enumerate(rows):
            info_id = row["id"]
            cat = row["category"] or ""
            content = row["content"] or ""
            is_visible = row["is_visible"]

            try:
                kw = json.loads(row["keywords"] or "[]")
            except (json.JSONDecodeError, TypeError):
                kw = []

            # Embedding
            vec = svc.embed_knowledge(cat, content, kw)
            if vec is None:
                print(f"  [{i+1}/{total}] 跳过 {info_id}: embedding 失败")
                failed += 1
                continue

            # 写入向量表（先删旧再插新）
            try:
                blob = serialize_float32(vec)
                conn.execute("DELETE FROM vec_knowledge WHERE info_id = ?", (info_id,))
                conn.execute(
                    "INSERT INTO vec_knowledge(embedding, info_id, is_visible) VALUES (?, ?, ?)",
                    (blob, info_id, is_visible),
                )
                succeeded += 1
                if (i + 1) % 10 == 0 or i == total - 1:
                    print(f"  [{i+1}/{total}] 已处理 {succeeded} 条，{failed} 条失败")
            except Exception as e:
                print(f"  [{i+1}/{total}] 写入失败 {info_id}: {e}")
                failed += 1

        conn.commit()
    finally:
        conn.close()

    print(f"\n完成！成功 {succeeded} 条，失败 {failed} 条")
    return 0 if failed == 0 else 1


if __name__ == "__main__":
    sys.exit(rebuild())

"""预下载 bge-small-zh-v1.5 模型到项目本地

运行一次即可，之后嵌入服务会优先使用本地模型，无需联网。
模型将下载到 backend/models/bge-small-zh-v1.5/（约 95MB），
InnoSetup 打包时把整个 backend/models/ 目录包含进去。

运行方式（从项目根目录）：
    python backend/scripts/download_embedding_model.py

使用国内镜像（如果 HuggingFace 直连慢）：
    set HF_ENDPOINT=https://hf-mirror.com
    python backend/scripts/download_embedding_model.py
"""

import os
import sys

# 确保 backend 在 path 中
_PROJ = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, _PROJ)

_MODEL_ID = "BAAI/bge-small-zh-v1.5"
_TARGET = os.path.join(_PROJ, "backend", "models", "bge-small-zh-v1.5")


def download():
    print("=" * 60)
    print("下载 bge-small-zh-v1.5 embedding 模型")
    print("=" * 60)
    print(f"\n模型: {_MODEL_ID}")
    print(f"保存到: {_TARGET}")
    print(f"镜像: {os.getenv('HF_ENDPOINT', 'HuggingFace 官方（慢可设 HF_ENDPOINT=https://hf-mirror.com）')}")

    # 检查是否已存在
    if os.path.isdir(_TARGET) and os.path.isfile(os.path.join(_TARGET, "config.json")):
        size = _dir_size(_TARGET)
        print(f"\n模型已存在！总大小: {size / 1024 / 1024:.1f} MB")
        print("如需重新下载，先删除此目录。")
        return 0

    print("\n正在下载（首次约 95MB，请耐心等待）...")

    try:
        from sentence_transformers import SentenceTransformer
        # 下载到本地路径
        model = SentenceTransformer(_MODEL_ID)

        # 保存到项目目录
        os.makedirs(os.path.dirname(_TARGET), exist_ok=True)
        model.save(_TARGET)
        print(f"\n完成！模型已保存到: {_TARGET}")
        size = _dir_size(_TARGET)
        print(f"总大小: {size / 1024 / 1024:.1f} MB")
        return 0
    except ImportError:
        print("\n错误：sentence-transformers 未安装")
        print("请先运行: pip install sentence-transformers")
        return 1
    except Exception as e:
        print(f"\n下载失败: {e}")
        print("提示：如果网络不通，尝试设置镜像:")
        print("  set HF_ENDPOINT=https://hf-mirror.com")
        print("  python backend/scripts/download_embedding_model.py")
        return 1


def _dir_size(path: str) -> int:
    total = 0
    for dirpath, dirnames, filenames in os.walk(path):
        for f in filenames:
            fp = os.path.join(dirpath, f)
            if os.path.isfile(fp):
                total += os.path.getsize(fp)
    return total


if __name__ == "__main__":
    sys.exit(download())

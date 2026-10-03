"""原子：数据导出 — 将数据输出为 CSV/JSON 文件"""

import csv
import json
from datetime import datetime
from pathlib import Path
from typing import Any

DATA_DIR = Path(__file__).parent.parent.parent / "data"


def _ensure_dir(path: Path) -> Path:
    path.mkdir(parents=True, exist_ok=True)
    return path


def to_csv(rows: list[dict], store_name: str, data_type: str, output_dir: Path = None) -> Path:
    """将 dict 列表导出为 CSV"""
    if output_dir is None:
        output_dir = DATA_DIR / "exports"
    export_dir = _ensure_dir(output_dir)
    ts = datetime.now().strftime("%Y%m%d_%H%M%S")
    filename = f"{store_name}_{ts}.csv"
    filepath = export_dir / filename

    if not rows:
        with open(filepath, "w") as f:
            f.write("# No data\n")
        return filepath

    fieldnames = list(dict.fromkeys(k for row in rows for k in row.keys()))
    with open(filepath, "w", newline="", encoding="utf-8-sig") as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames)
        writer.writeheader()
        for row in rows:
            # 展平嵌套字段
            flat_row = {}
            for k, v in row.items():
                if isinstance(v, dict):
                    flat_row[k] = json.dumps(v, ensure_ascii=False)
                elif isinstance(v, list):
                    flat_row[k] = json.dumps(v, ensure_ascii=False)
                else:
                    flat_row[k] = v
            writer.writerow(flat_row)

    return filepath


def to_json(data: Any, store_name: str, data_type: str, output_dir: Path = None) -> Path:
    """将数据导出为 JSON"""
    if output_dir is None:
        output_dir = DATA_DIR / "exports"
    export_dir = _ensure_dir(output_dir)
    ts = datetime.now().strftime("%Y%m%d_%H%M%S")
    filename = f"{store_name}_{ts}.json"
    filepath = export_dir / filename

    with open(filepath, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2, default=str)

    return filepath

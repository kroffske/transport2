"""Profile the ten official CSVs without reading a validate target."""
from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import TypedDict
import pandas as pd

from .data import file_manifest, read_points
from .validation import chronological_blocks

CSV = (
    "train/traffic.csv", "train/schedule.csv", "labels/labels_train.csv",
    "test/traffic.csv", "test/schedule.csv", "labels/labels_test.csv",
    "validate/traffic.csv", "validate/schedule_plan.csv", "validate/points.csv",
    "sample_submission.csv",
)
OTHER = ("README.md", "docs/Emulator-and-Telematic-Packets-Specification.md",
         "emulator/ndtp-telemetry-emulator.tar")
PREVIOUS_AUDITS = (
    "artifacts/core/audit_predictions.csv",
    "artifacts/context/audit_predictions.csv",
    ".tasks/T-3-2026-09-25-ml-submission/artifacts/pre_frozen_exploration/audit_predictions.csv",
)


class SourceProfile(TypedDict):
    rows: int
    columns: list[str]
    null_counts: dict[str, int]
    key: list[str]
    duplicate_key_rows: int
    exact_duplicate_rows: int
    vehicles: int | None
    time: dict[str, dict[str, str]]


class CoverageProfile(TypedDict):
    points: int
    join_rows: int
    traffic_vehicle_covered: int
    schedule_target_covered: int
    schedule_target_time_equal: int


class TrafficQuality(TypedDict):
    duplicate_vehicle_event_rows: int
    missing_receive_time: int
    negative_receive_lag: int
    receive_lag_p50_s: float
    receive_lag_p99_s: float
    receive_lag_max_s: float
    invalid_location_count: int
    missing_position_count: int
    speed_over_120_count: int


class FactConsistency(TypedDict):
    fact_present: int
    exact_label_matches: int
    max_absolute_discrepancy_s: float


class TargetProfile(TypedDict):
    n: int
    median_s: float
    p05_s: float
    p95_s: float
    min_s: float
    max_s: float
    mae_zero_s: float
    mae_cur_dev_s: float
    class_counts: dict[str, int]


class ExposureSource(TypedDict):
    file: str
    present: bool
    rows: int
    overlap_with_current_audit: int
    sha256: str | None


class ModelExposure(TypedDict):
    current_audit_points: int
    previously_exposed_current_audit_points: int
    previously_exposed_fraction: float
    previous_audit_sources: list[ExposureSource]
    historical_independence: str
    current_run_selection_order: str


class AuditExposure(ModelExposure):
    labels_test_previously_seen: bool
    test_is_unseen_evidence: bool
    train_test_sample_overlap: int
    train_test_vehicle_overlap: int


class ValidateFactProxy(TypedDict):
    matching_keys_in_test_schedule: int
    points: int
    fact_field_present_in_test_schedule: bool
    target_reconstructed_or_used: bool
    platform_readback_observed: bool


class AuditResult(TypedDict):
    scope: str
    source_manifest: list[dict[str, str | int]]
    profiles: dict[str, SourceProfile]
    coverage: dict[str, CoverageProfile]
    traffic_quality: dict[str, TrafficQuality]
    fact_consistency: dict[str, FactConsistency]
    target: dict[str, TargetProfile]
    exposure: AuditExposure
    validate_test_traffic_equal_bytes: bool
    validate_fact_proxy: ValidateFactProxy
    sample_submission_exact_coverage: bool


def audit_exposure(current_audit_ids: pd.Series, workspace: Path) -> tuple[int, list[ExposureSource]]:
    current = set(current_audit_ids.astype(str))
    previous: set[str] = set()
    sources: list[ExposureSource] = []
    for relative in PREVIOUS_AUDITS:
        path = workspace / relative
        if path.is_file():
            ids = pd.read_csv(path, usecols=["sample_id"], dtype={"sample_id": str}).sample_id
            historical = set(ids)
            previous.update(historical)
            sources.append({"file": relative, "present": True, "rows": len(ids),
                            "overlap_with_current_audit": len(historical & current),
                            "sha256": file_manifest([path])[0]["sha256"]})
        else:
            sources.append({"file": relative, "present": False, "rows": 0,
                            "overlap_with_current_audit": 0, "sha256": None})
    return len(previous & current), sources


def audit(root: Path) -> AuditResult:
    paths = [root / p for p in CSV + OTHER]
    missing = [str(p.relative_to(root)) for p in paths if not p.is_file()]
    if missing:
        raise FileNotFoundError(f"Missing official sources: {missing}")
    tables = {name: pd.read_csv(root / name, sep=";" if name == "sample_submission.csv" else ",",
                                dtype={"packet_id": str, "sample_id": str, "tr_id": str, "target_stop_id": str,
                                       "tt_action_item_id": str}) for name in CSV}
    profiles = {}
    for name, frame in tables.items():
        base = Path(name).name
        key = (["tr_id", "tt_action_item_id"] if "schedule" in base else
               ["packet_id"] if base == "traffic.csv" else ["sample_id"])
        times = [c for c in ("T", "target_time_begin", "event_time", "receive_time",
                             "time_begin", "time_fact_begin") if c in frame]
        profiles[name] = {
            "rows": len(frame), "columns": list(frame),
            "null_counts": frame.isna().sum().astype(int).to_dict(), "key": key,
            "duplicate_key_rows": int(frame.duplicated(key).sum()),
            "exact_duplicate_rows": int(frame.duplicated().sum()),
            "vehicles": int(frame.tr_id.nunique()) if "tr_id" in frame else None,
            "time": {c: {"min": str(pd.to_datetime(frame[c], format="mixed").min()),
                         "max": str(pd.to_datetime(frame[c], format="mixed").max())} for c in times},
        }
    train = read_points(root / "labels/labels_train.csv", require_target=True)
    test = read_points(root / "labels/labels_test.csv", require_target=True)
    validate = read_points(root / "validate/points.csv")
    if "target_delay_s" in tables["validate/points.csv"] or "time_fact_begin" in tables["validate/schedule_plan.csv"]:
        raise ValueError("Unexpected validate target or actual arrival")
    template = tables["sample_submission.csv"]
    exact_template = (list(template) == ["sample_id", "prediction"] and template.sample_id.is_unique
                      and set(template.sample_id) == set(validate.sample_id))
    if not exact_template:
        raise ValueError("Template does not exactly cover validate points")
    coverage = {}
    traffic_quality = {}
    fact_consistency = {}
    for split, points in (("train", train), ("test", test), ("validate", validate)):
        traffic = tables[f"{split}/traffic.csv"]
        plan = tables[f"{split}/schedule.csv" if split != "validate" else "validate/schedule_plan.csv"]
        schedule = plan[["tr_id", "tt_action_item_id", "time_begin"]]
        if schedule.duplicated(["tr_id", "tt_action_item_id"]).any():
            raise ValueError(f"{split} schedule target key is not unique")
        joined = points.merge(schedule, left_on=["tr_id", "target_stop_id"],
                              right_on=["tr_id", "tt_action_item_id"], how="left",
                              validate="many_to_one", indicator=True)
        matched = joined["_merge"].eq("both")
        equal_time = pd.to_datetime(joined.loc[matched, "time_begin"], format="mixed").reset_index(drop=True).eq(
            joined.loc[matched, "target_time_begin"].reset_index(drop=True))
        coverage[split] = {"points": len(points), "join_rows": len(joined),
                           "traffic_vehicle_covered": int(points.tr_id.isin(traffic.tr_id).sum()),
                           "schedule_target_covered": int(matched.sum()),
                           "schedule_target_time_equal": int(equal_time.sum())}
        if split != "validate":
            actual = points.merge(plan[["tr_id", "tt_action_item_id", "time_begin", "time_fact_begin"]],
                                  left_on=["tr_id", "target_stop_id"],
                                  right_on=["tr_id", "tt_action_item_id"], how="left",
                                  validate="many_to_one")
            label_from_fact = (pd.to_datetime(actual.time_fact_begin, format="mixed")
                               - pd.to_datetime(actual.time_begin, format="mixed")).dt.total_seconds()
            discrepancy = (actual.target_delay_s - label_from_fact).abs()
            fact_consistency[split] = {
                "fact_present": int(label_from_fact.notna().sum()),
                "exact_label_matches": int(discrepancy.eq(0).sum()),
                "max_absolute_discrepancy_s": float(discrepancy.max()),
            }
        lag = (pd.to_datetime(traffic.receive_time, format="mixed", errors="coerce")
               - pd.to_datetime(traffic.event_time, format="mixed")).dt.total_seconds()
        traffic_quality[split] = {
            "duplicate_vehicle_event_rows": int(traffic.duplicated(["tr_id", "event_time"]).sum()),
            "missing_receive_time": int(traffic.receive_time.isna().sum()),
            "negative_receive_lag": int((lag < 0).sum()),
            "receive_lag_p50_s": float(lag.quantile(.5)),
            "receive_lag_p99_s": float(lag.quantile(.99)),
            "receive_lag_max_s": float(lag.max()),
            "invalid_location_count": int((~traffic.location_valid.astype(str).str.lower().isin(["true", "1"])).sum()),
            "missing_position_count": int((traffic.lon.isna() | traffic.lat.isna()).sum()),
            "speed_over_120_count": int((pd.to_numeric(traffic.speed, errors="coerce") > 120).sum()),
        }
    target = {}
    for name, points in (("train", train), ("test_exposed", test)):
        y = points.target_delay_s
        target[name] = {"n": len(points), "median_s": float(y.median()), "p05_s": float(y.quantile(.05)),
                        "p95_s": float(y.quantile(.95)), "min_s": float(y.min()), "max_s": float(y.max()),
                        "mae_zero_s": float(y.abs().mean()),
                        "mae_cur_dev_s": float((y - points.cur_dev_s).abs().mean()),
                        "class_counts": tables[f"labels/labels_{'train' if name == 'train' else 'test'}.csv"].target_class.value_counts().to_dict()}
    manifests = file_manifest(paths)
    hashes = {Path(m["file"]).relative_to(root).as_posix(): m["sha256"] for m in manifests}
    test_fact_keys = set(zip(tables["test/schedule.csv"].tr_id,
                             tables["test/schedule.csv"].tt_action_item_id))
    validate_fact_key_matches = sum((vehicle, stop) in test_fact_keys
                                    for vehicle, stop in zip(validate.tr_id, validate.target_stop_id))
    audit_rows = chronological_blocks(train)[0]["audit"]
    exposed_count, prior_sources = audit_exposure(train.iloc[audit_rows].sample_id, root.parent)
    return {
        "scope": "Десять официальных CSV, README, спецификация пакетов и архив эмулятора; реконструируемый validate proxy изолирован.",
        "source_manifest": manifests, "profiles": profiles, "coverage": coverage,
        "traffic_quality": traffic_quality, "fact_consistency": fact_consistency, "target": target,
        "exposure": {"labels_test_previously_seen": True, "test_is_unseen_evidence": False,
                     "train_test_sample_overlap": len(set(train.sample_id) & set(test.sample_id)),
                     "train_test_vehicle_overlap": len(set(train.tr_id) & set(test.tr_id)),
                     "current_audit_points": len(audit_rows),
                     "previously_exposed_current_audit_points": exposed_count,
                     "previously_exposed_fraction": exposed_count / len(audit_rows),
                     "previous_audit_sources": prior_sources,
                     "historical_independence": "repeated_local_evaluation; not_unseen",
                     "current_run_selection_order": "selected_by_tune_before_current_audit_metrics"},
        "validate_test_traffic_equal_bytes": hashes["validate/traffic.csv"] == hashes["test/traffic.csv"],
        "validate_fact_proxy": {
            "matching_keys_in_test_schedule": validate_fact_key_matches,
            "points": len(validate),
            "fact_field_present_in_test_schedule": "time_fact_begin" in tables["test/schedule.csv"],
            "target_reconstructed_or_used": False,
            "platform_readback_observed": False,
        },
        "sample_submission_exact_coverage": exact_template,
    }


def render_report(result: AuditResult) -> str:
    lines = ["# Полный аудит официальных данных", "", result["scope"], "",
             "## Источники и grain", "", "| Файл | Строки | Дубли ключа | Точные дубли |",
             "|---|---:|---:|---:|"]
    for name, p in result["profiles"].items():
        lines.append(f"| {name} | {p['rows']} | {p['duplicate_key_rows']} | {p['exact_duplicate_rows']} |")
    lines += ["", "## Связность point с контекстом", "",
              "| Раздел | Точек | Машина в traffic | Остановка в schedule | Плановое время совпало |",
              "|---|---:|---:|---:|---:|"]
    for name, c in result["coverage"].items():
        lines.append(f"| {name} | {c['points']} | {c['traffic_vehicle_covered']} | {c['schedule_target_covered']} | {c['schedule_target_time_equal']} |")
    lines += ["", "## Доступность и leakage", ""]
    for name, q in result["traffic_quality"].items():
        lines.append(f"- {name}: дубли vehicle/event {q['duplicate_vehicle_event_rows']}; отрицательный receive lag {q['negative_receive_lag']}; p99 lag {q['receive_lag_p99_s']:.1f} с; максимум {q['receive_lag_max_s']:.1f} с.")
    for name, c in result["fact_consistency"].items():
        lines.append(f"- {name}: label=fact-plan точно в {c['exact_label_matches']}/{result['coverage'][name]['points']} точках; максимум расхождения {c['max_absolute_discrepancy_s']:.1f} с.")
    proxy = result["validate_fact_proxy"]
    exposure = result["exposure"]
    lines += ["", "Признаки используют event_time <= T; receive-time replay также фильтрует receive_time <= T до выбора исправления. Факты расписания и target исключены. labels_test ранее просмотрен и служит только диагностике.",
              "", "## Реестр предыдущей экспозиции audit", "",
              f"Текущий audit — повторная локальная временная оценка с ограниченной независимостью: {exposure['previously_exposed_current_audit_points']}/{exposure['current_audit_points']} sample_id уже присутствовали в прошлых audit artifacts (union). Это не unseen набор. В текущем run модель выбрана по tune до расчёта текущей audit метрики; историческое раскрытие строк этим не отменяется.",
              "", "| Предыдущий artifact | Строк | Пересечение с текущим audit | SHA-256 |",
              "|---|---:|---:|---|"]
    for source in exposure["previous_audit_sources"]:
        lines.append(f"| {source['file']} | {source['rows']} | {source['overlap_with_current_audit']} | {source['sha256'] or 'отсутствует'} |")
    lines += [
              "", f"Quarantine: {proxy['matching_keys_in_test_schedule']}/{proxy['points']} validate keys встречаются в test schedule с time_fact_begin. Поэтому validate target технически реконструируем. Отдельный validate labels файл не выдан; proxy не вычислялся и не использовался при аудите метрик, выборе модели или inference. Platform readback не наблюдался.",
              "", "## Метка", "", "| Набор | Строк | Медиана, с | p05, с | p95, с | MAE zero, с | MAE cur_dev, с |",
              "|---|---:|---:|---:|---:|---:|---:|"]
    for name, p in result["target"].items():
        lines.append(f"| {name} | {p['n']} | {p['median_s']:.1f} | {p['p05_s']:.1f} | {p['p95_s']:.1f} | {p['mae_zero_s']:.1f} | {p['mae_cur_dev_s']:.1f} |")
    lines.append("")
    for name, p in result["target"].items():
        lines.append(f"{name} class counts: {p['class_counts']}.")
    lines += ["", f"Validate/test traffic byte-identical: {result['validate_test_traffic_equal_bytes']}. Template coverage: {result['sample_submission_exact_coverage']}.",
              "", "Null counts, временные диапазоны и SHA-256 исходных файлов: data_audit.json.", ""]
    return "\n".join(lines)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data-dir", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    result = audit(args.data_dir)
    args.out.mkdir(parents=True, exist_ok=True)
    (args.out / "data_audit.json").write_text(json.dumps(result, indent=2, ensure_ascii=False, allow_nan=False), encoding="utf-8")
    (args.out / "data_audit.md").write_text(render_report(result), encoding="utf-8")
    print(render_report(result))


if __name__ == "__main__":
    main()

from pathlib import Path
import numpy as np
import pandas as pd
import pytest
from pandas.testing import assert_frame_equal
from transport_ml.data import validate_points, prepare_traffic, prepare_plan
from transport_ml.features import FeatureBuilder
from transport_ml.validation import chronological_blocks, select_alert_threshold
from transport_ml.predict import write_submission, validate_submission
from transport_ml.audit import audit_exposure, PREVIOUS_AUDITS


def example():
    point = pd.DataFrame([dict(sample_id="v_1", tr_id="v", T="2026-01-06 12:00:00", target_stop_id="s3",
                               target_time_begin="2026-01-06 12:12:00", cur_dev_s=20.)])
    traffic = pd.DataFrame([
        dict(tr_id="v", event_time=f"2026-01-06 11:{minute:02d}:00", receive_time=f"2026-01-06 11:{minute:02d}:01",
             location_valid=True, lon=37.6+i*.001, lat=55.7, speed=10+i, heading=90)
        for i, minute in enumerate(range(50,60))])
    plan = pd.DataFrame([
        dict(tt_action_item_id="s1", tr_id="v", time_begin="2026-01-06 11:55:00", geom="POINT (37.6 55.7)", time_fact_begin="2026-01-06 11:55:20"),
        dict(tt_action_item_id="s2", tr_id="v", time_begin="2026-01-06 12:05:00", geom="POINT (37.61 55.7)", time_fact_begin="2026-01-06 12:05:20"),
        dict(tt_action_item_id="s3", tr_id="v", time_begin="2026-01-06 12:12:00", geom="POINT (37.62 55.7)", time_fact_begin="2026-01-06 12:12:20")])
    return validate_points(point), traffic, plan


@pytest.mark.parametrize("profile", ["legacy", "motion-v1"])
def test_future_telemetry_does_not_change_features_or_sequence(profile):
    point, traffic, plan = example()
    baseline = FeatureBuilder(prepare_traffic(traffic),prepare_plan(plan), feature_profile=profile).transform(point)
    future=traffic.iloc[-1].copy()
    future["event_time"], future["receive_time"], future["speed"] = "2026-01-06 12:00:01", "2026-01-06 12:00:02", 99
    modified=FeatureBuilder(prepare_traffic(pd.concat([traffic,pd.DataFrame([future])])),prepare_plan(plan), feature_profile=profile).transform(point)
    assert_frame_equal(baseline.X,modified.X)
    np.testing.assert_array_equal(baseline.sequence,modified.sequence)


@pytest.mark.parametrize("profile", ["legacy", "motion-v1"])
def test_future_received_correction_does_not_change_features(profile):
    point,traffic,plan=example()
    baseline=FeatureBuilder(prepare_traffic(traffic),prepare_plan(plan),availability="received", feature_profile=profile).transform(point)
    correction=traffic.iloc[-1].copy()
    correction["receive_time"],correction["speed"]="2026-01-06 12:01:00",80
    modified=FeatureBuilder(prepare_traffic(pd.concat([traffic,pd.DataFrame([correction])])),prepare_plan(plan),availability="received", feature_profile=profile).transform(point)
    assert_frame_equal(baseline.X,modified.X)
    np.testing.assert_array_equal(baseline.sequence,modified.sequence)


@pytest.mark.parametrize("profile", ["legacy", "motion-v1"])
def test_schedule_facts_and_labels_are_not_features(profile):
    point,traffic,plan=example()
    baseline=FeatureBuilder(prepare_traffic(traffic),prepare_plan(plan), feature_profile=profile).transform(point)
    plan["time_fact_begin"]="2030-12-31 23:59:59"
    point["target_delay_s"],point["target_class"]=9999,"late"
    modified=FeatureBuilder(prepare_traffic(traffic),prepare_plan(plan), feature_profile=profile).transform(point)
    assert_frame_equal(baseline.X,modified.X)
    assert "time_fact_begin" not in prepare_plan(plan)


@pytest.mark.parametrize("seconds,valid",[(600,False),(600.1,True),(900,True),(900.1,False)])
def test_horizon_contract(seconds,valid):
    point,_,_=example()
    point["target_time_begin"] = point["T"]+pd.Timedelta(seconds=seconds)
    if valid:
        validate_points(point)
    else:
        with pytest.raises(ValueError):
            validate_points(point)


def test_empty_context_has_fixed_shape_and_missingness():
    point,_,_=example()
    batch=FeatureBuilder().transform(point)
    assert batch.X["telemetry_missing"].iloc[0]==1
    assert batch.sequence.shape==(1,60,9)
    assert np.isfinite(batch.sequence).all()


def test_invalid_speed_is_missing_not_clipped():
    _,traffic,_=example()
    traffic.loc[0,"speed"]=368
    clean=prepare_traffic(traffic)
    assert pd.isna(clean.loc[0,"speed"])


def test_temporal_split_purges_until_labels_are_observed():
    ts=pd.date_range("2026-01-06 00:00:00",periods=285,freq="5min")
    p=pd.DataFrame({"T":ts,"target_time_begin":ts+pd.Timedelta(minutes=12),"target_delay_s":np.arange(285)%700})
    masks,meta=chronological_blocks(p)
    assert [meta[name]["boundary_end"] for name in ("fit", "tune", "calibration")] == [
        "2026-01-06 14:00:00", "2026-01-06 17:30:00", "2026-01-06 20:30:00"]
    assert len(set(masks["fit"])&set(masks["audit"]))==0
    for name in ["fit","tune","calibration"]:
        ready=p["target_time_begin"]+pd.to_timedelta(p["target_delay_s"].clip(lower=0),unit="s")
        assert (ready.iloc[masks[name]] < pd.Timestamp(meta[name]["boundary_end"])-pd.Timedelta(minutes=15)).all()


def test_duplicate_points_rejected():
    point,_,_=example()
    with pytest.raises(ValueError):
        validate_points(pd.concat([point,point]))


def test_submission_order_sign_and_schema(tmp_path):
    template=pd.DataFrame({"sample_id":["b","a"],"prediction":[0.,0.]})
    result=write_submission(["a","b"],[-12.5,100],template,tmp_path/"submission.csv")
    assert list(result.sample_id)==["b","a"]
    assert list(result.prediction)==[100.,-12.5]
    assert (tmp_path/"submission.csv").read_text().splitlines()[0]=="sample_id;prediction"


def test_submission_missing_ids_and_nan_rejected(tmp_path):
    template=pd.DataFrame({"sample_id":["a","b"],"prediction":[0.,0.]})
    with pytest.raises(ValueError):
        write_submission(["a"],[1],template,tmp_path/"bad.csv")
    with pytest.raises(ValueError):
        write_submission(["a","b"],[1,np.nan],template,tmp_path/"bad.csv")


def test_submission_readback_catches_file_tampering(tmp_path):
    template = pd.DataFrame({"sample_id": ["a", "b"], "prediction": [0., 0.]})
    path = tmp_path/"submission.csv"
    write_submission(["a", "b"], [1., 2.], template, path)
    assert validate_submission(path, template.sample_id)["rows"] == 2
    path.write_text("sample_id;prediction\na;1\nb;nan\n", encoding="utf-8")
    with pytest.raises(ValueError, match="nonfinite"):
        validate_submission(path, template.sample_id)
    path.write_text("sample_id;prediction\nb;2\na;1\n", encoding="utf-8")
    with pytest.raises(ValueError, match="template order"):
        validate_submission(path, template.sample_id)


def test_prior_audit_exposure_uses_union_not_sum(tmp_path):
    current = pd.Series(["a", "b", "c", "d"])
    for relative, ids in zip(PREVIOUS_AUDITS, (["a", "b"], ["b", "c"], ["a", "b"])):
        path = tmp_path/relative
        path.parent.mkdir(parents=True, exist_ok=True)
        pd.DataFrame({"sample_id": ids}).to_csv(path, index=False)
    count, sources = audit_exposure(current, tmp_path)
    assert count == 3
    assert [item["overlap_with_current_audit"] for item in sources] == [2, 2, 2]
    assert all(item["sha256"] for item in sources)


def test_unjustified_alerts_disabled():
    assert select_alert_threshold(np.zeros(10),np.linspace(.1,.9,10))>1


def test_motion_projection_recovers_signed_lag():
    point, traffic, plan = example()
    # At 11:59 the vehicle is at the planned 11:57 position: lag is +120s.
    traffic = traffic.iloc[-1:].copy()
    traffic["lon"] = 37.602
    batch = FeatureBuilder(prepare_traffic(traffic), prepare_plan(plan), "received",
                           feature_profile="motion-v1").transform(point)
    assert batch.X.motion_lag_latest_s.iloc[0] == pytest.approx(120, abs=.01)
    assert batch.X.motion_offset_m.iloc[0] < 1


def test_rolling_folds_purge_outcomes_and_exclude_audit():
    from transport_ml.optimize import rolling_folds
    ts = pd.date_range("2026-01-06 00:00", periods=285, freq="5min")
    points = pd.DataFrame({"T": ts, "target_time_begin": ts+pd.Timedelta(minutes=12),
                           "target_delay_s": np.arange(285)%700})
    maturity = points.target_time_begin+pd.to_timedelta(points.target_delay_s.clip(lower=0), unit="s")
    for fit, valid in rolling_folds(points):
        assert not set(fit) & set(valid)
        assert (maturity.iloc[fit] < points["T"].iloc[valid].min()-pd.Timedelta(minutes=15)).all()
        assert (points["T"].iloc[valid] < pd.Timestamp("2026-01-06 20:30")).all()

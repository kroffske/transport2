"""Повторяемая независимая QA локальных Docker HTTP/TCP сервисов Transport2.

Запускать из QA checkout абсолютным project venv. JSON evidence хранится в
ignored task artifacts. Source receive clock не измеряет latency. Host
monotonic измеряет send/ack/observe; Unix clock связывает публикации между
macOS и Docker VM с явно сохранёнными границами калибровки.
"""
from __future__ import annotations

import argparse
import copy
from datetime import datetime, timezone
import importlib.util
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import time
from urllib.request import Request, ProxyHandler, build_opener

import numpy as np
import pandas as pd

ROOT = Path(__file__).resolve().parents[1]
DATA = Path('/Users/ravius/projects/transport2/data')
MODEL = Path('/Users/ravius/projects/transport2/.local/validate-tuning-2026-09-26')
EVIDENCE = ROOT / '.tasks/T-4-2026-09-25-backend-dashboard-infra/artifacts/qa'
ENV = {**os.environ, 'DATA_DIR': str(DATA), 'MODEL_DIR': str(MODEL), 'PYTHONDONTWRITEBYTECODE': '1', 'PYTHONPATH': str(ROOT)}


def write(name, value):
    EVIDENCE.mkdir(parents=True, exist_ok=True)
    (EVIDENCE / name).write_text(json.dumps(value, indent=2, ensure_ascii=False, allow_nan=False))


def http(port, path, payload=None, timeout=5):
    data = json.dumps(payload).encode() if payload is not None else None
    host = '[::1]' if port == 8000 else '127.0.0.1'
    with build_opener(ProxyHandler({})).open(Request(f'http://{host}:{port}{path}', data=data,
                         headers={'Content-Type': 'application/json'}), timeout=timeout) as response:
        return json.load(response)


def compose(*args):
    return subprocess.run(['docker', 'compose', '-p', 'transport2', *args], cwd=ROOT,
                          env=ENV, capture_output=True, text=True, check=True)


def wait_ready(timeout=40):
    start = time.monotonic()
    while time.monotonic() - start < timeout:
        try:
            if all(http(p, '/ready', timeout=1)['status'] == 'ready' for p in (8000, 8001, 8002)):
                return time.monotonic() - start
        except Exception:
            pass
        time.sleep(.2)
    raise TimeoutError('three services not ready')


def distribution(values):
    return {'N': len(values), **({f'P{p}_ms': float(np.percentile(values, p)) for p in (50, 95, 99)}
                               if values else {}), 'max_ms': max(values) if values else None}


def unix_ns(value):
    return int(datetime.fromisoformat(value).replace(tzinfo=timezone.utc).timestamp() * 1e9)


def model_checks():
    from transport_ml.data import read_points, read_plan, read_traffic
    from transport_ml.final_model import FinalModel
    spec = importlib.util.spec_from_file_location('qa_api_inputs', ROOT / 'tests/test_final_model_api.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    output = EVIDENCE / 'oracle.csv'
    oracle_run = subprocess.run([sys.executable, str(MODEL / 'final_model.py'), 'predict', '--output', str(output)],
                                cwd=ROOT, env=ENV, text=True, capture_output=True, check=True)
    oracle = pd.read_csv(output, sep=';', dtype={'sample_id': str}).set_index('sample_id').prediction
    points, plan, traffic = read_points(DATA / 'validate/points.csv'), read_plan(DATA / 'validate/schedule_plan.csv'), read_traffic(DATA / 'validate/traffic.csv')
    package = FinalModel(MODEL)
    package_delta, http_delta, wire_delta, pairs = [], [], [], []
    for _, point in points.iterrows():
        request = module.request_for(point, plan, traffic)
        exact = http(8000, '/v1/predict', request)
        local = package.predict(**request)
        expected = float(oracle.loc[point.sample_id])
        assert exact['applicability'] == 'supported'
        assert exact['artifact_sha256'] == module.SHA
        package_delta.append(abs(local['prediction_s'] - expected))
        http_delta.append(abs(exact['prediction_s'] - expected))
        wire = copy.deepcopy(request)
        # Округляем поля Nav00; сохраняем receive_time и point/plan/cur_dev.
        for row in wire['telemetry']:
            row['event_time'] = str(pd.Timestamp(row['event_time']).floor('s'))
            valid = row['location_valid'] and row['lon'] is not None and row['lat'] is not None
            for key in ('lon', 'lat'):
                row[key] = round(row[key], 7) if valid else 0.0
            row['speed'] = max(0, min(65535, round(row['speed']))) if valid and row['speed'] is not None else 0
            row['heading'] = max(0, min(360, round(row['heading']))) if valid and row['heading'] is not None else 0
        rounded = http(8000, '/v1/predict', wire)
        assert rounded['applicability'] == 'supported'
        delta = abs(rounded['prediction_s'] - exact['prediction_s'])
        wire_delta.append(delta)
        pairs.append({'sample_id': point.sample_id, 'exact_s': exact['prediction_s'], 'wire_s': rounded['prediction_s'], 'abs_delta_s': delta})
    assert len(points) == 151 and max(package_delta) <= 1e-6 and max(http_delta) <= 1e-6
    schemas = {}
    for port, name in ((8000, 'openapi.json'), (8001, 'backend-openapi.json'), (8002, 'consumer-openapi.json')):
        actual = http(port, '/openapi.json')
        saved = json.loads((ROOT / 'docs/api' / name).read_text())
        schemas[name] = actual == saved
    write('model.json', {'N': len(points), 'package_max_delta_s': max(package_delta), 'HTTP_max_delta_s': max(http_delta),
                        'ready': http(8000, '/ready'), 'oracle_stdout': oracle_run.stdout,
                        'wire_mean_abs_delta_s': float(np.mean(wire_delta)), 'wire_max_abs_delta_s': max(wire_delta),
                        'wire_pairs': pairs, 'openapi_exact_match': schemas})
    assert all(schemas.values()), schemas


def replay_measurement(name='demo', faults=False, speedup=30, observe_minimum=53):
    before = http(8001, '/v1/ingest')
    mismatch = subprocess.run([sys.executable, 'scripts/replay_ndtp.py', '--traffic', str(DATA / 'validate/traffic.csv'),
                               '--limit', '1', '--epoch-origin', '1700003600'], cwd=ROOT, env=ENV, text=True, capture_output=True)
    after = http(8001, '/v1/ingest')
    assert mismatch.returncode != 0 and before['counters'] == after['counters']
    trace = EVIDENCE / f'{name}-sender.jsonl'
    process = subprocess.Popen([sys.executable, 'scripts/replay_ndtp.py', '--traffic', str(DATA / 'validate/traffic.csv'),
                                '--start', '2026-01-06 03:20:00', '--end', '2026-01-06 03:45:00', '--speedup', str(speedup), '--trace', str(trace)],
                               cwd=ROOT, env=ENV, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    observations, events = [], []
    stopped = restarted = paused = resumed = False
    action_time = None
    start = time.monotonic()
    try:
        while process.poll() is None or time.monotonic() - start < observe_minimum:
            checked_ns, checked_mono = time.time_ns(), time.monotonic_ns()
            wrapper = http(8002, '/api/snapshot')
            observe_ns, observe_mono = time.time_ns(), time.monotonic_ns()
            ingest = http(8001, '/v1/ingest')
            observations.append({'request_unix_ns': checked_ns, 'observe_unix_ns': observe_ns,
                                 'request_monotonic_ns': checked_mono, 'observe_monotonic_ns': observe_mono,
                                 'consumer': wrapper, 'ingest': ingest})
            snapshot = wrapper.get('snapshot') or {}
            successes = [r for r in snapshot.get('vehicles', []) if r.get('prediction_s') is not None]
            elapsed = time.monotonic() - start
            if faults:
                if not stopped and successes and elapsed < 35:
                    compose('stop', 'ml'); stopped = True; action_time = time.monotonic()
                    events.append({'action': 'stop_ml', 'elapsed_s': elapsed, 'last_success_rows': successes})
                elif stopped and not restarted and time.monotonic() - action_time > 5:
                    compose('start', 'ml'); restarted = True
                    events.append({'action': 'start_ml', 'elapsed_s': elapsed})
                elif restarted and not paused and elapsed > 40:
                    compose('pause', 'backend'); paused = True; action_time = time.monotonic()
                    offline = http(8002, '/api/snapshot')
                    assert offline['status'] == 'offline' and offline['snapshot'] is not None
                    events.append({'action': 'pause_backend_offline_consumer', 'elapsed_s': elapsed, 'consumer': offline})
                    compose('unpause', 'backend'); resumed = True
                    recovered = http(8002, '/api/snapshot')
                    assert recovered['status'] == 'online'
                    events.append({'action': 'unpause_backend_online_consumer', 'consumer': recovered})
            if process.poll() is not None and elapsed >= observe_minimum:
                break
            time.sleep(.1)
        stdout, stderr = process.communicate(timeout=10)
        assert process.returncode == 0, stderr
    finally:
        if paused and not resumed:
            compose('unpause', 'backend')
        if stopped and not restarted:
            compose('start', 'ml')
        if process.poll() is None:
            process.terminate(); process.wait(timeout=10)
    write(f'{name}-observations.json', observations)
    trace_rows = [json.loads(line) for line in trace.read_text().splitlines()]
    sends = {row['ack']['frame_id']: row for row in trace_rows if row['ack']['outcome'] == 'accepted'}
    ack_ms = [(r['ack_monotonic_ns'] - r['send_monotonic_ns']) / 1e6 for r in trace_rows]
    ingest_ms = [(unix_ns(r['ack']['received_at_utc']) - r['send_unix_ns']) / 1e6 for r in trace_rows]
    row_seen, pred_seen, revisions = set(), set(), set()
    publish_ms, observe_ms, prediction_ms, prediction_observe_ms = [], [], [], []
    correlated = []
    for obs in observations:
        snapshot = obs['consumer'].get('snapshot') or {}
        revisions.add(snapshot.get('revision'))
        for row in snapshot.get('vehicles', []):
            key = row.get('input_frame_id')
            frame_id = row.get('input_frame_id')
            if key not in row_seen and frame_id in sends:
                send = sends[frame_id]['send_unix_ns']
                publish_ms.append((row['published_unix_ns'] - send) / 1e6)
                observe_ms.append((obs['observe_monotonic_ns'] - sends[frame_id]['send_monotonic_ns']) / 1e6)
                row_seen.add(key)
            identity = (row.get('prediction_input_frame_id'), row.get('prediction_context_revision'), row.get('prediction_published_unix_ns'))
            frame_id = row.get('prediction_input_frame_id')
            if identity not in pred_seen and frame_id in sends and identity[2] is not None:
                send = sends[frame_id]['send_unix_ns']
                prediction_ms.append((identity[2] - send) / 1e6)
                prediction_observe_ms.append((obs['observe_monotonic_ns'] - sends[frame_id]['send_monotonic_ns']) / 1e6)
                pred_seen.add(identity)
                correlated.append({'frame_id': frame_id, 'send_unix_ns': send, 'prediction_published_unix_ns': identity[2],
                                   'observe_unix_ns': obs['observe_unix_ns'], 'prediction_context_revision': row['prediction_context_revision'],
                                   'prediction_s': row['prediction_s'], 'cur_dev_source': row['cur_dev_source']})
    end = http(8001, '/v1/ingest')
    summary = {'sender': json.loads(stdout), 'before': before, 'after': end, 'events': events,
               'consumer_revisions_N': len(revisions), 'consumer_observations_N': len(observations),
               'send_to_ack': distribution(ack_ms), 'send_to_ingest_wall': distribution(ingest_ms),
               'send_to_row_publish_wall': distribution(publish_ms), 'send_to_consumer_observe_monotonic': distribution(observe_ms),
               'send_to_prediction_publish_wall': distribution(prediction_ms), 'send_to_prediction_observe_monotonic': distribution(prediction_observe_ms),
               'prediction_correlations': correlated, 'max_ingest_queue_observed': max(o['ingest']['queue_depth'] for o in observations),
               'max_ml_queue_observed': max(o['ingest']['processing']['ml_queue_depth'] for o in observations),
               'final_consumer': http(8002, '/api/snapshot'), 'origin_mismatch_exit': mismatch.returncode,
               'origin_mismatch_stderr': mismatch.stderr}
    write(f'{name}.json', summary)
    calibrate_saved(name)
    assert len(pred_seen) >= 2 and len(revisions) >= 2
    assert end['processing']['ml_active_jobs'] == 0 and end['processing']['ml_queue_depth'] == 0
    if faults:
        assert stopped and restarted and paused and resumed
        assert any(any(r.get('reason') == 'ml_unreachable_or_timeout' for r in o['consumer']['snapshot']['vehicles']) for o in observations)
    return summary


def calibrate_saved(name):
    """Ограничиваем VM publication clock host-интервалом каждого consumer fetch."""
    summary = json.loads((EVIDENCE / f'{name}.json').read_text())
    observations = json.loads((EVIDENCE / f'{name}-observations.json').read_text())
    traces = [json.loads(line) for line in (EVIDENCE / f'{name}-sender.jsonl').read_text().splitlines()]
    sends = {r['ack']['frame_id']: r for r in traces if r['ack']['outcome'] == 'accepted'}
    seen_rows, seen_predictions = set(), set()
    values = {k: [] for k in ('row_lower', 'row_upper', 'prediction_lower', 'prediction_upper')}
    offsets = []
    for obs in observations:
        wrapper = obs['consumer']
        if wrapper['status'] != 'online':
            continue
        fetched = unix_ns(wrapper['fetched_at'])
        lower_offset = fetched - obs['observe_unix_ns']
        upper_offset = fetched - obs['request_unix_ns']
        offsets.append([lower_offset / 1e6, upper_offset / 1e6])
        for row in wrapper['snapshot']['vehicles']:
            frame = row.get('input_frame_id')
            if frame in sends and frame not in seen_rows:
                raw = row['published_unix_ns'] - sends[frame]['send_unix_ns']
                values['row_lower'].append((raw - upper_offset) / 1e6)
                values['row_upper'].append((raw - lower_offset) / 1e6)
                seen_rows.add(frame)
            identity = (row.get('prediction_input_frame_id'), row.get('prediction_context_revision'), row.get('prediction_published_unix_ns'))
            frame, _, published = identity
            if frame in sends and published is not None and identity not in seen_predictions:
                raw = published - sends[frame]['send_unix_ns']
                values['prediction_lower'].append((raw - upper_offset) / 1e6)
                values['prediction_upper'].append((raw - lower_offset) / 1e6)
                seen_predictions.add(identity)
    summary['calibrated_publication_bounds'] = {k: distribution(v) for k, v in values.items()}
    summary['observed_VM_offset_envelope_ms'] = [min(o[0] for o in offsets), max(o[1] for o in offsets)]
    summary['measurement_boundary'] = ('Row publication — первое наблюдение distinct frame_id; sampled upper bound, если ранняя публикация пропущена. '
        'Prediction identity: frame/context revision/publication timestamp; send anchor может предшествовать eligibility при negative lag. '
        'Consumer — HTTP API wrapper observation, не browser paint. Unix publication bounds используют fetched_at bracket при стабильной скорости VM/host wall clocks на интервале корреляции. '
        'Raw cross-VM deltas включают clock offset и не являются физической latency. Host monotonic send/ack/observe имеют общий domain; VM monotonic не вычитается.')
    write(f'{name}.json', summary)


def sparse13():
    from scripts.replay_ndtp import replay
    from transport_ml.data import read_plan
    plan = read_plan(DATA / 'validate/schedule_plan.csv')
    traffic = pd.read_csv(DATA / 'validate/traffic.csv', dtype={'tr_id': str, 'packet_id': str})
    selected = traffic.loc[traffic.tr_id.isin(plan.tr_id.unique())].groupby('unit_id', sort=False).head(5)
    selected = selected.sort_values(['receive_time', 'packet_id'], kind='stable')
    assert selected.unit_id.nunique() == 13
    path = EVIDENCE / 'sparse13.csv'; selected.to_csv(path, index=False)
    args = argparse.Namespace(traffic=path, start=None, end=None, units=None, limit=None, dataset_origin='2026-01-06 00:00:00',
                              epoch_origin=1700000000, timeout=5, speedup=1000000, backend_url='http://127.0.0.1:8001',
                              host='127.0.0.1', port=9201, trace=EVIDENCE / 'sparse13-sender.jsonl')
    result = replay(args)
    time.sleep(.5)
    write('sparse13.json', {'selection': 'Первые пять строк файла каждого из 13 planned unit; выбранное подмножество отсортировано по receive_time/packet_id, sparse ingest baseline',
                          'result': result, 'ingest': http(8001, '/v1/ingest'), 'snapshot': http(8001, '/v1/vehicles')})
    assert result['units'] == 13 and result['sent'] == 65


def burst():
    from scripts.replay_ndtp import handshake, navigation
    from transport_ml.data import read_plan
    plan = read_plan(DATA / 'validate/schedule_plan.csv')
    traffic = pd.read_csv(DATA / 'validate/traffic.csv', dtype={'tr_id': str})
    units = traffic.loc[traffic.tr_id.isin(plan.tr_id.unique())].groupby('tr_id').unit_id.first().to_dict()
    socks = []
    start = time.monotonic()
    for tr, unit in units.items():
        sock = socket.create_connection(('127.0.0.1', 9201), timeout=3)
        sock.sendall(handshake(int(unit))); socks.append((tr, unit, sock))
    deadline = time.monotonic() + 5
    while len(http(8001, '/v1/ingest')['active_sessions']) < 13 and time.monotonic() < deadline:
        time.sleep(.02)
    # Ограниченный burst отдельных кадров всех плановых unit без model hints.
    for tr, unit, sock in socks:
        stop = plan.loc[plan.tr_id == tr].iloc[0]
        row = pd.Series({'unit_id': unit, 'location_valid': True, 'lon': stop.stop_lon, 'lat': stop.stop_lat,
                         'speed': 0, 'heading': 0, 'event_time': pd.Timestamp('2026-01-06')})
        packets = []
        for i in range(2000):
            row.event_time = pd.Timestamp('2026-01-06') + pd.Timedelta(seconds=i)
            packets.append(navigation(row, i + 2, pd.Timestamp('2026-01-06'), 1700000000)[0])
        sock.sendall(b''.join(packets))
    duration = time.monotonic() - start
    time.sleep(1)
    result = http(8001, '/v1/ingest')
    for _, _, sock in socks:
        sock.close()
    write('burst.json', {'attempted': 26000, 'units': 13, 'send_duration_wall_s': duration,
                         'attempted_per_s': 26000 / duration, 'readback': result})
    assert result['counters'].get('dropped_queue_full', 0) > 0
    assert result['counters']['max_queue_depth'] <= result['counters']['queue_limit']
    assert result['queue_depth'] == 0


def protocol():
    from scripts.replay_ndtp import handshake, navigation, frame
    mapping = pd.read_csv(DATA / 'validate/traffic.csv').unit_id.unique()
    unit = int(mapping[0])
    row = pd.Series({'unit_id': unit, 'event_time': pd.Timestamp('2026-01-06'),
                     'location_valid': True, 'lon': 37.5, 'lat': 55.7, 'speed': 20, 'heading': 90})
    good = navigation(row, 2, pd.Timestamp('2026-01-06'), 1700000000)[0]
    def await_count(key, count):
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            result = http(8001, '/v1/ingest')
            if result['counters'].get(key, 0) >= count: return result
            time.sleep(.01)
        raise TimeoutError(f'{key} did not reach {count}')
    first = socket.create_connection(('127.0.0.1', 9201), timeout=3)
    h = handshake(unit)
    first.sendall(h[:4]); first.sendall(h[4:] + good)
    initial = await_count('accepted', 1)
    bad = bytearray(good); bad[-1] ^= 1
    unknown = frame(unit, 3, 1, 101, good[25:] + bytes((99, 0)))
    first.sendall(bytes(bad) + unknown + good)
    await_count('errors_crc', 1); await_count('errors_frame', 1); await_count('dropped_duplicate', 1)
    first.close(); await_count('disconnects', 1)
    second = socket.create_connection(('127.0.0.1', 9201), timeout=3)
    second.sendall(handshake(unit) + good)
    repeated = await_count('dropped_duplicate', 2)
    row.lon += .000001
    second.sendall(navigation(row, 2, pd.Timestamp('2026-01-06'), 1700000000)[0])
    corrected = await_count('accepted', 2)
    second.close(); final = await_count('disconnects', 2)
    assert final['counters']['accepted'] == 2
    assert initial['last_accepted']['session_id'] != corrected['last_accepted']['session_id']
    assert final['processing']['ml_started'] == 0
    write('protocol.json', {'initial': initial, 'repeated': repeated, 'corrected': corrected, 'final': final,
          'checks': ['fragmented handshake and coalesced Nav00', 'CRC rejection', 'unknown cell rejection',
                     'semantic repeat across reconnect', 'request ID reset and accepted correction']})


def infrastructure():
    def command(args):
        return subprocess.run(args, cwd=ROOT, env=ENV, text=True, capture_output=True, check=True).stdout
    samples = []
    for _ in range(7):
        before = time.time_ns()
        vm = int(compose('exec', '-T', 'backend', 'python', '-c', 'import time; print(time.time_ns())').stdout)
        after = time.time_ns()
        samples.append({'host_before_ns': before, 'vm_ns': vm, 'host_after_ns': after,
                        'offset_interval_ms': [(vm-after)/1e6, (vm-before)/1e6]})
    containers = json.loads(command(['docker', 'inspect', 'transport2-ml-1', 'transport2-backend-1', 'transport2-consumer-1']))
    write('infrastructure.json', {'hardware': command(['sysctl', 'hw.model', 'machdep.cpu.brand_string', 'hw.memsize']),
          'docker_info': json.loads(command(['docker', 'info', '--format', '{{json .}}'])),
          'containers': containers, 'clock_samples': samples, 'git_head': command(['git', 'rev-parse', 'HEAD']).strip()})
    mounts = {c['Name']: c['Mounts'] for c in containers}
    assert all(not m['RW'] for name, items in mounts.items() for m in items)
    assert not mounts['/transport2-consumer-1']


def official():
    """Current UTC ingest/reconnect без переноса на день обучения модели."""
    from transport_ml.data import read_plan
    traffic = pd.read_csv(DATA / 'validate/traffic.csv', dtype={'tr_id': str})
    plan = read_plan(DATA / 'validate/schedule_plan.csv')
    units = traffic.loc[traffic.tr_id.isin(plan.tr_id.unique())].unit_id.unique().tolist()
    compose('--profile', 'demo', 'down')
    ENV['SOURCE_CLOCK'] = 'utc'
    compose('up', '-d', '--wait')
    def docker(*args, check=True):
        return subprocess.run(['docker', *args], cwd=ROOT, env=ENV, text=True, capture_output=True, check=check)
    if docker('image', 'inspect', 'ndtp-telemetry-emulator:1.0', check=False).returncode:
        docker('load', '-i', str(DATA / 'emulator/ndtp-telemetry-emulator.tar'))
    run = docker('run', '-d', '--rm', '--name', 'transport2-ndtp-emu', '-p', '18080:18080',
                 '--add-host=host.docker.internal:host-gateway', 'ndtp-telemetry-emulator:1.0')
    start = time.monotonic()
    try:
        deadline = time.monotonic() + 40
        while True:
            try:
                http(18080, '/api/config'); break
            except Exception:
                if time.monotonic() > deadline: raise
                time.sleep(.2)
        config = http(18080, '/api/config', {'targetHost': 'host.docker.internal', 'targetPort': 9201,
            'units': [{'unitId': int(unit), 'intervalMs': 1000, 'autoGenerate': True, 'cells': []} for unit in units]})
        time.sleep(3)
        before = http(8001, '/v1/ingest')
        assert before['counters']['connections'] >= 13 and len(before['active_sessions']) == 13
        assert before['counters']['accepted'] >= 13
        initial = time.monotonic() - start
        restart_start = time.monotonic()
        compose('restart', 'backend')
        deadline = time.monotonic() + 45
        while True:
            try:
                after = http(8001, '/v1/ingest')
                if after['counters'].get('accepted', 0) >= 13 and len(after['active_sessions']) == 13: break
            except Exception:
                pass
            if time.monotonic() > deadline: raise TimeoutError('emulator failed to reconnect 13 units')
            time.sleep(.2)
        recovered = time.monotonic() - restart_start
        consumer = http(8002, '/api/snapshot')
        rows = [r for r in consumer['snapshot']['vehicles'] if r['unit_id'] in units]
        assert all(r['reason'] == 'unsupported_day' and r['prediction_s'] is None for r in rows)
        write('official-emulator.json', {'host_UTC': datetime.now(timezone.utc).isoformat(), 'units': units,
            'config_response': config, 'emulator_stdout': run.stdout, 'initial_13unit_ingest_wall_s': initial,
            'backend_restart_to_13unit_ingest_wall_s': recovered, 'before': before, 'after': after, 'consumer': consumer})
    finally:
        docker('stop', 'transport2-ndtp-emu', check=False)
        ENV.pop('SOURCE_CLOCK', None)


def docker_demo():
    """Запускаем shipped Compose demo и сохраняем точное disconnected состояние."""
    start = time.monotonic()
    compose('--profile', 'demo', 'build', 'replay')
    rebuild_s = time.monotonic() - start
    compose('restart', 'backend', 'consumer')
    wait_ready()
    start = time.monotonic()
    compose('--profile', 'demo', 'up', '-d', 'replay')
    revisions, predictions, observations = set(), set(), []
    deadline = time.monotonic() + 100
    while True:
        wrapper = http(8002, '/api/snapshot')
        snapshot = wrapper['snapshot']
        revisions.add(snapshot['revision'])
        for row in snapshot['vehicles']:
            if row['prediction_s'] is not None:
                predictions.add((row['tr_id'], row['prediction_published_unix_ns']))
        observations.append({'host_unix_ns': time.time_ns(), 'consumer': wrapper})
        status = subprocess.run(['docker', 'inspect', 'transport2-replay-1', '--format', '{{json .State}}'],
                                cwd=ROOT, env=ENV, text=True, capture_output=True, check=True)
        state = json.loads(status.stdout)
        if state['Status'] == 'exited': break
        if time.monotonic() > deadline: raise TimeoutError('Compose demo did not exit')
        time.sleep(.2)
    assert state['ExitCode'] == 0
    time.sleep(.3)
    logs = compose('--profile', 'demo', 'logs', '--no-log-prefix', 'replay').stdout
    sender = json.loads(logs.strip().splitlines()[-1])
    final = http(8002, '/api/snapshot')
    write('docker-demo-observations.json', observations)
    write('docker-demo.json', {'replay_rebuild_wall_s': rebuild_s, 'launch_to_exit_wall_s': time.monotonic()-start,
          'sender': sender, 'consumer_revisions_N': len(revisions), 'consumer_predictions_N': len(predictions),
          'ingest': http(8001, '/v1/ingest'), 'final_consumer': final, 'sender_container_state': state})
    assert sender['sent'] == 1630 and len(predictions) >= 2 and len(revisions) >= 2
    assert all(not r['connected'] for r in final['snapshot']['vehicles'])


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('phase', choices=['model', 'demo', 'faults', 'accelerated', 'sparse13', 'burst', 'official', 'infrastructure', 'protocol', 'docker-demo', 'readback'])
    args = parser.parse_args()
    EVIDENCE.mkdir(parents=True, exist_ok=True)
    if args.phase == 'model': model_checks()
    elif args.phase == 'demo': replay_measurement()
    elif args.phase == 'faults': replay_measurement('faults', True)
    elif args.phase == 'accelerated': replay_measurement('accelerated', False, 3000, 10)
    elif args.phase == 'sparse13': sparse13()
    elif args.phase == 'burst': burst()
    elif args.phase == 'docker-demo': docker_demo()
    elif args.phase == 'protocol': protocol()
    elif args.phase == 'official': official()
    elif args.phase == 'infrastructure': infrastructure()
    else: write('final-readback.json', {'ingest': http(8001, '/v1/ingest'), 'consumer': http(8002, '/api/snapshot')})
    print(json.dumps({'phase': args.phase, 'completed': True, 'evidence_dir': str(EVIDENCE)}))


if __name__ == '__main__':
    main()

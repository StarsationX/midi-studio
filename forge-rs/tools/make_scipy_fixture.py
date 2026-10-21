"""make_scipy_fixture.py OUTDIR: scipy.signal.butter(4, fc, 'highpass', fs,
output='sos'), sosfilt_zi and sosfiltfilt(...).astype(float32) golden values
for tests/scipy_filter.rs (melody_to_midi's lead high-pass)."""
import json
import sys
from pathlib import Path
import numpy as np
from scipy.signal import butter, sosfilt_zi, sosfiltfilt

out = Path(sys.argv[1])
cases = []
for fs in (16000, 22050, 32000, 44100, 48000, 88200, 96000):
    for fc in (45.0, 55.0, 61.735, 110.0, 440.0):
        sos = butter(4, fc, btype="highpass", fs=fs, output="sos")
        cases.append({"fs": fs, "fc": fc, "sos": [float(v).hex() for v in sos.ravel()],
                      "zi": [float(v).hex() for v in sosfilt_zi(sos).ravel()]})
json.dump(cases, open(out / "scipy_butter.json", "w"))
rng = np.random.default_rng(5)
x = (rng.standard_normal(6000) * 0.3).astype(np.float32)
x[1000:1200] += np.float32(0.8)
np.save(out / "scipy_x.npy", x)
y = sosfiltfilt(butter(4, 55.0, btype="highpass", fs=44100, output="sos"), x).astype(np.float32)
np.save(out / "scipy_y.npy", y)
print(len(cases), "cases")

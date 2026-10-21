"""Run a Python script (or `-m module`) inside a 7.5 GiB Job Object.

    python capped.py path/to/script.py args...
    python capped.py -m package.module args...

The job is created and this process assigned to it before anything else is
imported, so torch/onnxruntime and every child process inherit the cap.
Prints peak commit / working set on exit.
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import memcap  # noqa: E402

memcap.apply(int(float(os.environ.get("MEMCAP_GIB", "7.5")) * memcap.GIB))

import atexit  # noqa: E402
import runpy  # noqa: E402

atexit.register(memcap.report)

if len(sys.argv) < 2:
    print(__doc__)
    sys.exit(2)
if sys.argv[1] == "-m":
    mod = sys.argv[2]
    sys.argv = [mod] + sys.argv[3:]
    runpy.run_module(mod, run_name="__main__", alter_sys=True)
else:
    script = os.path.abspath(sys.argv[1])
    sys.argv = [script] + sys.argv[2:]
    sys.path.insert(0, os.path.dirname(script))
    runpy.run_path(script, run_name="__main__")

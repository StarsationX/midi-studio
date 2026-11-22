// Keep the public npm build entry point; use Python's standard ZIP reader for
// both wheel and NuGet archives without installing another npm dependency.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const embedded = path.join(__dirname, '../python-engine/python/python.exe');
const python = process.env.PYTHON || (fs.existsSync(embedded) ? embedded : 'python');
require('node:child_process').execFileSync(python, [path.join(__dirname, 'stage_native_assets.py')], {stdio: 'inherit'});

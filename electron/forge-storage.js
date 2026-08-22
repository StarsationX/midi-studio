'use strict';

const fs = require('fs');
const path = require('path');

const MARKER = '.midi-studio-forge';
const FOLDER_NAME = 'MIDI Studio Forge';

function normalized(value) {
  return path.resolve(String(value || '')).replace(/[\\/]+$/, '').toLowerCase();
}

function samePath(a, b) { return !!a && !!b && normalized(a) === normalized(b); }

function isInside(child, parent) {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function targetForSelection(selected) {
  const dir = path.resolve(String(selected || ''));
  return path.basename(dir).toLowerCase() === FOLDER_NAME.toLowerCase() ? dir : path.join(dir, FOLDER_NAME);
}

function markerPath(dir) { return path.join(dir, MARKER); }

function markManaged(dir) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(markerPath(dir), 'Managed by MIDI Studio.\n', { encoding: 'utf8', flag: 'w' });
  return dir;
}

function isManaged(dir, defaultDir = '') {
  if (!dir) return false;
  if (defaultDir && samePath(dir, defaultDir)) return true;
  return fs.existsSync(markerPath(dir));
}

function isEmpty(dir) {
  try { return !fs.existsSync(dir) || fs.readdirSync(dir).length === 0; } catch { return false; }
}

function assertWritable(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const probe = path.join(dir, `.midi-studio-write-${process.pid}-${Date.now()}`);
  fs.writeFileSync(probe, 'ok');
  fs.unlinkSync(probe);
}

async function moveManaged(source, target, defaultDir = '') {
  source = path.resolve(source);
  target = path.resolve(target);
  if (samePath(source, target)) return { moved: false, path: target };
  if (!isManaged(source, defaultDir)) throw new Error('The current Forge folder is not marked as managed by MIDI Studio.');
  if (isInside(target, source) || isInside(source, target)) throw new Error('Choose a folder outside the current Forge folder.');
  assertWritable(path.dirname(target));
  if (!isEmpty(target)) throw new Error('The selected Forge destination is not empty.');
  if (fs.existsSync(target)) await fs.promises.rm(target, { recursive: true, force: true });

  try {
    await fs.promises.rename(source, target);
  } catch (error) {
    if (error.code !== 'EXDEV') throw error;
    const staging = `${target}.moving`;
    await fs.promises.rm(staging, { recursive: true, force: true });
    try {
      await fs.promises.cp(source, staging, { recursive: true, errorOnExist: true, force: false });
      markManaged(staging);
      await fs.promises.rename(staging, target);
      await fs.promises.rm(source, { recursive: true, force: true });
    } catch (copyError) {
      await fs.promises.rm(staging, { recursive: true, force: true }).catch(() => {});
      throw copyError;
    }
  }
  markManaged(target);
  return { moved: true, path: target };
}

async function configure(settings, target, current, defaultDir) {
  target = String(target || '').trim();
  if (!target) throw new Error('Choose a Forge storage folder.');
  target = path.resolve(target);
  current = path.resolve(String(current || defaultDir || ''));
  defaultDir = path.resolve(String(defaultDir || current));

  let moved = false;
  if (samePath(current, target)) {
    assertWritable(target);
    markManaged(target);
  } else if (!isEmpty(target)) {
    if (!isManaged(target, defaultDir)) {
      throw new Error('The Forge storage destination is not empty. Choose another folder.');
    }
  } else if (fs.existsSync(current)) {
    if (!isManaged(current, defaultDir)) {
      throw new Error('The current Forge folder is not marked as managed by MIDI Studio.');
    }
    await moveManaged(current, target, defaultDir);
    moved = true;
  } else {
    assertWritable(path.dirname(target));
    markManaged(target);
  }

  settings.merge({ paths: {
    forgeEnvDir: samePath(target, defaultDir) ? '' : target,
    forgePythonPath: '',
    modelsDir: '',
  } });
  return { moved, path: target };
}

module.exports = {
  MARKER, FOLDER_NAME, samePath, targetForSelection, markManaged,
  isManaged, isEmpty, assertWritable, moveManaged, configure,
};

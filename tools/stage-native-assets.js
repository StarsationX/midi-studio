// Gather the provisioned ONNX graphs and native runtime for an offline build.
// These are release inputs. Forge reads them directly through ONNX Runtime.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const engine = process.env.MIDI_STUDIO_FORGE_ENV_DIR || path.join(process.env.LOCALAPPDATA || '', 'midi-studio', 'forge-env');
const models = process.env.MIDI_STUDIO_MODELS_DIR || path.join(engine, 'models');
const devAssets = path.join(root, 'forge-rs', 'assets');
const target = path.join(root, 'forge-rs', 'target', 'native-resources');
const release = 'GAME-1.0.3-medium-onnx';
function stage(relative, choices) {
  const source = choices.filter(Boolean).find(p => fs.statSync(p, {throwIfNoEntry:false})?.isFile());
  if (!source) throw Error('Missing native build input ' + relative + '. Looked in ' + choices.filter(Boolean).join(', '));
  const dest = path.join(target, relative);
  fs.mkdirSync(path.dirname(dest), {recursive:true});
  fs.copyFileSync(source, dest);
}
stage('bs_rofo_sw/bsrofo_sw_body.onnx', [process.env.FORGE_RS_ROFO_MODEL, path.join(models,'bs_rofo_sw','bsrofo_sw_body.onnx'),path.join(devAssets,'bs_rofo_sw','bsrofo_sw_body.onnx')]);
stage('onnx/transkun_v2_aux.safetensors', [process.env.FORGE_RS_AUX,path.join(models,'onnx','transkun_v2_aux.safetensors'),path.join(devAssets,'transkun_v2_aux.safetensors')]);
for (const name of ['transkun_v2.onnx','transkun_v2.onnx.data']) stage('onnx/'+name,[path.join(models,'onnx',name)]);
for (const model of ['encoder','segmenter','estimator','bd2dur','dur2bd']) {
  const rel=path.join('game',release,model+'.onnx');
  stage(rel,[path.join(models,rel),path.join(devAssets,rel)]);
}
stage('basic_pitch/nmp.onnx',[process.env.FORGE_RS_BP_MODEL,path.join(engine,'python/Lib/site-packages/basic_pitch/saved_models/icassp_2022/nmp.onnx'),path.join(devAssets,'basic_pitch','nmp.onnx')]);
const explicitOrt = process.env.ORT_DYLIB_PATH;
const discoveredOrtDirs = [path.join(engine,'ort-gpu'), path.join(root,'src-tauri/target/release/ort-gpu')];
const ortDirs = [process.env.FORGE_RS_ORT_GPU_DIR, ...(explicitOrt
  ? (path.basename(explicitOrt).toLowerCase() === 'onnxruntime.dll' ? [path.dirname(explicitOrt)] : [])
  : discoveredOrtDirs)].filter(Boolean);
const providers = ['onnxruntime.dll','onnxruntime_providers_shared.dll','onnxruntime_providers_cuda.dll'];
const gpu = ortDirs.find(dir => providers.every(name => fs.statSync(path.join(dir, name), {throwIfNoEntry:false})?.isFile()));
if (gpu) {
  for (const name of providers) stage('ort/'+name,[path.join(gpu,name)]);
} else {
  stage('ort/onnxruntime.dll',[explicitOrt || path.join(engine,'python/Lib/site-packages/onnxruntime/capi/onnxruntime.dll')]);
  for (const name of providers.slice(1)) fs.rmSync(path.join(target, 'ort', name), {force:true});
}
console.log('Staged native Forge assets in ' + target);

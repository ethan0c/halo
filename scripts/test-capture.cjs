const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
function loadCapture(electron = {}) {
  const context = { require: () => electron, module: { exports: {} }, process: { platform: 'test' } };
  vm.runInNewContext(fs.readFileSync('src/main/capture.js', 'utf8'), context);
  return context.module.exports;
}
const plain = value => JSON.parse(JSON.stringify(value));
const area = { x: 40, y: 120, width: 600, height: 400, displayId: 'saved', displayWidth: 1440, displayHeight: 900 };
test('saved area scales to actual thumbnails and rounds inward', () => {
  const { areaBounds } = loadCapture();
  assert.deepEqual(plain(areaBounds({width:2880,height:1800}, {width:1440,height:900}, area)), {x:80,y:240,width:1200,height:800});
  assert.deepEqual(plain(areaBounds({width:100,height:100}, {width:300,height:300}, {x:10,y:10,width:40,height:40})), {x:4,y:4,width:12,height:12});
  for (const bad of [{x:-1}, {width:0}, {x:1400}, {height:NaN}]) {
    assert.throws(() => areaBounds({width:1440,height:900}, {width:1440,height:900}, {...area,...bad}));
  }
});
test('saved display wins over cursor; crop precedes encoding; missing display fails closed', async () => {
  const calls = [];
  const image = {
    isEmpty: () => false, getSize: () => ({width:1440,height:900}),
    crop(rect) { calls.push(['crop',plain(rect)]); return { getSize: () => ({width:rect.width,height:rect.height}), toJPEG() { calls.push(['encode']); return Buffer.from('cropped'); } }; },
  };
  const display = {id:'saved',size:{width:1440,height:900},scaleFactor:1};
  let displays = [display];
  const electron = {
    screen: { getAllDisplays: () => displays, getCursorScreenPoint: () => { throw Error('must not use cursor'); } },
    desktopCapturer: { getSources: async () => [{display_id:'saved',thumbnail:image}] },
  };
  const { captureScreen } = loadCapture(electron);
  const result = await captureScreen({}, area);
  assert.deepEqual(calls, [['crop',{x:40,y:120,width:600,height:400}],['encode']]);
  assert.equal(result.data, Buffer.from('cropped').toString('base64'));
  displays = [];
  await assert.rejects(captureScreen({}, area), /unavailable/);
  displays = [{...display,size:{width:1280,height:800}}];
  await assert.rejects(captureScreen({}, area), /size changed/);
});
test('selection supports reverse dragging, rejects tiny areas and cancels with Escape', () => {
  const handlers = {};
  const results = [];
  const box = {style:{},hidden:true};
  const hint = {};
  vm.runInNewContext(fs.readFileSync('src/renderer/selection.js','utf8'), {
    innerWidth:1000, innerHeight:800,
    document: {getElementById:id => id==='selection' ? box : hint, body:{setPointerCapture(){}}, addEventListener:(event,fn) => {handlers[event]=fn;}},
    window:{captureArea:{finish:rect => results.push(plain(rect))}},
  });
  handlers.pointerdown({button:0,clientX:600,clientY:500,pointerId:1});
  handlers.pointerup({clientX:100,clientY:120});
  assert.deepEqual(results, [{x:100,y:120,width:500,height:380}]);
  handlers.pointerdown({button:0,clientX:10,clientY:10,pointerId:1});
  handlers.pointerup({clientX:12,clientY:12});
  assert.equal(results.length,1);
  handlers.keydown({key:'Escape'});
  assert.equal(results[1],null);
});

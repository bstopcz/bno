// Szybki test rdzenia na sztucznej mapie: node test/smoke.js
// (albo otwórz test/smoke.html w przeglądarce)
const { T, analyze, classify, costGrid, routeLeg } = typeof require !== 'undefined' ? require('../core.js') : BnoCore;
const assert = {
  strictEqual(a, b, msg) { if (a !== b) throw new Error((msg || 'assert') + `: ${a} !== ${b}`); },
  ok(v, msg) { if (!v) throw new Error(msg || 'assert'); },
};
const print = (...a) => {
  const line = a.map((v) => (typeof v === 'string' ? v : JSON.stringify(v))).join(' ');
  if (typeof document !== 'undefined') document.body.append(line, document.createElement('br'));
  else console.log(line);
};

const W = 300, H = 200;
const data = new Uint8ClampedArray(W * H * 4);
const rect = (x0, y0, x1, y1, rgb) => {
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
    const o = (y * W + x) * 4;
    data[o] = rgb[0]; data[o + 1] = rgb[1]; data[o + 2] = rgb[2]; data[o + 3] = 255;
  }
};
rect(0, 0, W, H, [250, 250, 248]);        // las
rect(120, 0, 180, 150, [60, 170, 70]);    // ciemna zieleń na przelocie
rect(200, 20, 260, 60, [255, 186, 54]);   // żółte
rect(20, 20, 60, 50, [125, 125, 125]);    // budynek
rect(20, 175, 281, 177, [20, 20, 20]);    // ścieżka dołem
rect(20, 100, 22, 177, [20, 20, 20]);
rect(279, 100, 281, 177, [20, 20, 20]);
rect(0, 70, 110, 73, [160, 40, 200]);     // fioletowa linia trasy w lesie
rect(210, 38, 250, 40, [205, 95, 20]);    // warstwica na żółtym

const cls = classify(data, W, H);
const at = (x, y) => cls[y * W + x];
assert.strictEqual(at(5, 190), T.FOREST);
assert.strictEqual(at(150, 50), T.GREEN3);
assert.strictEqual(at(230, 30), T.OPEN);
assert.strictEqual(at(40, 35), T.BUILDING);
assert.strictEqual(at(150, 176), T.PATH);
assert.strictEqual(at(50, 71), T.FOREST, 'fiolet ma być wypełniony lasem');
assert.strictEqual(at(230, 39), T.OPEN, 'warstwica ma być wypełniona żółtym');

const cost = costGrid(cls);
const t0 = Date.now();
const leg = routeLeg(cost, W, H, { x: 21, y: 100 }, { x: 280, y: 100 });
const inGreen = leg.best.path.filter((i) => cls[i] === T.GREEN3).length;
assert.strictEqual(inGreen, 0, 'najlepszy wariant ma omijać ciemną zieleń');
assert.ok(leg.best.cost < leg.straight.cost, 'wariant ma być szybszy od prostej');
const onPath = leg.best.path.filter((i) => cls[i] === T.PATH).length / leg.best.path.length;
assert.ok(onPath > 0.8, 'wariant ma iść głównie ścieżką, jest ' + onPath.toFixed(2));

print('OK', {
  ms: Date.now() - t0,
  best: Math.round(leg.best.cost), straight: Math.round(leg.straight.cost),
  alt: leg.alt ? Math.round(leg.alt.cost) : null, onPath: +onPath.toFixed(2),
});

// --- przeszkody nie do przejścia ---
{
  rect(0, 0, W, H, [250, 250, 248]);
  rect(140, 0, 160, 170, [150, 165, 55]);                 // oliwkowy pas z przejściem na dole
  for (let x = 200; x < 260; x += 5) rect(x, 60, x + 2, 140, [160, 40, 200]); // fioletowy szraf
  rect(60, 80, 90, 110, [0, 150, 235]);                   // jezioro
  const c2 = classify(data, W, H, 'forest');
  assert.strictEqual(c2[50 * W + 150], T.FORBIDDEN);
  assert.strictEqual(c2[100 * W + 230], T.OOB, 'szraf ma być terenem wyłączonym');
  assert.strictEqual(c2[95 * W + 75], T.LAKE);
  const k2 = costGrid(c2);
  const l2 = routeLeg(k2, W, H, { x: 20, y: 100 }, { x: 290, y: 100 });
  assert.ok(l2.best, 'ma znaleźć obejście');
  assert.strictEqual(l2.best.path.filter((i) => k2[i] === Infinity).length, 0, 'trasa nie może wejść w zakazane');
  assert.strictEqual(l2.straight.cost, Infinity);
  const l3 = routeLeg(k2, W, H, { x: 20, y: 100 }, { x: 150, y: 50 }); // cel w zakazanym -> dociąga do krawędzi
  assert.ok(l3.best && l3.best.path.every((i) => k2[i] !== Infinity));

  // sprint: mur przecięty fioletową linią trasy ma zostać szczelny
  rect(0, 0, W, H, [250, 250, 248]);
  rect(150, 0, 152, H, [20, 20, 20]);
  rect(0, 99, W, 102, [160, 40, 200]);
  const c3 = classify(data, W, H, 'sprint');
  assert.strictEqual(c3[50 * W + 150], T.WALL);
  const l4 = routeLeg(costGrid(c3), W, H, { x: 20, y: 100 }, { x: 280, y: 100 });
  assert.strictEqual(l4.best, null, 'mur od krawędzi do krawędzi = brak przejścia');
  print('OK przeszkody');
}

// --- symbole punktowe: zielony × (wykrot) na jasnej zieleni nie może zostać gęstwiną ---
{
  rect(0, 0, W, H, [250, 250, 248]);
  rect(50, 50, 250, 150, [200, 240, 195]); // jasna zieleń
  const G = [47, 180, 83];
  for (let d = -2; d <= 2; d++) { rect(100 + d, 100 + d, 101 + d, 101 + d, G); rect(100 + d, 100 - d, 101 + d, 101 - d, G); }
  for (let a = 0; a < 40; a++) { // zielone kółko (drzewo)
    const x = Math.round(180.5 + 2.5 * Math.cos(a * Math.PI / 20)), y = Math.round(100.5 + 2.5 * Math.sin(a * Math.PI / 20));
    rect(x, y, x + 1, y + 1, G);
  }
  rect(140, 60, 143, 63, [20, 20, 20]);    // kamień
  const res = analyze(data, W, H, 'forest');
  const kinds = res.features.map((f) => f.color + ' ' + f.kind).sort().join(', ');
  assert.strictEqual(kinds, 'black dot, green ring, green x');
  assert.strictEqual(res.cls[100 * W + 100], T.GREEN1, 'pod wykrotem ma zostać jasna zieleń');
  assert.strictEqual(res.cls[61 * W + 141], T.GREEN1, 'kamień nie jest ścieżką');
  print('OK symbole:', kinds);
}

// --- georeferencja: mapa obrócona o 10°, 0.5 px/m ---
{
  const geo = typeof require !== 'undefined' ? require('../geo.js') : BnoGeo;
  const ref = { lat: 52.2, lon: 21.0 };
  const rot = 10 * Math.PI / 180, k = 0.5;
  const truth = (lat, lon) => {
    const z = geo.toLocal(ref, lat, lon);
    return { px: 800 + k * (Math.cos(rot) * z.x - Math.sin(rot) * z.y), py: 600 + k * (Math.sin(rot) * z.x + Math.cos(rot) * z.y) };
  };
  const pts = [[52.2, 21.0], [52.21, 21.02], [52.195, 21.015]].map(([lat, lon]) => Object.assign({ lat, lon }, truth(lat, lon)));
  const cal = geo.fit(pts);
  const want = truth(52.205, 20.99), got = geo.toPixel(cal, 52.205, 20.99);
  assert.ok(Math.hypot(want.px - got.x, want.py - got.y) < 0.5, 'pozycja po kalibracji');
  assert.ok(Math.abs(cal.pxPerM - 0.5) < 1e-3 && cal.rmsM < 0.5);
  const north = geo.headingVector(cal, 0);
  assert.ok(Math.abs(north.x - Math.sin(rot)) < 1e-3 && Math.abs(north.y + Math.cos(rot)) < 1e-3, 'kierunek północy na mapie');
  for (const deg of [0, 75, 200, 310]) {
    const v = geo.headingVector(cal, deg);
    assert.ok(Math.abs(geo.bearingOf(cal, v.x * 50, v.y * 50) - deg) < 0.01, 'bearingOf odwraca headingVector');
  }
  assert.strictEqual(geo.fit(pts.slice(0, 1)), null);
  assert.strictEqual(JSON.stringify(geo.parseLatLon('52,2297; 21,0122')), JSON.stringify({ lat: 52.2297, lon: 21.0122 }));
  assert.strictEqual(geo.parseLatLon('abc'), null);
  print('OK georeferencja');
}

// wydajność na rozdzielczości roboczej telefonu
const BW = 1600, BH = 1200;
const big = new Float32Array(BW * BH).fill(1.6);
const t1 = Date.now();
routeLeg(big, BW, BH, { x: 10, y: 10 }, { x: 1590, y: 1190 });
print('1600x1200 routeLeg ms:', Date.now() - t1);

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
  rect(50, 50, 250, 150, [217, 236, 216]); // jasna zieleń (blada jak na prawdziwej mapie)
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

// --- stopnie zieleni liczone względem najciemniejszej zieleni na mapie ---
{
  rect(0, 0, W, H, [250, 250, 248]);
  rect(10, 10, 90, 90, [217, 236, 216]);   // jasna
  rect(110, 10, 190, 90, [163, 212, 165]); // średnia
  rect(210, 10, 290, 90, [47, 180, 87]);   // ciemna
  for (let x = 20; x < 90; x += 4) rect(x, 110, x + 1, 190, [99, 197, 128]); // paski podszytu
  const c5 = classify(data, W, H, 'forest');
  assert.strictEqual(c5[50 * W + 50], T.GREEN1, 'blada zieleń to jasna zieleń, nie biały las');
  assert.strictEqual(c5[50 * W + 150], T.GREEN2);
  assert.strictEqual(c5[50 * W + 250], T.GREEN3);
  assert.strictEqual(c5[150 * W + 50], T.GREEN1, 'paski podszytu zlewają się w jasną zieleń');
  assert.strictEqual(c5[150 * W + 51], T.GREEN1);
  assert.strictEqual(c5[150 * W + 200], T.FOREST);
  print('OK zieleń');
}

// --- kształt czarnych linii: droga, cienka linia, płot, wysoki płot, mur z kropkami, linia energetyczna, ścieżka ---
{
  const L = typeof require !== 'undefined' ? require('../lines.js') : BnoLines;
  const LW = 500, LH = 320, m = new Uint8Array(LW * LH);
  const box = (x0, y0, x1, y1) => { for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) m[y * LW + x] = 1; };
  box(20, 28, 480, 33);                                            // droga: gruba, ciągła
  box(20, 70, 480, 72);                                            // cienka ciągła linia bez znaczków
  box(20, 110, 480, 112); for (let x = 40; x < 470; x += 30) box(x, 103, x + 2, 110);            // płot: pojedyncze kreseczki
  box(20, 160, 480, 162); for (let x = 40; x < 460; x += 40) { box(x, 153, x + 2, 160); box(x + 6, 153, x + 8, 160); } // wysoki płot
  box(20, 210, 480, 212); for (let x = 40; x < 470; x += 30) box(x, 207, x + 7, 215);            // mur: kropki na linii
  box(20, 250, 480, 252); for (let x = 100; x < 470; x += 150) box(x, 243, x + 2, 260);          // linia energetyczna: poprzeczki
  for (let x = 20; x < 470; x += 17) box(x, 290, x + 12, 293);                                   // ścieżka: kreski
  const names = ['brak', 'neutralna', 'ścieżka', 'płot', 'mur'];
  const check = (sprint, want) => {
    const lab = L.classifyLines(m, LW, LH, sprint);
    const got = [[250, 30], [250, 71], [250, 111], [255, 161], [265, 211], [200, 251], [59, 291]].map(([x, y]) => names[lab[y * LW + x]]);
    assert.strictEqual(got.join(', '), want, (sprint ? 'sprint' : 'las'));
  };
  check(false, 'ścieżka, neutralna, płot, mur, płot, neutralna, ścieżka');
  check(true, 'mur, neutralna, płot, mur, płot, neutralna, neutralna');
  print('OK linie');
}

// --- przewyższenia: trzy warstwice w poprzek przebiegu, obejście bokiem jest dłuższe, ale płaskie ---
{
  rect(0, 0, W, H, [250, 250, 248]);
  for (const y of [60, 100, 140]) rect(0, y, 220, y + 2, [205, 95, 20]);
  rect(150, 0, 152, H, [20, 20, 20]); // ścieżka prosto przez warstwice (zasłania brąz)
  const res = analyze(data, W, H, 'forest');
  assert.strictEqual(res.contour[60 * W + 100], 1, 'brązowa linia to warstwica');
  assert.strictEqual(res.contour[60 * W + 150], 1, 'warstwica pod ścieżką ma zostać warstwicą');
  assert.strictEqual(res.contour[80 * W + 100], 0);
  const k4 = costGrid(res.cls), a = { x: 150, y: 20 }, b = { x: 150, y: 180 };
  const flat = routeLeg(k4, W, H, a, b);
  assert.strictEqual(flat.best.crossings, undefined);
  const mild = routeLeg(k4, W, H, a, b, { contour: res.contour, perCrossing: 10 });
  assert.strictEqual(mild.best.crossings, 3, 'przy małej karze biegniemy ścieżką przez 3 warstwice');
  assert.ok(Math.abs(mild.best.cost - flat.best.cost - 30) < 1, 'kara = 3 przecięcia po 10');
  const steep = routeLeg(k4, W, H, a, b, { contour: res.contour, perCrossing: 150 });
  assert.strictEqual(steep.best.crossings, 0, 'przy dużej karze obiegamy warstwice');
  assert.ok(steep.best.length > mild.best.length * 1.3);
  assert.strictEqual(steep.straight.crossings, 3);
  print('OK przewyższenia');
}

// --- mapa z pliku OCAD: symbole -> siatka terenu (tylko w przeglądarce, bo rysowanie używa canvas) ---
if (typeof document !== 'undefined') {
  const sym = (num, type, name, lineWidth) => ({ num: num * 1000, type, name, lineWidth: lineWidth || 0, hidden: false });
  const symbols = new Map([[101, 2], [301, 3], [401, 3], [408, 3], [505, 2], [518, 2], [519, 1], [520, 3], [521, 3], [601, 2]]
    .map(([n, t]) => [n * 1000, sym(n, t, 'symbol ' + n, t === 2 ? 0.25 : 0)]));
  const rect = (x0, y0, x1, y1) => [x0, y0, x1, y0, x1, y1, x0, y1];
  const map = {
    geo: { scale: 10000 }, symbols,
    objects: [
      { sym: 401000, type: 3, rings: [rect(0, 0, 200, 150)] },                          // otwarte na całej mapie
      { sym: 408000, type: 3, rings: [rect(20, 100, 60, 140)] },                        // zielony średni
      { sym: 301000, type: 3, rings: [rect(120, 90, 180, 140), rect(140, 105, 160, 125)] }, // jezioro z wyspą (dziura)
      { sym: 520000, type: 3, rings: [rect(20, 20, 60, 60)] },                          // teren zakazany
      { sym: 521000, type: 3, rings: [rect(30, 30, 40, 40)] },                          // budynek w zakazanym
      { sym: 518000, type: 2, rings: [[110, 20, 190, 20, 190, 60, 110, 60, 110, 20]] }, // zamknięte ogrodzenie nie do przejścia
      { sym: 519000, type: 1, rings: [[110, 40]] },                                     // punkt przejścia w ogrodzeniu
      { sym: 505000, type: 2, rings: [[70, 40, 150, 40]] },                             // ścieżka przez punkt przejścia
      { sym: 101000, type: 2, rings: [[0, 10, 200, 10]] },                              // warstwica
      { sym: 601000, type: 2, rings: [[150, 0, 150, 150]] },                            // linia północy: pomijana
    ],
  };
  const g = BnoSymbols.build(map, 800);
  assert.strictEqual(g.setName, 'ISOM 2017 (las)');
  assert.ok(Math.abs(g.mpp - 10 * 204 / 800) < 0.01, 'metry na pole: ' + g.mpp);
  const at = (x, y) => g.cls[Math.round((g.bounds.y1 - y) * g.k) * g.w + Math.round((x - g.bounds.x0) * g.k)];
  assert.strictEqual(at(80, 20), T.OPEN);
  assert.strictEqual(at(40, 120), T.GREEN2);
  assert.strictEqual(at(130, 100), T.LAKE);
  assert.strictEqual(at(150, 115), T.OPEN, 'wyspa na jeziorze');
  assert.strictEqual(at(50, 50), T.FORBIDDEN);
  assert.strictEqual(at(35, 35), T.BUILDING);
  assert.strictEqual(at(110, 30), T.WALL);
  assert.strictEqual(at(130, 40), T.PATH2);
  assert.ok(at(110, 40) !== T.WALL, 'punkt przejścia otwiera płot');
  assert.strictEqual(at(150, 70), T.OPEN, 'linia północy nie zmienia terenu');
  assert.strictEqual(g.contour[Math.round((g.bounds.y1 - 10) * g.k) * g.w + 300], 1);
  const px = (x, y) => ({ x: Math.round((x - g.bounds.x0) * g.k), y: Math.round((g.bounds.y1 - y) * g.k) });
  const leg = routeLeg(costGrid(g.cls), g.w, g.h, px(80, 80), px(170, 50));
  assert.ok(leg.best, 'jest wejście do ogrodzenia');
  const gate = px(110, 40);
  assert.ok(leg.best.path.some((i) => Math.abs(i % g.w - gate.x) < 12 && Math.abs(((i / g.w) | 0) - gate.y) < 12), 'trasa idzie przez punkt przejścia');
  // ręczna zmiana: płot oznaczony jako "pomijany" przestaje blokować
  const g2 = BnoSymbols.build(map, 800, { 518000: 'ignore' });
  const leg2 = routeLeg(costGrid(g2.cls), g2.w, g2.h, px(80, 80), px(170, 50));
  assert.ok(leg2.best.cost <= leg.best.cost + 0.01 && !g2.cls.includes(T.WALL), 'po zmianie płot znika z siatki');
  print('OK OCAD -> siatka, m/pole', g.mpp.toFixed(2));
}

// --- okno wyszukiwania: krótki przebieg na dużej siatce nie przeszukuje całej mapy, a wynik jest ten sam ---
{
  const GW = 3200, GH = 2400, g = new Float32Array(GW * GH).fill(1.6);
  for (let y = 900; y < 1100; y++) for (let x = 1500; x < 1520; x++) g[y * GW + x] = Infinity; // ściana w poprzek
  const t = Date.now();
  const leg = routeLeg(g, GW, GH, { x: 1400, y: 1000 }, { x: 1620, y: 1000 });
  const ms = Date.now() - t;
  assert.ok(leg.best && leg.best.path.every((i) => g[i] !== Infinity), 'trasa omija ścianę');
  assert.strictEqual(leg.best.path[0], 1000 * GW + 1400);
  assert.strictEqual(leg.best.path[leg.best.path.length - 1], 1000 * GW + 1620);
  assert.ok(leg.best.length > 300 && leg.best.length < 420, 'długość obejścia: ' + leg.best.length);
  // cel zamknięty w oknie, ale osiągalny dookoła: szukanie musi wyjść poza okno
  for (let y = 0; y < GH; y++) g[y * GW + 1500] = y > 30 ? Infinity : 1.6;
  const far = routeLeg(g, GW, GH, { x: 1480, y: 2300 }, { x: 1520, y: 2300 });
  assert.ok(far.best && far.best.length > 4000, 'obejście przez całą mapę');
  print('OK okno wyszukiwania, krótki przebieg na siatce 3200x2400 ms:', ms);
}

// wydajność na rozdzielczości roboczej telefonu
const BW = 1600, BH = 1200;
const big = new Float32Array(BW * BH).fill(1.6);
const t1 = Date.now();
routeLeg(big, BW, BH, { x: 10, y: 10 }, { x: 1590, y: 1190 });
print('1600x1200 routeLeg ms:', Date.now() - t1);

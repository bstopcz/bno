// Rdzeń: klasyfikacja terenu z kolorów mapy + szukanie najszybszego wariantu.
// Działa w przeglądarce (globalny obiekt BnoCore) i w Node (module.exports).
(function (root) {
  'use strict';

  const T = {
    FOREST: 0, OPEN: 1, PATH: 2, PAVED: 3, GREEN1: 4, GREEN2: 5, GREEN3: 6,
    WATER: 7, FORBIDDEN: 8, BUILDING: 9, OVERLAY: 10, PURPLE: 11,
    LAKE: 12, OOB: 13, WALL: 14, IMPVEG: 15, BROWN: 16,
  };
  const X = Infinity; // nie do przejścia

  // cost = ile razy wolniej niż po ścieżce. Musi być >= 1 (zakłada to heurystyka A*).
  const TERRAIN = [
    { name: 'las (biały)', cost: 1.6, rgb: [255, 255, 255] },
    { name: 'teren otwarty', cost: 1.25, rgb: [255, 200, 70] },
    { name: 'ścieżka / czarna linia', cost: 1.0, rgb: [0, 0, 0] },
    { name: 'utwardzone', cost: 1.0, rgb: [225, 190, 150] },
    { name: 'zielony jasny', cost: 2.2, rgb: [190, 235, 180] },
    { name: 'zielony średni', cost: 3.5, rgb: [120, 205, 120] },
    { name: 'zielony ciemny', cost: 7, rgb: [40, 150, 60] },
    { name: 'woda do przejścia / bagno', cost: 4, rgb: [120, 190, 250] },
    { name: 'teren zakazany (oliwkowy)', cost: X, rgb: [140, 150, 40] },
    { name: 'budynek', cost: X, rgb: [110, 110, 110] },
    { name: 'nadruk', cost: 1.6, rgb: [200, 60, 200], internal: true },
    { name: 'fiolet', cost: 1.6, rgb: [200, 60, 200], internal: true },
    { name: 'woda nie do przejścia', cost: X, rgb: [20, 70, 180] },
    { name: 'teren wyłączony (fioletowa kratka)', cost: X, rgb: [230, 0, 150] },
    { name: 'mur / płot (sprint)', cost: X, rgb: [150, 0, 0] },
    { name: 'zieleń nie do przejścia (sprint)', cost: X, rgb: [0, 90, 30] },
    { name: 'brąz', cost: 1.6, rgb: [200, 110, 40], internal: true },
  ];

  // Symbole punktowe rozpoznawane po kolorze i kształcie.
  const POINT_NAMES = {
    green: { x: 'wykrot / pień', ring: 'wyróżniające się drzewo', dot: 'krzak / małe drzewo' },
    black: { dot: 'kamień', x: 'obiekt (×)', ring: 'obiekt (○)' },
    brown: { dot: 'kopczyk', x: 'wykrot / obiekt terenowy' },
    blue: { dot: 'oczko wodne', ring: 'studnia / źródło' },
  };

  // Biel papieru: 90. percentyl każdego kanału (zdjęcia bywają ciemne / zażółcone).
  function whitePoint(data, n) {
    const hist = [new Uint32Array(256), new Uint32Array(256), new Uint32Array(256)];
    let count = 0;
    for (let i = 0; i < n; i += 4) {
      const o = i * 4;
      hist[0][data[o]]++; hist[1][data[o + 1]]++; hist[2][data[o + 2]]++;
      count++;
    }
    return hist.map((hh) => {
      let acc = 0;
      const target = count * 0.9;
      for (let v = 0; v < 256; v++) {
        acc += hh[v];
        if (acc >= target) return Math.max(v, 60);
      }
      return 255;
    });
  }

  function classifyPixel(r, g, b) {
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    const v = max / 255;
    const d = max - min;
    const s = max === 0 ? 0 : d / max;

    if (v < 0.4 || (s < 0.15 && v < 0.62)) return T.PATH; // czarne / szare
    if (s < 0.15) return T.FOREST; // biały papier

    let h;
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
    if (h < 0) h += 360;

    if (h < 15 || h >= 345) return T.PURPLE; // czerwień (fiolet przekłamany przez aparat)
    if (h < 33) return s < 0.45 ? T.PAVED : T.BROWN; // jasny brąz = utwardzone, mocny = warstwice
    if (h >= 50 && h < 85 && v < 0.75 && s > 0.4) return T.FORBIDDEN; // oliwkowy
    if (h < 70) return T.OPEN; // żółty
    if (h < 165) return s < 0.27 ? T.GREEN1 : s < 0.45 ? T.GREEN2 : T.GREEN3;
    if (h < 255) return s > 0.35 ? T.LAKE : T.WATER; // pełny niebieski = kandydat na jezioro
    return T.PURPLE; // fiolet trasy
  }

  function integral(mask, w, h) {
    const W = w + 1;
    const I = new Uint32Array(W * (h + 1));
    for (let y = 0; y < h; y++) {
      let row = 0;
      for (let x = 0; x < w; x++) {
        row += mask[y * w + x];
        I[(y + 1) * W + x + 1] = I[y * W + x + 1] + row;
      }
    }
    return I;
  }

  function boxSum(I, w, h, x, y, r) {
    const W = w + 1;
    const x0 = Math.max(0, x - r), y0 = Math.max(0, y - r);
    const x1 = Math.min(w, x + r + 1), y1 = Math.min(h, y + r + 1);
    return I[y1 * W + x1] - I[y0 * W + x1] - I[y1 * W + x0] + I[y0 * W + x0];
  }
  function boxArea(w, h, x, y, r) {
    return (Math.min(w, x + r + 1) - Math.max(0, x - r)) * (Math.min(h, y + r + 1) - Math.max(0, y - r));
  }

  // Zostawia tylko "grube" plamy maski (cienkie linie znikają).
  function opening(mask, w, h, r) {
    const I = integral(mask, w, h);
    const core = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (mask[y * w + x] && boxSum(I, w, h, x, y, r) >= boxArea(w, h, x, y, r) * 0.9) core[y * w + x] = 1;
      }
    }
    const IC = integral(core, w, h);
    const out = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (mask[y * w + x] && boxSum(IC, w, h, x, y, r) > 0) out[y * w + x] = 1;
      }
    }
    return out;
  }

  // Obszar gęsto pokryty maską (szraf, kratka, pełny kolor). Pojedyncze linie,
  // kółka i numery są za rzadkie, żeby się załapać.
  function denseAreas(mask, w, h, R, frac) {
    const I = integral(mask, w, h);
    const dense = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (boxSum(I, w, h, x, y, R) > boxArea(w, h, x, y, R) * frac) dense[y * w + x] = 1;
      }
    }
    return opening(dense, w, h, R);
  }

  // Linie północy: kilka długich, równoległych, prawie pionowych czarnych kresek.
  // Bez tego trasa "biegłaby" po nich jak po ścieżkach. Wykrywane transformatą Hougha.
  function removeNorthLines(cls, w, h) {
    const NT = 61, tans = new Float32Array(NT);
    for (let t = 0; t < NT; t++) tans[t] = Math.tan((t - 30) * 0.5 * Math.PI / 180);
    const off = Math.ceil(h * tans[NT - 1]) + 1, bins = w + 2 * off;
    const acc = new Uint16Array(NT * bins);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (cls[y * w + x] !== T.PATH) continue;
        for (let t = 0; t < NT; t++) acc[t * bins + Math.round(x - y * tans[t]) + off]++;
      }
    }
    const minLen = h * 0.25;
    let bestT = -1, bestPeaks = [];
    for (let t = 0; t < NT; t++) {
      const peaks = [];
      for (let b = 1; b < bins - 1; b++) {
        const v = acc[t * bins + b];
        if (v < minLen || v < acc[t * bins + b - 1] || v < acc[t * bins + b + 1]) continue;
        if (peaks.length && b - peaks[peaks.length - 1] < 10) continue;
        peaks.push(b);
      }
      if (peaks.length > bestPeaks.length) { bestPeaks = peaks; bestT = t; }
    }
    if (bestPeaks.length < 3) return 0;
    for (const b of bestPeaks) {
      for (let y = 0; y < h; y++) {
        const xc = Math.round(b - off + y * tans[bestT]);
        for (let x = Math.max(0, xc - 1); x <= Math.min(w - 1, xc + 1); x++) {
          if (cls[y * w + x] === T.PATH) cls[y * w + x] = T.OVERLAY;
        }
      }
    }
    return bestPeaks.length;
  }

  // Spójne składowe maski (8-sąsiedztwo). cb(buf, count, x0, y0, x1, y1) dla każdej.
  function components(mask, w, h, cb) {
    const n = w * h;
    const seen = new Uint8Array(n);
    const buf = new Int32Array(n);
    for (let s0 = 0; s0 < n; s0++) {
      if (!mask[s0] || seen[s0]) continue;
      let count = 0, head = 0;
      let x0 = w, y0 = h, x1 = 0, y1 = 0;
      buf[count++] = s0; seen[s0] = 1;
      while (head < count) {
        const i = buf[head++];
        const x = i % w, y = (i / w) | 0;
        if (x < x0) x0 = x; if (x > x1) x1 = x;
        if (y < y0) y0 = y; if (y > y1) y1 = y;
        for (let dy = -1; dy <= 1; dy++) {
          const ny = y + dy;
          if (ny < 0 || ny >= h) continue;
          for (let dx = -1; dx <= 1; dx++) {
            const nx = x + dx;
            if (nx < 0 || nx >= w) continue;
            const j = ny * w + nx;
            if (mask[j] && !seen[j]) { seen[j] = 1; buf[count++] = j; }
          }
        }
      }
      cb(buf, count, x0, y0, x1, y1);
    }
  }

  // Kształt małej składowej: 'dash' (kreska), 'dot', 'ring', 'x', 'speck' (pyłek) albo 'other'.
  function shapeKind(buf, count, x0, y0, x1, y1, w) {
    const bw = x1 - x0 + 1, bh = y1 - y0 + 1;
    let mx = 0, my = 0;
    for (let k = 0; k < count; k++) { mx += buf[k] % w; my += (buf[k] / w) | 0; }
    mx /= count; my /= count;
    let sxx = 0, syy = 0, sxy = 0;
    const grid = new Float32Array(9);
    for (let k = 0; k < count; k++) {
      const x = buf[k] % w, y = (buf[k] / w) | 0;
      sxx += (x - mx) * (x - mx); syy += (y - my) * (y - my); sxy += (x - mx) * (y - my);
      grid[Math.min(2, ((y - y0) * 3 / bh) | 0) * 3 + Math.min(2, ((x - x0) * 3 / bw) | 0)]++;
    }
    sxx /= count; syy /= count; sxy /= count;
    const tr = sxx + syy, disc = Math.sqrt(Math.max(0, tr * tr - 4 * (sxx * syy - sxy * sxy)));
    const elong = Math.sqrt((tr + disc) / Math.max(tr - disc, 0.16));
    if (count >= 3 && elong >= 2.5) return 'dash';
    if (Math.max(bw, bh) < 3) return 'speck';
    const cells = new Float32Array(9);
    for (let y = 0; y < bh; y++) for (let x = 0; x < bw; x++) cells[Math.min(2, (y * 3 / bh) | 0) * 3 + Math.min(2, (x * 3 / bw) | 0)]++;
    for (let c = 0; c < 9; c++) grid[c] /= cells[c];
    const center = grid[4];
    const corners = (grid[0] + grid[2] + grid[6] + grid[8]) / 4;
    const edges = (grid[1] + grid[3] + grid[5] + grid[7]) / 4;
    let outerMin = 1;
    for (let c = 0; c < 9; c++) if (c !== 4 && grid[c] < outerMin) outerMin = grid[c];
    if (Math.max(bw, bh) >= 5 && center < 0.15 && edges >= 0.25 && outerMin > 0) return 'ring';
    if (count / (bw * bh) >= 0.7) return 'dot';
    if (center >= 0.5 && corners >= 0.25 && corners - edges >= 0.12) return 'x';
    return 'other';
  }

  // Wycina z mapy terenu małe symbole (żeby np. zielony × wykrotu nie liczył się jako gęstwina)
  // i dopisuje rozpoznane do listy features.
  function extractPoints(cls, w, h, P, features) {
    const specs = [[T.PATH, 'black'], [T.GREEN3, 'green'], [T.BROWN, 'brown'], [T.LAKE, 'blue']];
    for (const [t, color] of specs) {
      const mask = new Uint8Array(w * h);
      for (let i = 0; i < mask.length; i++) mask[i] = cls[i] === t ? 1 : 0;
      components(mask, w, h, (buf, count, x0, y0, x1, y1) => {
        if (x1 - x0 >= P || y1 - y0 >= P) return; // linia albo obszar
        const kind = shapeKind(buf, count, x0, y0, x1, y1, w);
        if (t === T.PATH && kind === 'dash') return; // kreska przerywanej ścieżki
        for (let k = 0; k < count; k++) cls[buf[k]] = T.OVERLAY;
        const name = POINT_NAMES[color][kind];
        if (name) features.push({ x: (x0 + x1) / 2, y: (y0 + y1) / 2, size: Math.max(x1 - x0, y1 - y0) + 1, kind, color, name });
      });
    }
  }

  // Ścieżka / mur przecięte nadrukiem (linia trasy, warstwica) zostają ciągłe.
  function bridgeLines(cls, w, h, k) {
    const isOver = (c) => c === T.OVERLAY || c === T.PURPLE;
    const scan = (x, y, dx, dy) => {
      for (let s = 1; s <= k; s++) {
        const nx = x + dx * s, ny = y + dy * s;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) return 0;
        const c = cls[ny * w + nx];
        if (isOver(c)) continue;
        return c === T.PATH || c === T.WALL ? c : 0;
      }
      return 0;
    };
    const dirs = [[1, 0], [0, 1], [1, 1], [1, -1]];
    const found = [];
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        if (!isOver(cls[i])) continue;
        for (const [dx, dy] of dirs) {
          const a = scan(x, y, dx, dy);
          if (a && a === scan(x, y, -dx, -dy)) { found.push(i, a); break; }
        }
      }
    }
    for (let k2 = 0; k2 < found.length; k2 += 2) cls[found[k2]] = found[k2 + 1];
  }

  // Nadruk (fiolet trasy, warstwice) dostaje klasę najbliższego terenu obok.
  function fillOverlay(cls, w, h) {
    const n = w * h;
    const queue = new Int32Array(n);
    let head = 0, tail = 0;
    for (let i = 0; i < n; i++) {
      if (cls[i] !== T.OVERLAY && cls[i] !== T.PATH && cls[i] !== T.WALL) queue[tail++] = i;
    }
    while (head < tail) {
      const i = queue[head++];
      const x = i % w, c = cls[i];
      if (x > 0 && cls[i - 1] === T.OVERLAY) { cls[i - 1] = c; queue[tail++] = i - 1; }
      if (x < w - 1 && cls[i + 1] === T.OVERLAY) { cls[i + 1] = c; queue[tail++] = i + 1; }
      if (i >= w && cls[i - w] === T.OVERLAY) { cls[i - w] = c; queue[tail++] = i - w; }
      if (i < n - w && cls[i + w] === T.OVERLAY) { cls[i + w] = c; queue[tail++] = i + w; }
    }
    for (let i = 0; i < n; i++) if (cls[i] === T.OVERLAY) cls[i] = T.FOREST;
  }

  // data: RGBA (jak ImageData.data). mode: 'forest' albo 'sprint'.
  // Wąska szczelina w przeszkodzie (np. ślad po linii północy przez jezioro) zostaje zaklejona.
  // Ścieżki i drogi zostają: most przez rzekę czy przejście między płotami dalej działa.
  function sealSlivers(cls, w, h, k) {
    const hard = (c) => TERRAIN[c].cost === Infinity && c !== T.WALL;
    const keep = (c) => c === T.PATH || c === T.PAVED || c === T.WALL;
    const scan = (x, y, dx, dy) => {
      for (let s = 1; s <= k; s++) {
        const nx = x + dx * s, ny = y + dy * s;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) return 0;
        const c = cls[ny * w + nx];
        if (hard(c)) return c;
        if (keep(c)) return 0;
      }
      return 0;
    };
    const dirs = [[1, 0], [0, 1], [1, 1], [1, -1]];
    const found = [];
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x, c = cls[i];
        if (hard(c) || keep(c)) continue;
        for (const [dx, dy] of dirs) {
          const a = scan(x, y, dx, dy);
          if (a && a === scan(x, y, -dx, -dy)) { found.push(i, a); break; }
        }
      }
    }
    for (let q = 0; q < found.length; q += 2) cls[found[q]] = found[q + 1];
  }

  // Zwraca { cls: Uint8Array klas terenu, features: rozpoznane symbole punktowe }.
  function analyze(data, w, h, mode) {
    const sprint = mode === 'sprint';
    const n = w * h;
    const cls = new Uint8Array(n);
    const wp = whitePoint(data, n);
    const kr = 255 / wp[0], kg = 255 / wp[1], kb = 255 / wp[2];
    for (let i = 0; i < n; i++) {
      const o = i * 4;
      cls[i] = classifyPixel(
        Math.min(255, data[o] * kr), Math.min(255, data[o + 1] * kg), Math.min(255, data[o + 2] * kb));
    }
    const r = Math.max(2, Math.round(Math.max(w, h) / 400));
    const maskOf = (t) => { const m = new Uint8Array(n); for (let i = 0; i < n; i++) m[i] = cls[i] === t ? 1 : 0; return m; };

    // małe symbole (wykrot, kamień, kopczyk...) wycinamy, zanim policzymy teren
    const P = Math.max(6, Math.round(Math.max(w, h) / 150));
    const features = [];
    extractPoints(cls, w, h, P, features);
    for (let i = 0; i < n; i++) if (cls[i] === T.BROWN) cls[i] = T.OVERLAY;

    // gruba czarna/szara plama = budynek; cienka linia = ścieżka (las) albo mur/płot (sprint)
    const thickDark = opening(maskOf(T.PATH), w, h, Math.max(2, Math.round(r / 2)));
    for (let i = 0; i < n; i++) {
      if (thickDark[i]) cls[i] = T.BUILDING;
      else if (sprint && cls[i] === T.PATH) cls[i] = T.WALL;
    }

    // gęsty czarny szraf = teren zakazany (stare mapy), a nie pęk ścieżek
    const hatch = denseAreas(maskOf(T.PATH), w, h, P, 0.22);
    for (let i = 0; i < n; i++) if (hatch[i] && cls[i] !== T.BUILDING && cls[i] !== T.PAVED) cls[i] = T.FORBIDDEN;
    if (!sprint) removeNorthLines(cls, w, h);

    // żółte / beżowe paseczki szerokości 1 px to rozmyte krawędzie warstwic, a nie teren
    for (const t of [T.OPEN, T.PAVED]) {
      const m = maskOf(t), keep = opening(m, w, h, 1);
      for (let i = 0; i < n; i++) if (m[i] && !keep[i]) cls[i] = T.OVERLAY;
    }

    // oliwkowy liczy się tylko jako plama; cienkie paski to krawędzie czarnej linii na żółtym
    const forb = maskOf(T.FORBIDDEN);
    const thickForb = opening(forb, w, h, r);
    for (let i = 0; i < n; i++) if (forb[i] && !thickForb[i]) cls[i] = T.OVERLAY;

    // mocny niebieski: plama = jezioro nie do przejścia, cienka linia = rów / strumień
    const deep = maskOf(T.LAKE);
    const thickDeep = opening(deep, w, h, r);
    for (let i = 0; i < n; i++) if (deep[i] && !thickDeep[i]) cls[i] = T.WATER;

    // w sprincie ciemna zieleń jest zakazana
    if (sprint) for (let i = 0; i < n; i++) if (cls[i] === T.GREEN3) cls[i] = T.IMPVEG;

    const oob = denseAreas(maskOf(T.PURPLE), w, h, r * 3, 0.3);
    for (let i = 0; i < n; i++) if (oob[i]) cls[i] = T.OOB;

    bridgeLines(cls, w, h, r + 2);
    for (let i = 0; i < n; i++) if (cls[i] === T.PURPLE) cls[i] = T.OVERLAY;
    fillOverlay(cls, w, h);
    sealSlivers(cls, w, h, 3);
    return { cls, features };
  }

  function classify(data, w, h, mode) {
    return analyze(data, w, h, mode).cls;
  }

  function costGrid(cls) {
    const cost = new Float32Array(cls.length);
    for (let i = 0; i < cls.length; i++) cost[i] = TERRAIN[cls[i]].cost;
    return cost;
  }

  // A* po siatce 8-sąsiedzkiej. Zwraca tablicę indeksów komórek od startu do celu
  // albo null, gdy cel jest odcięty terenem nie do przejścia (koszt Infinity).
  function findPath(cost, w, h, sx, sy, tx, ty) {
    const n = w * h, start = sy * w + sx, goal = ty * w + tx;
    const g = new Float32Array(n).fill(Infinity);
    const parent = new Int32Array(n).fill(-1);
    const closed = new Uint8Array(n);
    const hf = [], hn = [];
    const push = (f, node) => {
      let i = hf.length;
      hf.push(f); hn.push(node);
      while (i > 0) {
        const p = (i - 1) >> 1;
        if (hf[p] <= f) break;
        hf[i] = hf[p]; hn[i] = hn[p]; i = p;
      }
      hf[i] = f; hn[i] = node;
    };
    const pop = () => {
      const top = hn[0];
      const f = hf.pop(), node = hn.pop();
      const len = hf.length;
      if (len > 0) {
        let i = 0;
        for (;;) {
          let c = 2 * i + 1;
          if (c >= len) break;
          if (c + 1 < len && hf[c + 1] < hf[c]) c++;
          if (hf[c] >= f) break;
          hf[i] = hf[c]; hn[i] = hn[c]; i = c;
        }
        hf[i] = f; hn[i] = node;
      }
      return top;
    };
    const heur = (x, y) => {
      const dx = Math.abs(x - tx), dy = Math.abs(y - ty);
      return Math.max(dx, dy) + (Math.SQRT2 - 1) * Math.min(dx, dy);
    };

    g[start] = 0;
    push(heur(sx, sy), start);
    while (hf.length) {
      const i = pop();
      if (closed[i]) continue;
      closed[i] = 1;
      if (i === goal) break;
      const x = i % w, y = (i / w) | 0;
      for (let dy = -1; dy <= 1; dy++) {
        const ny = y + dy;
        if (ny < 0 || ny >= h) continue;
        for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dy) continue;
          const nx = x + dx;
          if (nx < 0 || nx >= w) continue;
          const j = ny * w + nx;
          if (closed[j] || cost[j] === Infinity) continue;
          // po skosie nie przeciskamy się między dwiema komórkami przeszkody
          if (dx && dy && (cost[y * w + nx] === Infinity || cost[ny * w + x] === Infinity)) continue;
          const ng = g[i] + (dx && dy ? Math.SQRT2 : 1) * (cost[i] + cost[j]) * 0.5;
          if (ng < g[j]) {
            g[j] = ng; parent[j] = i;
            push(ng + heur(nx, ny), j);
          }
        }
      }
    }
    if (g[goal] === Infinity) return null;
    const path = [];
    for (let i = goal; i !== -1; i = parent[i]) path.push(i);
    path.reverse();
    return path;
  }

  // cost = czas w "pikselach po ścieżce", length = długość w pikselach
  function pathStats(path, cost, w) {
    let c = 0, len = 0;
    for (let k = 1; k < path.length; k++) {
      const a = path[k - 1], b = path[k];
      const d = (a % w !== b % w && ((a / w) | 0) !== ((b / w) | 0)) ? Math.SQRT2 : 1;
      len += d;
      c += d * (cost[a] + cost[b]) * 0.5;
    }
    return { cost: c, length: len };
  }

  function lineStats(cost, w, sx, sy, tx, ty) {
    const dist = Math.hypot(tx - sx, ty - sy);
    const steps = Math.max(1, Math.ceil(dist));
    let c = 0;
    for (let k = 0; k < steps; k++) {
      const t = (k + 0.5) / steps;
      c += cost[Math.round(sy + (ty - sy) * t) * w + Math.round(sx + (tx - sx) * t)];
    }
    return { cost: c * dist / steps, length: dist };
  }

  // Drugi wariant: karzemy okolice środka najlepszej trasy i szukamy jeszcze raz.
  function findAlternative(cost, w, h, best, sx, sy, tx, ty) {
    const path = best.path;
    const from = Math.floor(path.length * 0.15), to = Math.ceil(path.length * 0.85);
    const R = Math.max(6, Math.round(best.length * 0.06));
    const mark = new Uint8Array(w * h);
    const penal = new Float32Array(cost);
    for (let k = from; k < to; k += 2) {
      const px = path[k] % w, py = (path[k] / w) | 0;
      for (let y = Math.max(0, py - R); y <= Math.min(h - 1, py + R); y++) {
        for (let x = Math.max(0, px - R); x <= Math.min(w - 1, px + R); x++) {
          const i = y * w + x;
          if (!mark[i]) { mark[i] = 1; penal[i] *= 3; }
        }
      }
    }
    const altPath = findPath(penal, w, h, sx, sy, tx, ty);
    if (!altPath) return null;
    let inside = 0, total = 0;
    for (let k = Math.floor(altPath.length * 0.15); k < altPath.length * 0.85; k++) {
      total++;
      if (mark[altPath[k]]) inside++;
    }
    if (!total || inside / total > 0.5) return null; // to praktycznie ta sama trasa
    const stats = pathStats(altPath, cost, w);
    if (stats.cost > best.cost * 1.5) return null; // za słaby, żeby go pokazywać
    return { path: altPath, cost: stats.cost, length: stats.length };
  }

  // Punkt stuknięty na przeszkodzie (np. róg budynku) przesuwamy na najbliższe przebieżne miejsce.
  function nearestPassable(cost, w, h, p) {
    if (cost[p.y * w + p.x] !== Infinity) return p;
    for (let R = 1; R <= 60; R++) {
      let best = null, bestD = Infinity;
      for (let dy = -R; dy <= R; dy++) {
        for (let dx = -R; dx <= R; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== R) continue;
          const x = p.x + dx, y = p.y + dy;
          if (x < 0 || y < 0 || x >= w || y >= h || cost[y * w + x] === Infinity) continue;
          const d = dx * dx + dy * dy;
          if (d < bestD) { bestD = d; best = { x, y }; }
        }
      }
      if (best) return best;
    }
    return null;
  }

  // Przebieg między dwoma punktami: najlepszy wariant, alternatywa i linia prosta.
  // best === null oznacza brak przejścia.
  function routeLeg(cost, w, h, p, q) {
    const straight = lineStats(cost, w, p.x, p.y, q.x, q.y);
    const a = nearestPassable(cost, w, h, p), b = nearestPassable(cost, w, h, q);
    const path = a && b ? findPath(cost, w, h, a.x, a.y, b.x, b.y) : null;
    if (!path) return { best: null, alt: null, straight };
    const best = Object.assign({ path }, pathStats(path, cost, w));
    const alt = path.length > 20 ? findAlternative(cost, w, h, best, a.x, a.y, b.x, b.y) : null;
    return { best, alt, straight };
  }

  const api = { T, TERRAIN, POINT_NAMES, analyze, classify, costGrid, findPath, pathStats, lineStats, routeLeg };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.BnoCore = api;
})(typeof self !== 'undefined' ? self : this);

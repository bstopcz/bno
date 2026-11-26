// Rozpoznawanie czarnych linii po kształcie: co jest ścieżką, a co płotem, murem albo linią bez znaczenia.
// Działa w przeglądarce (globalny BnoLines) i w Node (module.exports).
//
// Skąd bierze różnice (wg norm ISOM / ISSprOM):
//  - ścieżka jest przerywana (krótkie kreski), droga ciągła i gruba,
//  - płot i mur mają znaczki z boku: kreseczki albo kropki; podwójne znaczki lub gruba linia = nie do przejścia,
//  - linia energetyczna i kolej mają poprzeczki PRZECINAJĄCE linię (to nie jest płot),
//  - w sprincie o przejściu decyduje grubość: gruba czarna linia jest nie do przejścia.
// Grubości oceniamy względnie (cienkie vs grube na tej samej mapie), bo z samego obrazu nie znamy milimetrów.
(function (root) {
  'use strict';

  const NONE = 0, NEUTRAL = 1, PATH = 2, FENCE = 3, WALL = 4;

  // Maska ciemnych pikseli z RGBA, z tym samym wyrównaniem bieli co reszta analizy.
  function darkMask(data, w, h) {
    const n = w * h;
    const hist = [new Uint32Array(256), new Uint32Array(256), new Uint32Array(256)];
    let count = 0;
    for (let i = 0; i < n; i += 4) { const o = i * 4; hist[0][data[o]]++; hist[1][data[o + 1]]++; hist[2][data[o + 2]]++; count++; }
    const wp = hist.map((hh) => { let acc = 0; for (let v = 0; v < 256; v++) { acc += hh[v]; if (acc >= count * 0.9) return Math.max(v, 60); } return 255; });
    const kr = 255 / wp[0], kg = 255 / wp[1], kb = 255 / wp[2];
    const dark = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      const o = i * 4;
      const r = Math.min(255, data[o] * kr), g = Math.min(255, data[o + 1] * kg), b = Math.min(255, data[o + 2] * kb);
      const max = Math.max(r, g, b), min = Math.min(r, g, b), v = max / 255, s = max === 0 ? 0 : (max - min) / max;
      dark[i] = v < 0.4 || (s < 0.15 && v < 0.62) ? 1 : 0;
    }
    return dark;
  }

  // Odległość każdego ciemnego piksela od tła (metryka 3-4, czyli wynik / 3 = piksele).
  function distance(dark, w, h) {
    const n = w * h, BIG = 60000, d = new Uint16Array(n);
    for (let i = 0; i < n; i++) d[i] = dark[i] ? BIG : 0;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        if (!d[i]) continue;
        let m = x === 0 || y === 0 ? 3 : BIG;
        if (x > 0) m = Math.min(m, d[i - 1] + 3);
        if (y > 0) {
          m = Math.min(m, d[i - w] + 3);
          if (x > 0) m = Math.min(m, d[i - w - 1] + 4);
          if (x < w - 1) m = Math.min(m, d[i - w + 1] + 4);
        }
        d[i] = m;
      }
    }
    for (let y = h - 1; y >= 0; y--) {
      for (let x = w - 1; x >= 0; x--) {
        const i = y * w + x;
        if (!d[i]) continue;
        let m = x === w - 1 || y === h - 1 ? Math.min(d[i], 3) : d[i];
        if (x < w - 1) m = Math.min(m, d[i + 1] + 3);
        if (y < h - 1) {
          m = Math.min(m, d[i + w] + 3);
          if (x < w - 1) m = Math.min(m, d[i + w + 1] + 4);
          if (x > 0) m = Math.min(m, d[i + w - 1] + 4);
        }
        d[i] = m;
      }
    }
    return d;
  }

  // Ścienianie Zhanga-Suena: z każdej linii zostaje szkielet o grubości 1 piksela.
  function thin(line, w, h, maxIter) {
    const img = new Uint8Array(line);
    let list = [];
    for (let i = 0; i < img.length; i++) if (img[i]) list.push(i);
    for (let iter = 0; iter < maxIter; iter++) {
      let changed = false;
      for (let step = 0; step < 2; step++) {
        const del = [];
        for (let k = 0; k < list.length; k++) {
          const i = list[k];
          if (!img[i]) continue;
          const p2 = img[i - w], p3 = img[i - w + 1], p4 = img[i + 1], p5 = img[i + w + 1];
          const p6 = img[i + w], p7 = img[i + w - 1], p8 = img[i - 1], p9 = img[i - w - 1];
          const B = p2 + p3 + p4 + p5 + p6 + p7 + p8 + p9;
          if (B < 2 || B > 6) continue;
          const A = (!p2 && p3) + (!p3 && p4) + (!p4 && p5) + (!p5 && p6) + (!p6 && p7) + (!p7 && p8) + (!p8 && p9) + (!p9 && p2);
          if (A !== 1) continue;
          if (step === 0 ? (p2 && p4 && p6) || (p4 && p6 && p8) : (p2 && p4 && p8) || (p2 && p6 && p8)) continue;
          del.push(i);
        }
        for (let k = 0; k < del.length; k++) img[del[k]] = 0;
        if (del.length) changed = true;
      }
      if (!changed) break;
      list = list.filter((i) => img[i]);
    }
    return img;
  }

  const NB = (w) => [-w, -w + 1, 1, w + 1, w, w - 1, -1, -w - 1]; // 8 sąsiadów zgodnie z ruchem wskazówek zegara

  // Grupowanie punktów leżących blisko siebie (siatka z komórką = promień).
  function nearPairs(pts, w, radius, cb) {
    const cell = Math.max(1, Math.ceil(radius)), grid = new Map();
    pts.forEach((p, idx) => {
      const key = ((p / w / cell) | 0) * 100000 + ((p % w / cell) | 0);
      if (!grid.has(key)) grid.set(key, []);
      grid.get(key).push(idx);
    });
    pts.forEach((p, idx) => {
      const cx = (p % w / cell) | 0, cy = (p / w / cell) | 0, x = p % w, y = (p / w) | 0;
      for (let gy = cy - 1; gy <= cy + 1; gy++) {
        for (let gx = cx - 1; gx <= cx + 1; gx++) {
          const list = grid.get(gy * 100000 + gx);
          if (!list) continue;
          for (const j of list) {
            if (j <= idx) continue;
            const q = pts[j];
            if (Math.hypot(q % w - x, ((q / w) | 0) - y) <= radius) cb(idx, j);
          }
        }
      }
    });
  }

  // dark: maska ciemnych pikseli. Zwraca etykietę dla każdego piksela: NONE (nie linia albo nie wiadomo),
  // NEUTRAL (linia bez wpływu na bieg), PATH, FENCE (przeszkoda do przejścia), WALL (nie do przejścia).
  function classifyLines(dark, w, h, sprint) {
    const n = w * h, nb = NB(w);
    // połówka grubości (w pikselach), powyżej której ciemny kształt to plama (budynek), a nie linia.
    // Skaluje się z siatką, bo na mapach w powiększeniu (1:7 500) droga ma ponad pół milimetra.
    const DMAX = Math.max(6, Math.round(Math.max(w, h) / 250));
    const dt = distance(dark, w, h);

    // 1. linie = ciemne piksele poza grubymi plamami (budynki, duże napisy) i poza samym brzegiem obrazu
    const line = new Uint8Array(n);
    {
      const R = DMAX + 1, W1 = w + 1, I = new Uint32Array(W1 * (h + 1));
      for (let y = 0; y < h; y++) {
        let row = 0;
        for (let x = 0; x < w; x++) { row += dt[y * w + x] > DMAX * 3 ? 1 : 0; I[(y + 1) * W1 + x + 1] = I[y * W1 + x + 1] + row; }
      }
      for (let y = 1; y < h - 1; y++) {
        for (let x = 1; x < w - 1; x++) {
          const i = y * w + x;
          if (!dark[i]) continue;
          const x0 = Math.max(0, x - R), y0 = Math.max(0, y - R), x1 = Math.min(w, x + R + 1), y1 = Math.min(h, y + R + 1);
          if (I[y1 * W1 + x1] - I[y0 * W1 + x1] - I[y1 * W1 + x0] + I[y0 * W1 + x0] === 0) line[i] = 1;
        }
      }
    }

    // 2. szkielet i jego topologia: A = liczba "odnóg" wychodzących z piksela (1 koniec, 2 środek, 3+ rozwidlenie)
    const skel = thin(line, w, h, DMAX + 3);
    const A = new Uint8Array(n);
    const sk = [];
    for (let i = 0; i < n; i++) {
      if (!skel[i]) continue;
      let a = 0, b = 0;
      for (let k = 0; k < 8; k++) { const p = skel[i + nb[k]], q = skel[i + nb[(k + 1) % 8]]; b += p; if (!p && q) a++; }
      A[i] = b === 1 ? 1 : Math.max(a, b === 0 ? 0 : 1);
      sk.push(i);
    }
    if (!sk.length) return new Uint8Array(n);
    const stroke = (i) => 2 * dt[i] / 3 - 0.5;

    // typowa grubość linii na tej mapie (mediana po szkielecie)
    const sorted = sk.map(stroke).sort((p, q) => p - q);
    const tref = Math.max(1.5, sorted[sorted.length >> 1]);

    // 3. składowe szkieletu: długość, czy mają rozwidlenia, ile końców
    const comp = new Int32Array(n).fill(-1), comps = [];
    for (const s0 of sk) {
      if (comp[s0] >= 0) continue;
      const id = comps.length, c = { len: 0, junction: false, ends: 0 }, stack = [s0];
      comp[s0] = id;
      while (stack.length) {
        const i = stack.pop();
        c.len++;
        if (A[i] >= 3) c.junction = true;
        if (A[i] === 1) c.ends++;
        for (let k = 0; k < 8; k++) { const j = i + nb[k]; if (skel[j] && comp[j] < 0) { comp[j] = id; stack.push(j); } }
      }
      comps.push(c);
    }
    const LONG = 25 * tref; // dłuższe składowe to linie, krótsze to kreski ścieżek albo symbole
    // "kreska": prosty odcinek bez rozwidleń. Kreski stojące w rzędzie (koniec blisko końca innej) to linia
    // przerywana, czyli ścieżka albo droga gruntowa. Samotna gruba kreska to zwykle skałka.
    const isBar = (c) => !c.junction && c.ends === 2 && c.len >= Math.max(3, 2 * tref) && c.len < 80 * tref;
    {
      const ends = sk.filter((i) => A[i] === 1 && isBar(comps[comp[i]]));
      // linia przerywana ma co najmniej trzy kreski: środkowa ma sąsiada z obu stron. Dwa kawałki obok siebie
      // to zwykle jedna linia przecięta nadrukiem albo inną linią, a nie ścieżka.
      const link = (p, q) => { const c = comps[p]; (c.nbrs || (c.nbrs = new Set())).add(q); };
      nearPairs(ends, w, 8 * tref, (p, q) => {
        const cp = comp[ends[p]], cq = comp[ends[q]];
        if (cp !== cq) { link(cp, cq); link(cq, cp); }
      });
      for (const c of comps) c.inner = !!c.nbrs && c.nbrs.size >= 2;
      for (const c of comps) c.chained = c.inner || (!!c.nbrs && [...c.nbrs].some((q) => comps[q].inner));
    }

    // 4. kreseczki: krótkie odnogi od końca szkieletu do najbliższego rozwidlenia
    const spur = new Uint8Array(n), isBase = new Uint8Array(n);
    const Lmax = Math.max(4, Math.round(4.5 * tref)), Lmin = Math.max(2, Math.round(1.2 * tref));
    // kreseczka płotu jest cienka. Gruba odnoga to koniec kreski ścieżki, która dotknęła innej linii.
    const dts = [];
    for (const i of sk) if (comps[comp[i]].len >= LONG) dts.push(dt[i]);
    dts.sort((p, q) => p - q);
    const thinDt = dts.length ? dts[(dts.length * 0.1) | 0] : 3;
    const tickMaxDt = Math.max(thinDt * 1.35, thinDt + 1.5);
    const ticks = [];
    for (const e of sk) {
      if (A[e] !== 1 || comps[comp[e]].len < LONG) continue;
      const path = [e], seen = new Set([e]);
      let cur = e, base = -1;
      for (let s = 0; s < Lmax; s++) {
        let next = -1;
        for (const k of [0, 2, 4, 6, 1, 3, 5, 7]) { const j = cur + nb[k]; if (skel[j] && !seen.has(j)) { next = j; break; } }
        if (next < 0) break;
        if (A[next] >= 3) { base = next; break; }
        path.push(next); seen.add(next); cur = next;
      }
      if (base < 0 || path.length < Lmin) continue;
      const mid = path.slice(0, Math.max(1, path.length - 2)).map((p) => dt[p]).sort((p, q) => p - q);
      if (mid[mid.length >> 1] <= tickMaxDt) ticks.push({ base, path });
    }
    for (const t of ticks) for (const p of t.path) spur[p] = 1;
    // dwie odnogi z tego samego miejsca = poprzeczka przecinająca linię (słup, tory), nie płot
    const crossbar = new Uint8Array(ticks.length);
    nearPairs(ticks.map((t) => t.base), w, Math.max(2, tref), (i, j) => { crossbar[i] = crossbar[j] = 1; });
    const marks = [];
    ticks.forEach((t, idx) => { if (!crossbar[idx]) marks.push({ p: t.base, double: false }); });

    // 5. kropki na linii (mury): miejsca wyraźnie grubsze niż linia w okolicy
    const cell = Math.max(4, Math.round(6 * tref)), gw = Math.ceil(w / cell), gh = Math.ceil(h / cell);
    const gs = new Float32Array(gw * gh), gc = new Float32Array(gw * gh);
    for (const i of sk) {
      if (spur[i] || comps[comp[i]].len < LONG) continue;
      const g = ((i / w / cell) | 0) * gw + ((i % w / cell) | 0);
      gs[g] += dt[i]; gc[g]++;
    }
    const localDt = (i) => {
      const cx = (i % w / cell) | 0, cy = (i / w / cell) | 0;
      let s = 0, c = 0;
      for (let y = Math.max(0, cy - 1); y <= Math.min(gh - 1, cy + 1); y++) {
        for (let x = Math.max(0, cx - 1); x <= Math.min(gw - 1, cx + 1); x++) { s += gs[y * gw + x]; c += gc[y * gw + x]; }
      }
      return c ? s / c : dt[i];
    };
    {
      const flag = new Uint8Array(n);
      for (const i of sk) {
        if (A[i] !== 2 || spur[i] || comps[comp[i]].len < LONG) continue;
        const base = localDt(i);
        // kropki są na cienkich liniach murów; zgrubienie grubej linii to zwykle skrzyżowanie ścieżek
        if (base <= tickMaxDt && dt[i] >= Math.max(1.45 * base, base + 2.5)) flag[i] = 1;
      }
      for (const s0 of sk) {
        if (flag[s0] !== 1) continue;
        const group = [s0], stack = [s0];
        flag[s0] = 2;
        while (stack.length) {
          const i = stack.pop();
          for (let k = 0; k < 8; k++) { const j = i + nb[k]; if (flag[j] === 1) { flag[j] = 2; group.push(j); stack.push(j); } }
        }
        if (group.length <= 4 * tref) marks.push({ p: group[group.length >> 1], double: false });
      }
    }
    // znaczki parami blisko siebie = podwójne (wysoki płot, wysoki mur)
    nearPairs(marks.map((m) => m.p), w, 6 * tref, (i, j) => { marks[i].double = marks[j].double = true; });
    for (const m of marks) {
      const x = m.p % w, y = (m.p / w) | 0;
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
        const j = (y + dy) * w + x + dx;
        if (x + dx > 0 && x + dx < w - 1 && y + dy > 0 && y + dy < h - 1 && skel[j] && A[j] >= 3) isBase[j] = 1;
      }
    }

    // 6. każdy znaczek "zaraża" swoją linię na pewną odległość wzdłuż szkieletu; fragment linii zarażony
    //    przez co najmniej trzy znaczki jest przeszkodą (dwa zdarzają się przypadkiem przy skrzyżowaniach). Przez obce rozwidlenia (np. krzyżującą ścieżkę) nie przechodzimy.
    const reach = new Uint8Array(n), dbl = new Uint8Array(n);
    const R = Math.min(500, Math.round(40 * tref));
    for (const m of marks) {
      const seen = new Set([m.p]);
      let frontier = [m.p];
      for (let d = 0; d <= R && frontier.length; d++) {
        const next = [];
        for (const i of frontier) {
          if (reach[i] < 250) reach[i]++;
          if (m.double && dbl[i] < 250) dbl[i]++;
          if (A[i] >= 3 && !isBase[i] && i !== m.p) continue;
          for (let k = 0; k < 8; k++) { const j = i + nb[k]; if (skel[j] && !spur[j] && !seen.has(j)) { seen.add(j); next.push(j); } }
        }
        frontier = next;
      }
    }

    // 7. "cienkie" i "grube" linie na tej mapie
    const widths = [];
    for (const i of sk) if (!spur[i] && comps[comp[i]].len >= LONG) widths.push(2 * localDt(i) / 3 - 0.5);
    widths.sort((p, q) => p - q);
    const t10 = widths.length ? widths[(widths.length * 0.1) | 0] : tref, t90 = widths.length ? widths[(widths.length * 0.9) | 0] : tref;
    const bimodal = widths.length > 200 && t90 >= 1.6 * t10;
    const thickFrom = Math.sqrt(t10 * t90);

    // skały: linia wyraźnie grubsza niż drogi na tej mapie (i bez kreseczek) to skała nie do przejścia.
    // Oceniamy całą składową naraz, żeby zgrubienia na skrzyżowaniach dróg nie udawały skał.
    const roads = widths.filter((t) => t >= thickFrom);
    const tRoad = roads.length ? roads[roads.length >> 1] : Infinity;
    for (const c of comps) { c.sum = 0; c.cnt = 0; }
    for (const i of sk) if (!spur[i]) { const c = comps[comp[i]]; c.sum += 2 * dt[i] / 3 - 0.5; c.cnt++; }

    // 8. etykiety szkieletu
    const lab = new Uint8Array(n);
    for (const i of sk) {
      if (spur[i]) continue;
      const c = comps[comp[i]];
      const bar = isBar(c);
      if (c.len < LONG && !bar) continue; // symbol albo litera: zostawiamy reszcie analizy
      if (bar && c.chained) { lab[i] = sprint ? NEUTRAL : PATH; continue; }
      if (!sprint && bimodal && c.cnt && c.sum / c.cnt >= 1.35 * tRoad) { lab[i] = WALL; continue; }
      if (bar && reach[i] < 3) {
        // samotna kreska: gruba = skałka / murek (nie do przejścia), cienka = bez znaczenia
        // (dłuższy odcinek albo kawałek z sąsiadem to raczej droga przecięta inną linią niż skała)
        const rock = sprint || (c.len < 30 * tref && !c.nbrs);
        lab[i] = bimodal ? (2 * dt[i] / 3 - 0.5 >= thickFrom ? (rock ? WALL : PATH) : NEUTRAL) : (sprint ? WALL : PATH);
        continue;
      }
      const thick = 2 * localDt(i) / 3 - 0.5 >= thickFrom;
      if (reach[i] >= 3) lab[i] = dbl[i] >= 2 || (bimodal ? thick : sprint) ? WALL : FENCE;
      else if (sprint) lab[i] = !bimodal || thick ? WALL : NEUTRAL;
      else lab[i] = !bimodal || thick ? PATH : NEUTRAL;
    }
    for (const t of ticks) { const l = lab[t.base] || NEUTRAL; for (const p of t.path) lab[p] = l; }

    // 9. etykieta szkieletu rozlewa się na całą grubość linii
    const queue = [];
    for (const i of sk) if (lab[i]) queue.push(i);
    for (let head = 0; head < queue.length; head++) {
      const i = queue[head];
      for (let k = 0; k < 8; k++) { const j = i + nb[k]; if (line[j] && !lab[j]) { lab[j] = lab[i]; queue.push(j); } }
    }
    return lab;
  }

  // Zmniejszenie etykiet do siatki, na której liczona jest trasa. Wygrywa ważniejsza etykieta:
  // mur > płot > ścieżka > linia bez znaczenia.
  function pool(lab, w, h, lw, lh) {
    const out = new Uint8Array(lw * lh);
    for (let y = 0; y < h; y++) {
      const ly = Math.min(lh - 1, (y * lh / h) | 0) * lw;
      for (let x = 0; x < w; x++) {
        const l = lab[y * w + x];
        if (!l) continue;
        const o = ly + Math.min(lw - 1, (x * lw / w) | 0);
        if (l > out[o]) out[o] = l;
      }
    }
    return out;
  }

  const api = { NONE, NEUTRAL, PATH, FENCE, WALL, darkMask, classifyLines, pool };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.BnoLines = api;
})(typeof self !== 'undefined' ? self : this);

// Georeferencja pliku OCAD (współrzędne mapy -> GPS) i dopasowanie obrazu z PDF-a do mapy z OCAD-a.
// Działa w przeglądarce (globalny BnoAlign) i w Node (module.exports).
(function (root) {
  'use strict';
  const RAD = Math.PI / 180;

  // ---- odwzorowanie poprzeczne Mercatora (elipsoida GRS80), szeregi Krügera ----
  const A_ = 6378137, F_ = 1 / 298.257222101, N_ = F_ / (2 - F_);
  const RECT = A_ / (1 + N_) * (1 + N_ * N_ / 4 + N_ ** 4 / 64);

  function tmForward(lat, lon, c) {
    const a1 = N_ / 2 - 2 * N_ * N_ / 3 + 5 * N_ ** 3 / 16, a2 = 13 * N_ * N_ / 48 - 3 * N_ ** 3 / 5, a3 = 61 * N_ ** 3 / 240;
    const e = Math.sqrt(F_ * (2 - F_)), s = Math.sin(lat * RAD);
    const t = Math.sinh(Math.atanh(s) - e * Math.atanh(e * s));
    const dl = (lon - c.lon0) * RAD;
    const xi = Math.atan2(t, Math.cos(dl)), eta = Math.atanh(Math.sin(dl) / Math.sqrt(1 + t * t));
    const x = xi + a1 * Math.sin(2 * xi) * Math.cosh(2 * eta) + a2 * Math.sin(4 * xi) * Math.cosh(4 * eta) + a3 * Math.sin(6 * xi) * Math.cosh(6 * eta);
    const y = eta + a1 * Math.cos(2 * xi) * Math.sinh(2 * eta) + a2 * Math.cos(4 * xi) * Math.sinh(4 * eta) + a3 * Math.cos(6 * xi) * Math.sinh(6 * eta);
    return { e: c.fe + c.k0 * RECT * y, n: c.fn + c.k0 * RECT * x };
  }

  function tmInverse(E, N, c) {
    const b1 = N_ / 2 - 2 * N_ * N_ / 3 + 37 * N_ ** 3 / 96, b2 = N_ * N_ / 48 + N_ ** 3 / 15, b3 = 17 * N_ ** 3 / 480;
    const d1 = 2 * N_ - 2 * N_ * N_ / 3 - 2 * N_ ** 3, d2 = 7 * N_ * N_ / 3 - 8 * N_ ** 3 / 5, d3 = 56 * N_ ** 3 / 15;
    const xi = (N - c.fn) / (c.k0 * RECT), eta = (E - c.fe) / (c.k0 * RECT);
    const x = xi - b1 * Math.sin(2 * xi) * Math.cosh(2 * eta) - b2 * Math.sin(4 * xi) * Math.cosh(4 * eta) - b3 * Math.sin(6 * xi) * Math.cosh(6 * eta);
    const y = eta - b1 * Math.cos(2 * xi) * Math.sinh(2 * eta) - b2 * Math.cos(4 * xi) * Math.sinh(4 * eta) - b3 * Math.cos(6 * xi) * Math.sinh(6 * eta);
    const chi = Math.asin(Math.sin(x) / Math.cosh(y));
    return {
      lat: (chi + d1 * Math.sin(2 * chi) + d2 * Math.sin(4 * chi) + d3 * Math.sin(6 * chi)) / RAD,
      lon: c.lon0 + Math.atan2(Math.sinh(y), Math.cos(x)) / RAD,
    };
  }

  // Układ współrzędnych rozpoznawany po zakresie liczb (układy używane w Polsce) albo null.
  function detectCrs(geo) {
    const E = geo.x, N = geo.y;
    if (!geo.realWorld && !E && !N) return null;
    if (E >= 5e6 && E < 9e6 && N > 5.2e6 && N < 6.2e6) {
      const zone = Math.floor(E / 1e6);
      return { name: 'PUWG 2000, strefa ' + zone, lon0: zone * 3, k0: 0.999923, fe: zone * 1e6 + 5e5, fn: 0 };
    }
    if (E > 1e5 && E < 9e5 && N > 1e5 && N < 9e5) return { name: 'PUWG 1992', lon0: 19, k0: 0.9993, fe: 5e5, fn: -5300000 };
    if (E > 1e5 && E < 9e5 && N > 5.2e6 && N < 6.2e6) {
      const hint = Math.round(geo.grid) % 100, zone = hint >= 32 && hint <= 35 ? hint : 34;
      return { name: 'UTM, strefa ' + zone + 'N' + (hint === zone ? '' : ' (strefa przyjęta domyślnie)'), lon0: zone * 6 - 183, k0: 0.9996, fe: 5e5, fn: 0, guessed: hint !== zone };
    }
    return null;
  }

  // Punkt mapy (milimetry na papierze OCAD-a) -> { lat, lon }. geo: dane z BnoOcad.parse, crs: z detectCrs.
  // Kąt: mapa obrócona względem siatki o geo.angle stopni zgodnie z ruchem wskazówek zegara (góra papieru = północ + kąt).
  function ocadToLatLon(geo, crs, xmm, ymm) {
    const a = geo.angle * RAD, s = geo.scale / 1000;
    const E = geo.x + (xmm * Math.cos(a) + ymm * Math.sin(a)) * s;
    const N = geo.y + (-xmm * Math.sin(a) + ymm * Math.cos(a)) * s;
    return tmInverse(E, N, crs);
  }

  // ---- dopasowanie obrazu (PDF) do mapy OCAD ----
  // Oba obrazy sprowadzamy do "kategorii" (budynek, zakazane, woda, utwardzone, otwarte, zieleń; 0 = nic) i szukamy
  // przesunięcia, przy którym kategorie zgadzają się w największej liczbie pól.

  // Przeskalowanie siatki kategorii do pól o boku cell (w mm mapy OCAD). mm: ile mm mapy ma jedno pole źródła.
  function resample(cat, w, h, mm, cell) {
    const nw = Math.max(1, Math.round(w * mm / cell)), nh = Math.max(1, Math.round(h * mm / cell));
    const out = new Uint8Array(nw * nh);
    for (let y = 0; y < nh; y++) {
      const sy = Math.min(h - 1, Math.floor((y + 0.5) * cell / mm)) * w;
      for (let x = 0; x < nw; x++) out[y * nw + x] = cat[sy + Math.min(w - 1, Math.floor((x + 0.5) * cell / mm))];
    }
    return { cat: out, w: nw, h: nh };
  }

  // Najlepsze przesunięcie małej siatki P po dużej O w zakresie [x0..x1] x [y0..y1] (w polach). Zwraca { dx, dy, score }.
  function bestOffset(P, O, x0, x1, y0, y1) {
    const list = []; // tylko pola P z kategorią: to one głosują
    for (let i = 0; i < P.cat.length; i++) if (P.cat[i]) list.push(i % P.w, (i / P.w) | 0, P.cat[i]);
    let best = { dx: 0, dy: 0, score: -Infinity };
    if (!list.length) return best;
    for (let dy = y0; dy <= y1; dy++) {
      for (let dx = x0; dx <= x1; dx++) {
        let hit = 0, miss = 0;
        for (let k = 0; k < list.length; k += 3) {
          const ox = list[k] + dx, oy = list[k + 1] + dy;
          if (ox < 0 || oy < 0 || ox >= O.w || oy >= O.h) { miss++; continue; }
          const c = O.cat[oy * O.w + ox];
          if (c === list[k + 2]) hit++; else miss++;
        }
        const score = (hit - 0.5 * miss) / (list.length / 3);
        if (score > best.score) best = { dx, dy, score };
      }
    }
    return best;
  }

  // P: { cat, w, h, mm } obraz z PDF-a (mm = milimetry kartki na pole). O: { cat, w, h, mm } mapa OCAD (mm mapy na pole).
  // Zwraca { scale, x, y, score }: lewy górny róg obrazu leży (x, y) mm od lewego górnego rogu siatki O,
  // a 1 mm kartki PDF to scale mm mapy OCAD (1 = wydruk w skali mapy).
  function align(P, O, scales) {
    scales = scales || [1, 0.8, 1.25, 0.75, 4 / 3, 2 / 3, 1.5, 0.5, 2];
    let best = null;
    for (const scale of scales) {
      const cell = Math.max(O.mm, Math.max(P.w * P.mm * scale, P.h * P.mm * scale) / 48); // ok. 48 pól na dłuższy bok obrazu
      const p = resample(P.cat, P.w, P.h, P.mm * scale, cell), o = resample(O.cat, O.w, O.h, O.mm, cell);
      if (p.w > o.w + 8 || p.h > o.h + 8) continue;
      const r = bestOffset(p, o, -4, o.w - p.w + 4, -4, o.h - p.h + 4);
      if (!best || r.score > best.score) best = { scale, x: r.dx * cell, y: r.dy * cell, score: r.score, cell };
    }
    if (!best) return null;
    // doprecyzowanie: coraz drobniejsze pola wokół znalezionego miejsca
    for (let cell = best.cell / 3; cell >= O.mm * 0.999; cell = Math.max(O.mm, cell / 3)) {
      const p = resample(P.cat, P.w, P.h, P.mm * best.scale, cell), o = resample(O.cat, O.w, O.h, O.mm, cell);
      const cx = Math.round(best.x / cell), cy = Math.round(best.y / cell);
      const r = bestOffset(p, o, cx - 4, cx + 4, cy - 4, cy + 4);
      best = { scale: best.scale, x: r.dx * cell, y: r.dy * cell, score: r.score, cell };
      if (cell <= O.mm * 1.001) break;
    }
    return best;
  }

  const api = { tmForward, tmInverse, detectCrs, ocadToLatLon, resample, bestOffset, align };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.BnoAlign = api;
})(typeof self !== 'undefined' ? self : this);

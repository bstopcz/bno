// Georeferencja zdjęcia mapy: dopasowanie GPS -> piksele z punktów kalibracji.
// Działa w przeglądarce (globalny BnoGeo) i w Node (module.exports).
(function (root) {
  'use strict';
  const R = 6371000;
  const RAD = Math.PI / 180;

  // Lokalne metry względem punktu odniesienia: x na wschód, y na POŁUDNIE (tak jak rosną piksele).
  function toLocal(ref, lat, lon) {
    return {
      x: (lon - ref.lon) * RAD * R * Math.cos(ref.lat * RAD),
      y: -(lat - ref.lat) * RAD * R,
    };
  }

  function distance(a, b) {
    const p = toLocal(a, b.lat, b.lon);
    return Math.hypot(p.x, p.y);
  }

  // pairs: [{lat, lon, px, py}], minimum 2. Zwraca przekształcenie przez podobieństwo
  // (skala + obrót + przesunięcie) dopasowane metodą najmniejszych kwadratów, albo null.
  function fit(pairs) {
    if (!pairs || pairs.length < 2) return null;
    const ref = { lat: pairs[0].lat, lon: pairs[0].lon };
    const z = pairs.map((p) => toLocal(ref, p.lat, p.lon));
    const n = pairs.length;
    let zx = 0, zy = 0, wx = 0, wy = 0;
    for (let i = 0; i < n; i++) { zx += z[i].x; zy += z[i].y; wx += pairs[i].px; wy += pairs[i].py; }
    zx /= n; zy /= n; wx /= n; wy /= n;
    let re = 0, im = 0, den = 0;
    for (let i = 0; i < n; i++) {
      const ax = z[i].x - zx, ay = z[i].y - zy, bx = pairs[i].px - wx, by = pairs[i].py - wy;
      re += ax * bx + ay * by;
      im += ax * by - ay * bx;
      den += ax * ax + ay * ay;
    }
    if (den < 25) return null; // punkty praktycznie w tym samym miejscu
    const ar = re / den, ai = im / den;
    const cal = { ref, ar, ai, tx: wx - (ar * zx - ai * zy), ty: wy - (ai * zx + ar * zy) };
    cal.pxPerM = Math.hypot(ar, ai);
    let spread = 0, err = 0;
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) spread = Math.max(spread, Math.hypot(z[i].x - z[j].x, z[i].y - z[j].y));
      const p = toPixel(cal, pairs[i].lat, pairs[i].lon);
      err += (p.x - pairs[i].px) ** 2 + (p.y - pairs[i].py) ** 2;
    }
    cal.spreadM = spread;
    cal.rmsM = Math.sqrt(err / n) / cal.pxPerM; // 0 przy dwóch punktach
    return cal;
  }

  function toPixel(cal, lat, lon) {
    const z = toLocal(cal.ref, lat, lon);
    return { x: cal.ar * z.x - cal.ai * z.y + cal.tx, y: cal.ai * z.x + cal.ar * z.y + cal.ty };
  }

  // Kierunek kompasu (stopnie zgodnie z zegarem od północy) -> wektor jednostkowy na obrazie.
  function headingVector(cal, deg) {
    const x = Math.sin(deg * RAD), y = -Math.cos(deg * RAD);
    return { x: (cal.ar * x - cal.ai * y) / cal.pxPerM, y: (cal.ai * x + cal.ar * y) / cal.pxPerM };
  }

  // Wektor na obrazie -> kierunek kompasu (stopnie zgodnie z zegarem od północy).
  function bearingOf(cal, vx, vy) {
    const x = cal.ar * vx + cal.ai * vy, y = -cal.ai * vx + cal.ar * vy; // obrót odwrotny: wschód, południe
    return (Math.atan2(x, -y) / RAD + 360) % 360;
  }

  // "52.2297, 21.0122", "52.2297 21.0122" albo "52,2297; 21,0122" -> {lat, lon} | null
  function parseLatLon(text) {
    let nums = String(text).match(/-?\d+(?:\.\d+)?/g) || [];
    if (nums.length === 4 && !String(text).includes('.')) nums = [nums[0] + '.' + nums[1], nums[2] + '.' + nums[3]];
    if (nums.length !== 2) return null;
    const lat = +nums[0], lon = +nums[1];
    if (!(Math.abs(lat) <= 90) || !(Math.abs(lon) <= 180)) return null;
    return { lat, lon };
  }

  const api = { toLocal, distance, fit, toPixel, headingVector, bearingOf, parseLatLon };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.BnoGeo = api;
})(typeof self !== 'undefined' ? self : this);

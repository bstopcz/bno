// Własny czytnik plików OCAD (.ocd), napisany na podstawie publicznego opisu formatu OCAD 12.
// Czyta: wersję, skalę i georeferencję, listę symboli (numer, typ, nazwa, grubość linii) oraz obiekty
// (numer symbolu + geometria w milimetrach na papierze). Plik jest przetwarzany lokalnie w przeglądarce.
// Działa w przeglądarce (globalny BnoOcad) i w Node (module.exports).
(function (root) {
  'use strict';

  const POINT = 1, LINE = 2, AREA = 3;

  function parse(buffer) {
    const d = new DataView(buffer), size = d.byteLength;
    if (size < 60 || d.getUint16(0, true) !== 0x0cad) throw new Error('To nie jest plik OCAD (brak znacznika formatu).');
    const version = d.getInt16(4, true);
    if (version < 9) throw new Error('Plik OCAD w wersji ' + version + ' jest za stary. Otwórz go w nowszym OCAD-zie i zapisz ponownie.');
    const modern = version >= 12; // układ nagłówków obiektów i symboli z OCAD 12 i nowszych (także 2018+)
    const u32 = (o) => d.getUint32(o, true), i32 = (o) => d.getInt32(o, true), i16 = (o) => d.getInt16(o, true);
    const inside = (o, len) => o > 0 && o + len <= size;

    // ---- symbole ----
    const symbols = new Map();
    const descOffset = 56, descLen = version >= 11 ? 128 : 32;
    const lineOffset = version >= 11 ? 796 : version === 10 ? 572 : 572; // początek pól linii (LineColor, LineWidth)
    for (let blk = u32(8), guard = 0; blk && inside(blk, 1028) && guard < 1000; blk = u32(blk), guard++) {
      for (let k = 0; k < 256; k++) {
        const pos = i32(blk + 4 + 4 * k);
        if (!inside(pos, 60)) continue;
        const num = i32(pos + 4), otp = d.getUint8(pos + 8), status = d.getUint8(pos + 11);
        let name = '';
        if (version >= 11) {
          for (let c = 0; c < descLen / 2; c++) { const ch = d.getUint16(pos + descOffset + 2 * c, true); if (!ch) break; name += String.fromCharCode(ch); }
        } else { // OCAD 9-10: napis w stylu Pascala (długość + znaki ANSI)
          const len = Math.min(31, d.getUint8(pos + descOffset));
          for (let c = 0; c < len; c++) name += String.fromCharCode(d.getUint8(pos + descOffset + 1 + c));
        }
        let lineWidth = 0;
        if (otp === LINE && inside(pos + lineOffset, 4)) {
          // grubość linii pojedynczej albo, dla symboli rysowanych podwójną linią (chodnik, droga), jej wypełnienia
          const lw = i16(pos + lineOffset + 2), dbl = inside(pos + lineOffset + 36, 2) ? i16(pos + lineOffset + 36) : 0;
          const best = Math.max(lw > 0 && lw < 1000 ? lw : 0, dbl > 0 && dbl < 1000 ? dbl : 0);
          if (best > 0) lineWidth = best / 100; // mm
        }
        symbols.set(num, { num, type: otp, name, hidden: (status & 15) === 2, lineWidth });
      }
    }

    // ---- parametry: skala i georeferencja (napis typu 1039) ----
    const geo = { scale: 0, x: 0, y: 0, angle: 0, grid: 0, realWorld: false };
    const utf8 = typeof TextDecoder !== 'undefined' ? new TextDecoder('utf-8') : null;
    for (let blk = u32(32), guard = 0; blk && inside(blk, 4 + 256 * 16) && guard < 1000; blk = u32(blk), guard++) {
      for (let k = 0; k < 256; k++) {
        const e = blk + 4 + 16 * k, pos = u32(e), len = i32(e + 4), type = i32(e + 8);
        if (type !== 1039 || !inside(pos, len) || len <= 0) continue;
        let bytes = new Uint8Array(buffer, pos, len);
        const zero = bytes.indexOf(0);
        if (zero >= 0) bytes = bytes.subarray(0, zero);
        const text = utf8 ? utf8.decode(bytes) : String.fromCharCode.apply(null, bytes);
        for (const part of text.split('\t').slice(1)) {
          const v = parseFloat(part.slice(1));
          if (part[0] === 'm') geo.scale = v;
          else if (part[0] === 'x') geo.x += v;
          else if (part[0] === 'y') geo.y += v;
          else if (part[0] === 'b') geo.x += v || 0;
          else if (part[0] === 'c') geo.y += v || 0;
          else if (part[0] === 'a') geo.angle = v;
          else if (part[0] === 'i') geo.grid = v;
          else if (part[0] === 'r') geo.realWorld = v === 1;
        }
      }
    }

    // ---- obiekty ----
    const headerSize = modern ? 56 : version === 9 ? 32 : 40, nItemOffset = modern ? 44 : 8;
    const objects = [];
    let skipped = 0;
    const bounds = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
    for (let blk = u32(12), guard = 0; blk && inside(blk, 4 + 256 * 40) && guard < 100000; blk = u32(blk), guard++) {
      for (let k = 0; k < 256; k++) {
        const e = blk + 4 + 40 * k, pos = i32(e + 16);
        if (!inside(pos, headerSize)) continue;
        const sym = i32(e + 24), type = d.getUint8(e + 28), status = d.getUint8(e + 30), view = d.getUint8(e + 31);
        if (status !== 1 || view !== 0 || sym <= 0 || (type !== POINT && type !== LINE && type !== AREA)) { skipped++; continue; }
        const n = u32(pos + nItemOffset);
        if (!n || n > 2000000 || !inside(pos + headerSize, n * 8)) { skipped++; continue; }
        const rings = readPoly(d, pos + headerSize, n, type === AREA, type === POINT);
        for (const r of rings) for (let i = 0; i < r.length; i += 2) {
          if (r[i] < bounds.x0) bounds.x0 = r[i]; if (r[i] > bounds.x1) bounds.x1 = r[i];
          if (r[i + 1] < bounds.y0) bounds.y0 = r[i + 1]; if (r[i + 1] > bounds.y1) bounds.y1 = r[i + 1];
        }
        objects.push({ sym, type, rings });
      }
    }
    if (!objects.length) throw new Error('W pliku OCAD nie znalazłem żadnych obiektów mapy.');
    return { version, tested: modern, symbols, objects, geo, bounds, skipped };
  }

  // Współrzędne obiektu: liczby 32-bitowe, górne 24 bity to pozycja w 0,01 mm, dolne 8 to flagi.
  // Zwraca listę pierścieni/odcinków jako płaskie tablice [x, y, x, y, ...] w milimetrach; krzywe Béziera
  // są zamieniane na łamane. Dla powierzchni kolejne pierścienie to dziury.
  // Obiekt punktowy ma jedną parę współrzędnych (reszta, jeśli jest, to kierunek obrotu symbolu).
  function readPoly(d, off, n, area, point) {
    const rings = [];
    let cur = [], px = 0, py = 0, ctrl = [];
    const flush = () => { if (cur.length >= (point ? 2 : 4)) rings.push(cur); cur = []; };
    for (let i = 0; i < n; i++) {
      const rx = d.getInt32(off + 8 * i, true), ry = d.getInt32(off + 8 * i + 4, true);
      const x = (rx >> 8) / 100, y = (ry >> 8) / 100, fx = rx & 255, fy = ry & 255;
      if (fx & 1 || fx & 2) { ctrl.push(x, y); continue; } // punkt kontrolny krzywej
      if (area && (fy & 2) && cur.length) flush();          // początek dziury
      if (ctrl.length === 4 && cur.length) {
        const [ax, ay, bx, by] = ctrl;
        const steps = Math.max(4, Math.min(24, Math.ceil((Math.hypot(ax - px, ay - py) + Math.hypot(bx - ax, by - ay) + Math.hypot(x - bx, y - by)) / 0.4)));
        for (let s = 1; s <= steps; s++) {
          const t = s / steps, u = 1 - t;
          cur.push(u * u * u * px + 3 * u * u * t * ax + 3 * u * t * t * bx + t * t * t * x,
            u * u * u * py + 3 * u * u * t * ay + 3 * u * t * t * by + t * t * t * y);
        }
      } else cur.push(x, y);
      ctrl = [];
      px = x; py = y;
    }
    flush();
    return rings;
  }

  const api = { parse, POINT, LINE, AREA };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.BnoOcad = api;
})(typeof self !== 'undefined' ? self : this);

(function () {
  'use strict';
  const { TERRAIN, POINT_NAMES, analyze: analyzeMap, costGrid, routeLeg } = BnoCore;
  const INK = { green: '#0a8a2a', black: '#000', brown: '#b4530a', blue: '#0b4fd6' };
  const MAX_DIM = BnoCore.GRID_DIM;
  const HI_DIM = 4000; // rozdzielczość do oceny kształtu czarnych linii
  const CONTOUR_RGB = [176, 84, 10]; // rozdzielczość robocza (dłuższy bok)

  const $ = (id) => document.getElementById(id);
  const canvas = $('map');
  const ctx = canvas.getContext('2d');

  let photo = null, pixels = null, classView = null, cost = null, contour = null;
  let srcImg = null, hiPixels = null; // oryginalny obraz i jego większa wersja do analizy linii
  let ocad = null; // wczytany plik OCAD: { map, name, grid }; wtedy teren bierzemy z symboli, nie z obrazu
  let natW = 0; // szerokość oryginalnego pliku w pikselach (do przeliczenia skali)
  let W = 0, H = 0, zoom = 1;
  let points = [], legs = [];
  let showClasses = false, busy = false;

  const status = (text) => { $('status').textContent = text; };
  const READY = 'Stuknij start, a potem kolejne punkty kontrolne.';

  function loadImage(url) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('Nie udało się wczytać tego pliku jako obrazu.'));
      img.src = url;
    });
  }

  // Rozpoznaje teren w wybranym trybie i przelicza już postawione przebiegi.
  function analyze() {
    if (ocad) { analyzeOcad(); return; }
    if (hiPixels === undefined) {
      hiPixels = null;
      const kh = Math.min(1, HI_DIM / Math.max(srcImg.naturalWidth, srcImg.naturalHeight));
      if (srcImg.naturalWidth * kh > W * 1.2) {
        const ch = document.createElement('canvas');
        ch.width = Math.round(srcImg.naturalWidth * kh); ch.height = Math.round(srcImg.naturalHeight * kh);
        const gh = ch.getContext('2d', { willReadFrequently: true });
        gh.drawImage(srcImg, 0, 0, ch.width, ch.height);
        hiPixels = { data: gh.getImageData(0, 0, ch.width, ch.height).data, w: ch.width, h: ch.height };
      }
    }
    const res = analyzeMap(pixels, W, H, $('mode').value, hiPixels);
    finish(res.cls, res.contour, res.features);
  }

  // Wspólne zakończenie analizy (z obrazu albo z pliku OCAD): koszty, widok "co widzę", przebiegi.
  function finish(cls, contourMask, features) {
    contour = contourMask;
    cost = costGrid(cls);
    const out = new ImageData(W, H);
    for (let i = 0; i < cls.length; i++) {
      const rgb = contour[i] ? CONTOUR_RGB : TERRAIN[cls[i]].rgb; // wykryte warstwice widać w "co widzę"
      out.data[i * 4] = rgb[0]; out.data[i * 4 + 1] = rgb[1]; out.data[i * 4 + 2] = rgb[2];
      out.data[i * 4 + 3] = 255;
    }
    const vctx = classView.getContext('2d');
    vctx.putImageData(out, 0, 0);
    drawFeatures(vctx, features);
    legs = [];
    showScale();
    for (let i = 1; i < points.length; i++) legs.push(routeLeg(cost, W, H, points[i - 1], points[i], climb()));
    draw(); renderInfo();
  }

  // Rozpoznane symbole punktowe rysujemy z powrotem na widoku "co widzę".
  function drawFeatures(g, features) {
    for (const pass of [['#fff', 4], [null, 2]]) {
      for (const f of features) {
        const r = Math.max(4, f.size / 2 + 1), x = f.x + 0.5, y = f.y + 0.5;
        g.strokeStyle = pass[0] || INK[f.color];
        g.fillStyle = pass[0] || INK[f.color];
        g.lineWidth = pass[1];
        g.beginPath();
        if (f.kind === 'x') {
          g.moveTo(x - r, y - r); g.lineTo(x + r, y + r);
          g.moveTo(x + r, y - r); g.lineTo(x - r, y + r);
          g.stroke();
        } else if (f.kind === 'ring') {
          g.arc(x, y, r, 0, Math.PI * 2); g.stroke();
        } else {
          g.arc(x, y, r * 0.7 + (pass[0] ? 1 : 0), 0, Math.PI * 2); g.fill();
        }
      }
    }
  }

  // DPI zapisane w pliku: JPEG (nagłówek JFIF) albo PNG (blok pHYs). null, gdy go nie ma.
  function readDpi(buf) {
    const d = new DataView(buf);
    try {
      if (d.getUint32(0) === 0x89504e47) {
        for (let o = 8; o + 12 <= d.byteLength;) {
          const len = d.getUint32(o), type = d.getUint32(o + 4);
          if (type === 0x70485973) return d.getUint8(o + 16) === 1 ? d.getUint32(o + 8) * 0.0254 : null;
          if (type === 0x49444154) break;
          o += 12 + len;
        }
      } else if (d.getUint16(0) === 0xffd8) {
        for (let o = 2; o + 4 <= d.byteLength && d.getUint8(o) === 0xff;) {
          const marker = d.getUint8(o + 1), len = d.getUint16(o + 2);
          if (marker === 0xe0 && d.getUint32(o + 4) === 0x4a464946) {
            const units = d.getUint8(o + 11), x = d.getUint16(o + 12);
            return units === 1 ? x : units === 2 ? x * 2.54 : null;
          }
          if (marker === 0xda) break;
          o += 2 + len;
        }
      }
    } catch (err) { /* ucięty plik */ }
    return null;
  }

  // Skala mapy + DPI pliku -> ile metrów terenu ma jeden piksel analizy.
  const num = (id) => parseFloat(String($(id).value).replace(',', '.'));
  const hasScale = () => !!ocad || (num('scale') > 0 && num('dpi') > 0 && W > 0);
  const metersPerPx = () => (ocad ? ocad.grid.mpp : num('scale') * 0.0254 / num('dpi') * natW / W);

  function showScale() {
    if (ocad) {
      $('scaleinfo').textContent = `Plik OCAD, zestaw symboli: ${ocad.grid.setName}, skala 1:${Math.round(ocad.grid.scale)}. `
        + `Jedno pole siatki to ${ocad.grid.mpp.toFixed(2).replace('.', ',')} m, mapa obejmuje ok. ${Math.round(ocad.grid.mpp * W / 10) * 10} × ${Math.round(ocad.grid.mpp * H / 10) * 10} m.`;
      return;
    }
    $('scaleinfo').textContent = hasScale()
      ? `Przy tej skali i DPI plik obejmuje ok. ${Math.round(metersPerPx() * W / 10) * 10} × ${Math.round(metersPerPx() * H / 10) * 10} m terenu. Jeśli to się nie zgadza z mapą, popraw DPI.`
      : '';
  }

  // Podejścia wpływają na trasę tylko, gdy znamy skalę: szerokość zdjęcia w metrach terenu.
  function climb() {
    const interval = parseFloat($('contour').value);
    if (!(interval > 0)) return null;
    // bez skali warstwice są tylko liczone (kara 0), ze skalą wpływają na wybór wariantu
    return { contour, perCrossing: hasScale() ? interval / 2 * BnoCore.CLIMB_FACTOR / metersPerPx() : 0 };
  }

  function runBusy(message, work) {
    busy = true;
    status(message);
    setTimeout(() => {
      try { work(); status(points.length ? 'Gotowe. Stuknij kolejny punkt albo cofnij ostatni.' : READY); }
      catch (err) { status('Błąd: ' + err.message); }
      busy = false;
    }, 20);
  }

  $('file').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file || busy) return;
    status('Wczytuję zdjęcie…');
    try {
      if (/\.ocd$/i.test(file.name)) {
        ocad = { map: BnoOcad.parse(await file.arrayBuffer()), name: file.name, grid: null };
        pixels = null; srcImg = null; points = [];
        photo = document.createElement('canvas'); classView = document.createElement('canvas');
        $('tools').hidden = false;
        for (const id of ['mode', 'scale', 'dpi']) $(id).closest('label').hidden = true; // przy OCAD-zie znamy to z pliku
        runBusy('Czytam plik OCAD…', () => {
          analyze();
          if (!ocad.map.tested) status('Uwaga: plik w wersji OCAD ' + ocad.map.version + ', której czytnik nie był testowany. Sprawdź wynik w „Pokaż co widzę”.');
        });
        return;
      }
      ocad = null; $('ocadsyms').hidden = true;
      for (const id of ['mode', 'scale', 'dpi']) $(id).closest('label').hidden = false;
      const opened = await BnoFile.open(file); // PDF jest tu zamieniany na obraz
      const dpi = opened.pdf ? opened.dpi : readDpi(await file.arrayBuffer());
      if (dpi >= 100 && dpi <= 1200) $('dpi').value = Math.round(dpi); // 72/96 to zwykle wartość domyślna, nie prawdziwa
      const img = await loadImage(opened.url);
      natW = img.naturalWidth;
      srcImg = img; hiPixels = undefined;
      const k = Math.min(1, MAX_DIM / Math.max(img.naturalWidth, img.naturalHeight));
      W = Math.round(img.naturalWidth * k);
      H = Math.round(img.naturalHeight * k);
      photo = document.createElement('canvas');
      photo.width = W; photo.height = H;
      const pctx = photo.getContext('2d', { willReadFrequently: true });
      pctx.drawImage(img, 0, 0, W, H);
      URL.revokeObjectURL(img.src);
      pixels = pctx.getImageData(0, 0, W, H).data;
      classView = document.createElement('canvas');
      classView.width = W; classView.height = H;
      canvas.width = W; canvas.height = H;
      points = [];
      $('tools').hidden = false;
      runBusy('Analizuję mapę…', analyze);
    } catch (err) {
      status(err.message);
    }
  });

  for (const id of ['mode', 'contour', 'scale', 'dpi']) {
    $(id).addEventListener('change', () => {
      if ((pixels || ocad) && !busy) runBusy('Analizuję mapę…', analyze);
    });
  }

  // ---------- plik OCAD: teren prosto z symboli ----------
  const SYM = BnoSymbols;
  const overrideKey = (grid) => 'bno-sym:' + grid.set;
  const loadOverrides = (setId) => { try { return JSON.parse(localStorage.getItem('bno-sym:' + setId)) || {}; } catch (err) { return {}; } };

  function analyzeOcad() {
    const setId = SYM.detectSet(ocad.map);
    const grid = SYM.build(ocad.map, MAX_DIM, loadOverrides(setId), setId);
    ocad.grid = grid;
    W = grid.w; H = grid.h;
    for (const c of [photo, classView, canvas]) { c.width = W; c.height = H; }
    finish(grid.cls, grid.contour, []);
    photo.getContext('2d').drawImage(classView, 0, 0); // przy pliku OCAD "zdjęciem" jest schemat terenu
    renderSymbols();
  }

  // Tabela symboli z pliku: co to za symbol, ile ma obiektów i jak został potraktowany. Admin może to zmienić.
  function renderSymbols() {
    const box = $('ocadsyms'), body = $('ocadsymrows');
    box.hidden = false;
    body.replaceChildren();
    const kinds = Object.keys(SYM.KIND_NAMES);
    let unknown = 0;
    for (const u of ocad.grid.used) {
      if (u.sym.type !== 2 && u.sym.type !== 3 && u.kind === 'ignore') continue; // symbole punktowe i tekst bez wpływu na bieg
      const tr = document.createElement('tr');
      if (u.kind === 'ignore') { tr.className = 'blocked'; unknown++; }
      const cell = (text) => { const td = document.createElement('td'); td.textContent = text; tr.append(td); return td; };
      cell(String(u.sym.num / 1000));
      cell(u.sym.name || '—').style.textAlign = 'left';
      cell(u.sym.type === 3 ? 'powierzchnia' : u.sym.type === 2 ? 'linia' : 'punkt');
      cell(String(u.count));
      const td = document.createElement('td'), sel = document.createElement('select');
      for (const k of kinds) { const o = document.createElement('option'); o.value = k; o.textContent = SYM.KIND_NAMES[k] + (k === u.auto ? ' (domyślnie)' : ''); sel.append(o); }
      sel.value = u.kind;
      sel.setAttribute('aria-label', 'Jak traktować symbol ' + u.sym.num / 1000);
      sel.addEventListener('change', () => {
        const all = loadOverrides(ocad.grid.set);
        if (sel.value === u.auto) delete all[u.sym.num]; else all[u.sym.num] = sel.value;
        try { localStorage.setItem(overrideKey(ocad.grid), JSON.stringify(all)); } catch (err) { /* zmiana zadziała do odświeżenia */ }
        if (!busy) runBusy('Przeliczam teren…', analyze);
      });
      td.append(sel); tr.append(td);
      body.append(tr);
    }
    $('ocadsymnote').textContent = `Symbole liniowe i powierzchniowe użyte na mapie: ${body.children.length}. Pomijanych (szare wiersze): ${unknown}. `
      + 'Zmiana w ostatniej kolumnie od razu przelicza teren i zapamiętuje się dla tego zestawu symboli.';
  }

  canvas.addEventListener('click', (e) => {
    if (!cost || busy) return;
    const rect = canvas.getBoundingClientRect();
    const x = Math.min(W - 1, Math.max(0, Math.round((e.clientX - rect.left) * W / rect.width)));
    const y = Math.min(H - 1, Math.max(0, Math.round((e.clientY - rect.top) * H / rect.height)));
    points.push({ x, y });
    draw();
    if (points.length < 2) { status('Teraz stuknij pierwszy punkt kontrolny.'); return; }
    runBusy('Liczę wariant…', () => {
      legs.push(routeLeg(cost, W, H, points[points.length - 2], points[points.length - 1], climb()));
      draw(); renderInfo();
    });
  });

  $('undo').addEventListener('click', () => {
    if (busy || !points.length) return;
    points.pop();
    legs.length = Math.max(0, points.length - 1);
    draw(); renderInfo();
  });
  $('clear').addEventListener('click', () => {
    if (busy) return;
    points = []; legs = [];
    draw(); renderInfo();
    status(READY);
  });
  $('toggle').addEventListener('click', () => {
    showClasses = !showClasses;
    $('toggle').textContent = showClasses ? 'Pokaż zdjęcie' : 'Pokaż co widzę';
    $('legend').hidden = !showClasses;
    draw();
  });
  const setZoom = (z) => {
    zoom = Math.min(4, Math.max(1, z));
    canvas.style.width = (zoom * 100) + '%';
  };
  $('zoomIn').addEventListener('click', () => setZoom(zoom * 1.5));
  $('zoomOut').addEventListener('click', () => setZoom(zoom / 1.5));

  const label = (i) => (i === 0 ? 'S' : String(i));

  function stroke(color, width, dash) {
    ctx.lineJoin = 'round'; ctx.lineCap = 'round';
    ctx.setLineDash(dash || []);
    ctx.strokeStyle = 'rgba(255,255,255,0.9)'; ctx.lineWidth = width + 3; ctx.stroke();
    ctx.strokeStyle = color; ctx.lineWidth = width; ctx.stroke();
    ctx.setLineDash([]);
  }

  function strokePath(path, color, width, dash) {
    ctx.beginPath();
    for (let k = 0; k < path.length; k++) {
      const x = path[k] % W + 0.5, y = ((path[k] / W) | 0) + 0.5;
      if (k) ctx.lineTo(x, y); else ctx.moveTo(x, y);
    }
    stroke(color, width, dash);
  }

  function draw() {
    if (!photo) return;
    ctx.drawImage(showClasses ? classView : photo, 0, 0);
    const lw = Math.max(2.5, W / 320);
    const dash = [lw * 3, lw * 2.5];
    legs.forEach((leg, i) => {
      if (leg.best) return;
      ctx.beginPath(); // brak przejścia: szara przerywana prosta
      ctx.moveTo(points[i].x, points[i].y); ctx.lineTo(points[i + 1].x, points[i + 1].y);
      stroke('#666', lw * 0.8, dash);
    });
    for (const leg of legs) if (leg.alt) strokePath(leg.alt.path, '#1565c0', lw * 0.8, dash);
    for (const leg of legs) if (leg.best) strokePath(leg.best.path, '#e53935', lw);
    const r = Math.max(9, W / 90);
    ctx.font = `bold ${Math.round(r * 1.4)}px sans-serif`;
    points.forEach((p, i) => {
      ctx.beginPath(); ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
      ctx.strokeStyle = '#fff'; ctx.lineWidth = lw + 2; ctx.stroke();
      ctx.strokeStyle = '#a000c8'; ctx.lineWidth = lw; ctx.stroke();
      ctx.lineWidth = 3; ctx.strokeStyle = '#fff'; ctx.fillStyle = '#a000c8';
      ctx.strokeText(label(i), p.x + r + 2, p.y - r);
      ctx.fillText(label(i), p.x + r + 2, p.y - r);
    });
  }

  function legText(leg) {
    if (!leg.best) {
      return 'brak przejścia – punkt jest odcięty terenem nie do przejścia. Włącz „Pokaż co widzę” i sprawdź, co blokuje.';
    }
    const extra = Math.round((leg.best.length / leg.straight.length - 1) * 100);
    let text;
    if (leg.straight.cost === Infinity) {
      text = `prosta przecina teren nie do przejścia; obejście (czerwone) jest o ${extra}% dłuższe od prostej.`;
    } else {
      const gain = Math.round((1 - leg.best.cost / leg.straight.cost) * 100);
      text = gain < 3
        ? 'biegnij praktycznie na wprost.'
        : `najlepszy wariant (czerwony) jest o ${extra}% dłuższy od prostej, ale ok. ${gain}% szybszy.`;
    }
    if (leg.best.crossings != null) {
      text += ` Przecina ${leg.best.crossings} warstwic` + (leg.straight.cost === Infinity ? '.' : ` (prosta: ${leg.straight.crossings}).`);
      if (!hasScale()) text += ' Podaj skalę i DPI, żeby podejścia wpływały na wybór wariantu.';
    }
    if (hasScale()) text += ` Długość ok. ${Math.round(leg.best.length * metersPerPx() / 10) * 10} m.`;
    if (leg.alt) {
      const slower = Math.round((leg.alt.cost / leg.best.cost - 1) * 100);
      text += ` Alternatywa (niebieska przerywana): ${slower}% wolniejsza.`;
    }
    return text;
  }

  function renderInfo() {
    const box = $('info');
    box.innerHTML = '';
    legs.forEach((leg, i) => {
      const p = document.createElement('p');
      const b = document.createElement('b');
      b.textContent = `${label(i)} → ${label(i + 1)}: `;
      p.append(b, legText(leg));
      box.append(p);
    });
  }

  TERRAIN.filter((t) => !t.internal).forEach((t) => {
    const item = document.createElement('span');
    const sw = document.createElement('i');
    sw.style.background = `rgb(${t.rgb.join(',')})`;
    item.append(sw, t.cost === Infinity ? `${t.name} – nie do przejścia` : `${t.name} ×${t.cost}`);
    $('legend').append(item);
  });
  {
    const item = document.createElement('span'), sw = document.createElement('i');
    sw.style.background = `rgb(${CONTOUR_RGB.join(',')})`;
    item.append(sw, 'warstwica');
    $('legend').append(item);
  }
  const GLYPH = { x: '×', ring: '○', dot: '●' };
  for (const color of Object.keys(POINT_NAMES)) {
    for (const kind of Object.keys(POINT_NAMES[color])) {
      const item = document.createElement('span');
      const g = document.createElement('b');
      g.textContent = GLYPH[kind] + ' ';
      g.style.color = INK[color];
      item.append(g, POINT_NAMES[color][kind]);
      $('legend').append(item);
    }
  }
})();

// Zakładka "Na żywo": pozycja z GPS na mapie, trasa do celu i strzałka na obrazie z kamery.
(function () {
  'use strict';
  const { fit, toPixel, headingVector, bearingOf, parseLatLon, distance } = BnoGeo;
  const { analyze, costGrid, routeLeg, CLIMB_FACTOR, GRID_DIM } = BnoCore;
  const $ = (id) => document.getElementById(id);
  const SVG = 'http://www.w3.org/2000/svg';
  const HI_DIM = 4000;     // rozdzielczość, w której oceniany jest kształt czarnych linii (płot czy ścieżka)
  const PROC_DIM = GRID_DIM;   // rozdzielczość, w której liczona jest trasa
  const TANGENT_M = 9;     // kierunek trasy liczony z tylu metrów linii przed Tobą
  const RETURN_M = 15;     // dalej od linii niż tyle metrów: strzałka prowadzi z powrotem na trasę
  const BACK_M = 20;       // tyle metrów wstecz od ostatniego miejsca na trasie jeszcze sprawdzamy
  const MAX_SPEED = 8;     // m/s: szybciej po trasie się nie przesuniesz (odrzuca skoki GPS)
  const RETURN_TRY_M = [9, 20, 35, 50, 70, 0, -15, -30]; // gdzie na trasie szukamy miejsca, do którego da się wrócić po prostej
  const LOST_FIXES = 3;    // tyle odczytów z rzędu daleko od oczekiwanego miejsca = szukamy na całej trasie
  const MINI_SPAN_M = 220; // tyle metrów terenu mieści się na szerokość minimapy w trybie kamery
  const CAM_HFOV = 55;     // przybliżony poziomy kąt widzenia kamery telefonu (pionowo)

  const stage = $('lstage'), world = $('lworld'), img = $('limg'), svg = $('lsvg'), video = $('lvideo');
  const el = {};
  for (const [name, tag] of [['track', 'polyline'], ['alt', 'polyline'], ['route', 'polyline'], ['cals', 'g'], ['target', 'circle'],
    ['draw', 'polyline'], ['acc', 'circle'], ['head', 'polygon'], ['dot', 'circle'], ['pend', 'circle']]) {
    el[name] = document.createElementNS(SVG, tag);
    el[name].setAttribute('class', 'l-' + name);
    svg.append(el[name]);
  }

  let W = 0, H = 0, mapKey = null, mapName = '';
  let mapImage = null;                  // adres obrazu wyrenderowanego z PDF-a (do pobrania przez admina)
  let locked = false;                   // mapa treningu: kalibracja jest gotowa i uczestnik jej nie zmienia
  let s = 1, ox = 0, oy = 0;           // ekran = mapa * s + (ox, oy)
  let vs = 1;                           // skala aktualnie widocznego widoku (mapa albo minimapa)
  let pairs = [], cal = null;           // punkty kalibracji i dopasowanie
  let fix = null, heading = null, pitch = null, watchId = null, wake = null;
  let track = [];                       // [{lat, lon}]
  let follow = true, tapMode = null, pending = null; // tapMode: null | 'cal' | 'target' | 'draw'
  let strokes = [];                     // kreski rysowanej ręcznie trasy (w pikselach mapy)
  let proc = null;                      // { k, w, h, cost } – teren do liczenia trasy
  let target = null, route = null, routes = [], routeAt = 0, routeNote = ''; // route = wybrany wariant
  let stream = null;

  const say = (text) => { $('lstatus').textContent = text; };

  // ---------- widok mapy ----------
  function applyView() {
    if (stream) {
      // tryb kamery: minimapa wyśrodkowana na Tobie i obrócona tak, żeby "góra" była tam, gdzie patrzysz
      const r = $('lmini').getBoundingClientRect(), pos = position();
      if (pos) {
        vs = r.width / (MINI_SPAN_M * cal.pxPerM);
        let ang = 0;
        if (heading != null) { const v = headingVector(cal, heading); ang = Math.atan2(v.x, -v.y); }
        world.style.transform = `translate(${r.width / 2}px, ${r.height * 0.62}px) rotate(${-ang}rad) scale(${vs}) translate(${-pos.x}px, ${-pos.y}px)`;
      } else {
        vs = Math.min(r.width / W, r.height / H);
        world.style.transform = `scale(${vs})`;
      }
    } else {
      vs = s;
      world.style.transform = `translate(${ox}px, ${oy}px) scale(${s})`;
    }
    drawMarkers();
  }

  function fitView() {
    const r = stage.getBoundingClientRect();
    s = Math.min(r.width / W, r.height / H);
    ox = (r.width - W * s) / 2; oy = (r.height - H * s) / 2;
    applyView();
  }

  function zoomAt(x, y, f) {
    const ns = Math.min(12, Math.max(0.02, s * f));
    f = ns / s;
    ox = x - (x - ox) * f; oy = y - (y - oy) * f; s = ns;
  }

  const position = () => (cal && fix ? toPixel(cal, fix.lat, fix.lon) : null);
  const fmt = (pts) => pts.map((p) => p.x.toFixed(1) + ',' + p.y.toFixed(1)).join(' ');

  function drawMarkers() {
    if (!W) return;
    const u = 1 / vs; // 1 piksel ekranu w jednostkach mapy
    el.cals.replaceChildren();
    pairs.forEach((p) => {
      const c = document.createElementNS(SVG, 'circle');
      c.setAttribute('cx', p.px); c.setAttribute('cy', p.py); c.setAttribute('r', 6 * u);
      c.setAttribute('stroke-width', 2 * u);
      el.cals.append(c);
    });
    el.pend.style.display = pending ? '' : 'none';
    if (pending) {
      el.pend.setAttribute('cx', pending.px); el.pend.setAttribute('cy', pending.py);
      el.pend.setAttribute('r', 9 * u); el.pend.setAttribute('stroke-width', 3 * u);
    }
    const sketch = tapMode === 'draw' ? strokes.flat() : [];
    el.draw.style.display = sketch.length > 1 ? '' : 'none';
    if (sketch.length > 1) { el.draw.setAttribute('points', fmt(sketch)); el.draw.setAttribute('stroke-width', 4 * u); }
    el.target.style.display = target ? '' : 'none';
    if (target) {
      el.target.setAttribute('cx', target.x); el.target.setAttribute('cy', target.y);
      el.target.setAttribute('r', 14 * u); el.target.setAttribute('stroke-width', 3.5 * u);
    }
    el.route.style.display = route ? '' : 'none';
    if (route) { el.route.setAttribute('points', fmt(route.pts)); el.route.setAttribute('stroke-width', 4 * u); }
    const other = routes.find((r) => r !== route);
    el.alt.style.display = other ? '' : 'none';
    if (other) {
      el.alt.setAttribute('points', fmt(other.pts)); el.alt.setAttribute('stroke-width', 3 * u);
      el.alt.setAttribute('stroke-dasharray', `${9 * u} ${7 * u}`);
    }

    const pos = position();
    for (const k of ['dot', 'acc', 'head', 'track']) el[k].style.display = pos ? '' : 'none';
    if (!pos) return;
    el.dot.setAttribute('cx', pos.x); el.dot.setAttribute('cy', pos.y);
    el.dot.setAttribute('r', 8 * u); el.dot.setAttribute('stroke-width', 3 * u);
    el.acc.setAttribute('cx', pos.x); el.acc.setAttribute('cy', pos.y);
    el.acc.setAttribute('r', Math.max(8 * u, fix.acc * cal.pxPerM));
    el.track.setAttribute('points', fmt(track.map((t) => toPixel(cal, t.lat, t.lon))));
    el.track.setAttribute('stroke-width', 2.5 * u);
    if (heading == null) { el.head.style.display = 'none'; return; }
    const v = headingVector(cal, heading), a = 12 * u, b = 30 * u, c = 9 * u;
    el.head.setAttribute('points', fmt([
      { x: pos.x + v.x * b, y: pos.y + v.y * b },
      { x: pos.x + v.x * a - v.y * c, y: pos.y + v.y * a + v.x * c },
      { x: pos.x + v.x * a + v.y * c, y: pos.y + v.y * a - v.x * c },
    ]));
  }

  function refresh() {
    const pos = position();
    if (follow && pos && W) {
      const r = stage.getBoundingClientRect();
      ox = r.width / 2 - pos.x * s; oy = r.height / 2 - pos.y * s;
    }
    maybeReroute();
    applyView();
    describe();
    renderVariants();
    guide();
  }

  function describe() {
    const gps = fix ? `GPS ±${Math.round(fix.acc)} m` : (watchId != null ? 'GPS: czekam na sygnał…' : 'GPS wyłączony');
    let c;
    if (!W) c = 'Wczytaj mapę.';
    else if (pairs.length === 0) c = 'Mapa bez kalibracji – dodaj 2 punkty.';
    else if (!cal) c = pairs.length === 1 ? 'Jest 1 punkt kalibracji – dodaj drugi, min. 100 m dalej.' : 'Punkty kalibracji są za blisko siebie.';
    else {
      c = `Kalibracja: ${pairs.length} pkt, rozstaw ${Math.round(cal.spreadM)} m`;
      if (pairs.length > 2) c += `, błąd ok. ${Math.round(cal.rmsM)} m`;
      if (cal.spreadM < 100) c += ' (punkty blisko siebie – pozycja może pływać)';
      const p = position();
      if (p && (p.x < 0 || p.y < 0 || p.x > W || p.y > H)) c += '. Jesteś poza mapą.';
    }
    if (fix && fix.acc > 100) c += ' Pozycja jest bardzo niedokładna – to wygląda na komputer bez GPS. Otwórz stronę na telefonie (instrukcja na dole).';
    say(gps + ' · ' + c + (ocadCtx && ocadCtx.note ? ' ' + ocadCtx.note : ''));
  }

  // ---------- mapa ----------
  $('lfile').addEventListener('change', (e) => {
    const files = [...e.target.files];
    const ocd = files.find((f) => /\.ocd$/i.test(f.name)), other = files.find((f) => !/\.ocd$/i.test(f.name));
    if (ocd && other) { openPair(ocd, other); return; } // plik OCAD + PDF tej samej mapy
    const file = files[0];
    if (!file) return;
    if (/\.ocd$/i.test(file.name)) {
      say('Do pliku OCAD dołącz PDF tej samej mapy: w oknie wyboru zaznacz oba pliki naraz (z klawiszem Ctrl). Sam plik OCAD obejrzysz w zakładce „Warianty”.');
      return;
    }
    if (false) {
      say('Plików OCAD jeszcze nie czytam. W OCAD wybierz Plik → Eksport → JPEG lub PNG (300 dpi) i wczytaj ten obraz.');
      return;
    }
    say(/\.pdf$/i.test(file.name) ? 'Zamieniam PDF na obraz…' : 'Wczytuję mapę…');
    BnoFile.open(file).then((f) => {
      // dla PDF-a zapamiętujemy gotowy obraz: to on (a nie PDF) trafia potem do folderu treningów
      loadMap(f.url, { key: 'bno-cal:' + file.name + ':' + file.size, name: f.name, image: f.pdf ? f.url : null });
    }).catch((err) => say(err.message));
  });

  // ---------- para: plik OCAD + PDF tej samej mapy ----------
  // Wyświetlamy PDF, a teren, skalę i położenie na świecie bierzemy z OCAD-a. PDF jest dopasowywany automatycznie.
  let ocadCtx = null; // { map, region (wycinek mapy OCAD pokrywający obraz, w mm), note }
  async function openPair(ocdFile, imgFile) {
    try {
      say('Czytam plik OCAD…');
      const map = BnoOcad.parse(await ocdFile.arrayBuffer());
      say('Zamieniam PDF na obraz…');
      const f = await BnoFile.open(imgFile);
      loadMap(f.url, { key: 'bno-pair:' + imgFile.name + ':' + imgFile.size, name: f.name, image: f.pdf ? f.url : null, ocad: { map, dpi: f.dpi } });
    } catch (err) { say(err.message); }
  }

  const T = BnoCore.T;
  const CAT = new Uint8Array(64); // klasa terenu -> kategoria do porównywania obrazu z mapą
  for (const [cat, list] of [[1, [T.BUILDING]], [2, [T.FORBIDDEN]], [3, [T.LAKE, T.WATER]], [4, [T.PAVED]], [5, [T.OPEN, T.ROUGH, T.CULT]],
    [6, [T.GREEN1, T.GREEN2, T.GREEN3, T.IMPVEG, T.UNDER1, T.UNDER2]]]) for (const c of list) CAT[c] = cat;
  const cats = (cls) => { const out = new Uint8Array(cls.length); for (let i = 0; i < cls.length; i++) out[i] = CAT[cls[i]]; return out; };
  const symOverrides = (setId) => { try { return JSON.parse(localStorage.getItem('bno-sym:' + setId)) || {}; } catch (err) { return {}; } };

  function attachOcad(o) {
    const { map } = o, sprint = map.geo.scale > 0 && map.geo.scale <= 5000;
    const setId = BnoSymbols.detectSet(map);
    // 1. kategorie terenu z obrazu (zwykła analiza kolorów, w małej rozdzielczości)
    const ak = Math.min(1, 1600 / Math.max(W, H)), aw = Math.round(W * ak), ah = Math.round(H * ak);
    const c = document.createElement('canvas'); c.width = aw; c.height = ah;
    const g = c.getContext('2d', { willReadFrequently: true }); g.drawImage(img, 0, 0, aw, ah);
    const seen = analyze(g.getImageData(0, 0, aw, ah).data, aw, ah, sprint ? 'sprint' : 'forest');
    const dpi = o.dpi || 300; // obraz bez zapisanej rozdzielczości: zakładamy 300 dpi, skalę wydruku i tak sprawdzamy
    const P = { cat: cats(seen.cls), w: aw, h: ah, mm: 25.4 / dpi / ak };
    // 2. zgrubne położenie obrazu na całej mapie OCAD
    const over = BnoSymbols.build(map, 2400, symOverrides(setId), setId);
    const a1 = BnoAlign.align(P, { cat: cats(over.cls), w: over.w, h: over.h, mm: 1 / over.k });
    if (!a1) throw new Error('Obraz jest większy niż mapa w pliku OCAD – to chyba nie ta sama mapa.');
    const mmImg = 25.4 / dpi * a1.scale; // ile mm mapy OCAD ma jeden piksel obrazu
    let left = over.bounds.x0 + a1.x, top = over.bounds.y1 - a1.y;
    // 3. dokładne położenie: mapa OCAD policzona gęsto tylko wokół obrazu
    const m = 4; // mm zapasu
    const fine = BnoSymbols.build(map, PROC_DIM, symOverrides(setId), setId, { x0: left - m, x1: left + W * mmImg + m, y0: top - H * mmImg - m, y1: top + m });
    const a2 = BnoAlign.align(P, { cat: cats(fine.cls), w: fine.w, h: fine.h, mm: 1 / fine.k }, [a1.scale]);
    if (a2 && a2.score >= a1.score - 0.05) { left = fine.bounds.x0 + a2.x; top = fine.bounds.y1 - a2.y; }
    const score = a2 ? Math.max(a1.score, a2.score) : a1.score;
    ocadCtx = { map, setId, region: { x0: left, x1: left + W * mmImg, y0: top - H * mmImg, y1: top } };
    proc = null;
    ensureProc();
    // 4. położenie na świecie z georeferencji pliku
    const crs = BnoAlign.detectCrs(map.geo);
    let note = `Mapa z pliku OCAD (${BnoSymbols.SETS[setId].name}, 1:${Math.round(map.geo.scale)}), PDF dopasowany: zgodność ${Math.round(Math.max(0, score) * 100)}%`;
    if (Math.abs(a1.scale - 1) > 0.01) note += `, wydruk w skali 1:${Math.round(map.geo.scale / a1.scale)}`;
    if (score < 0.35) note += '. UWAGA: słabe dopasowanie – sprawdź, czy PDF pochodzi z tego pliku';
    if (crs) {
      pairs = [[0, 0], [W, 0], [0, H], [W, H]].map(([px, py]) => Object.assign(BnoAlign.ocadToLatLon(map.geo, crs, left + px * mmImg, top - py * mmImg), { px, py }));
      cal = fit(pairs); locked = true;
      $('lcaladd').hidden = true; $('lcalclear').hidden = true;
      note += `. Kalibracja automatyczna z georeferencji (${crs.name})`;
      if (Math.abs(map.geo.angle) > 0.01) note += `; mapa obrócona o ${map.geo.angle.toFixed(1)}° – ten przypadek nie był sprawdzony w terenie`;
    } else note += '. Plik nie ma georeferencji w znanym układzie – skalibruj mapę ręcznie dwoma punktami';
    ocadCtx.note = note + '.';
    refresh();
  }

  // Wczytuje obraz mapy. opts: { key, name, title?, preset? (gotowa kalibracja treningu), mode?, contour?, ocad? }
  function loadMap(src, opts) {
    img.onload = () => {
      W = img.naturalWidth; H = img.naturalHeight;
      world.style.width = W + 'px'; world.style.height = H + 'px';
      svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
      svg.setAttribute('width', W); svg.setAttribute('height', H);
      mapKey = opts.key; mapName = opts.name; locked = !!opts.preset;
      mapImage = opts.image || null;
      ocadCtx = null;
      pairs = [];
      if (locked) pairs = opts.preset.map((p) => ({ lat: +p.lat, lon: +p.lon, px: +p.px, py: +p.py }));
      else try { pairs = JSON.parse(localStorage.getItem(mapKey)) || []; } catch (err) { /* brak pamięci – trudno */ }
      cal = fit(pairs); track = []; pending = null; proc = null; target = null; route = null; routes = []; routeNote = '';
      if (opts.mode) $('lmode').value = opts.mode;
      if (opts.contour != null) $('lcontour').value = String(opts.contour);
      $('ltools').hidden = false;
      $('lcaladd').hidden = locked; $('lcalclear').hidden = locked;
      $('ltitle').textContent = opts.title || '';
      setTapMode(null);
      fitView(); describe(); guide();
      if (opts.ocad) {
        say('Dopasowuję PDF do mapy z pliku OCAD… (to może potrwać kilkanaście sekund)');
        setTimeout(() => { try { attachOcad(opts.ocad); } catch (err) { say('Nie udało się połączyć PDF-a z plikiem OCAD: ' + err.message); } }, 80);
      }
    };
    img.onerror = () => say(opts.preset ? 'Nie udało się pobrać mapy treningu. Sprawdź połączenie z internetem.' : 'Nie udało się wczytać tego pliku jako obrazu.');
    img.src = src;
  }

  window.BnoLive = {
    openTraining(t) {
      say('Pobieram mapę treningu…');
      loadMap(t.plik, { key: 'trening:' + t.id, name: t.plik, title: t.nazwa, preset: t.kalibracja, mode: t.rodzaj, contour: t.ciecie });
    },
  };

  // Dla admina: dane skalibrowanej mapy w formacie wpisu do treningi/treningi.json.
  $('ladmin').addEventListener('click', () => {
    const out = $('ladminout');
    out.hidden = false;
    const link = $('ladminimg');
    link.hidden = !mapImage;
    if (mapImage) { link.href = mapImage; link.download = mapName; link.textContent = 'Pobierz obraz mapy (' + mapName + ')'; }
    if (!cal) { out.value = 'Najpierw wczytaj mapę i dodaj co najmniej 2 punkty kalibracji.'; return; }
    const r = (v, k) => Math.round(v * k) / k;
    out.value = JSON.stringify({
      id: mapName.replace(/\.[^.]+$/, '').toLowerCase().replace(/[^a-z0-9]+/g, '-'),
      nazwa: 'NAZWA TRENINGU',
      opis: 'Krótki opis: długość, trudność, do kiedy wiszą punkty.',
      miejsce: 'Gdzie to jest i jak dojechać: parking, przystanek, miejsce startu.',
      dojazd: { lat: r(pairs[0].lat, 1e5), lon: r(pairs[0].lon, 1e5) },
      plik: 'treningi/' + mapName,
      skala: 10000,
      rodzaj: $('lmode').value,
      ciecie: parseFloat($('lcontour').value),
      kalibracja: pairs.map((p) => ({ lat: r(p.lat, 1e6), lon: r(p.lon, 1e6), px: r(p.px, 10), py: r(p.py, 10) })),
    }, null, 2);
    out.select();
  });

  function savePairs() {
    cal = fit(pairs);
    if (locked) return;
    try { localStorage.setItem(mapKey, JSON.stringify(pairs)); } catch (err) { /* jw. */ }
  }

  // ---------- gesty: przesuwanie, szczypanie, stuknięcie ----------
  const ptrs = new Map();
  let moved = 0, downAt = 0;
  const local = (e) => { const r = stage.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };

  stage.addEventListener('pointerdown', (e) => {
    if (stream) return; // w trybie kamery mapy nie ruszamy
    try { stage.setPointerCapture(e.pointerId); } catch (err) { /* np. zdarzenie syntetyczne */ }
    ptrs.set(e.pointerId, local(e));
    if (ptrs.size === 1) { moved = 0; downAt = Date.now(); } else moved = 999;
    if (tapMode === 'draw' && ptrs.size === 1 && W) {
      const p = local(e);
      strokes.push([{ x: (p.x - ox) / s, y: (p.y - oy) / s }]);
    }
  });
  stage.addEventListener('pointermove', (e) => {
    if (!ptrs.has(e.pointerId) || !W) return;
    const prev = ptrs.get(e.pointerId), now = local(e);
    if (ptrs.size === 1 && tapMode === 'draw') {
      // jeden palec rysuje, dwa palce przesuwają i powiększają mapę
      const st = strokes[strokes.length - 1], q = { x: (now.x - ox) / s, y: (now.y - oy) / s };
      if (st && Math.hypot(q.x - st[st.length - 1].x, q.y - st[st.length - 1].y) * s > 4) st.push(q);
      moved += Math.abs(now.x - prev.x) + Math.abs(now.y - prev.y);
    } else if (ptrs.size === 1) {
      ox += now.x - prev.x; oy += now.y - prev.y;
      moved += Math.abs(now.x - prev.x) + Math.abs(now.y - prev.y);
    } else if (ptrs.size === 2) {
      let other;
      for (const [id, p] of ptrs) if (id !== e.pointerId) other = p;
      const d0 = Math.hypot(prev.x - other.x, prev.y - other.y), d1 = Math.hypot(now.x - other.x, now.y - other.y);
      const m0 = { x: (prev.x + other.x) / 2, y: (prev.y + other.y) / 2 }, m1 = { x: (now.x + other.x) / 2, y: (now.y + other.y) / 2 };
      ox += m1.x - m0.x; oy += m1.y - m0.y;
      if (d0 > 10) zoomAt(m1.x, m1.y, d1 / d0);
    }
    ptrs.set(e.pointerId, now);
    if (moved > 8 && follow) setFollow(false);
    applyView();
  });
  stage.addEventListener('pointerup', (e) => {
    if (!ptrs.has(e.pointerId)) return;
    const p = ptrs.get(e.pointerId);
    ptrs.delete(e.pointerId);
    if (tapMode === 'draw') { // kropka albo początek gestu dwoma palcami to nie kreska
      if (strokes.length && strokes[strokes.length - 1].length < 2) strokes.pop();
      drawMarkers();
      return;
    }
    if (ptrs.size === 0 && moved < 8 && Date.now() - downAt < 600 && W) tap((p.x - ox) / s, (p.y - oy) / s);
  });
  stage.addEventListener('pointercancel', (e) => ptrs.delete(e.pointerId));
  stage.addEventListener('wheel', (e) => {
    if (!W || stream) return;
    e.preventDefault();
    const p = local(e);
    zoomAt(p.x, p.y, e.deltaY < 0 ? 1.25 : 0.8);
    applyView();
  }, { passive: false });
  window.addEventListener('resize', () => { if (W) applyView(); });

  function tap(x, y) {
    if (!tapMode || tapMode === 'draw' || x < 0 || y < 0 || x > W || y > H) return;
    if (tapMode === 'target') {
      target = { x, y };
      setTapMode(null);
      computeRoute();
      return;
    }
    pending = { px: x, py: y };
    $('lcalpick').hidden = false;
    $('lhint').textContent = 'Skąd wziąć współrzędne tego punktu?';
    $('lcalgps').textContent = fix ? `Stoję tu teraz (GPS ±${Math.round(fix.acc)} m)` : 'Stoję tu teraz (najpierw włącz GPS)';
    $('lcalgps').disabled = !fix;
    drawMarkers();
  }

  function setTapMode(mode) {
    tapMode = mode; pending = null;
    $('lpanel').hidden = !mode;
    $('lcalpick').hidden = true;
    $('ldrawbtns').hidden = mode !== 'draw';
    if (mode === 'draw') { strokes = []; setFollow(false); }
    $('lhint').textContent = {
      target: 'Stuknij na mapie punkt, do którego biegniesz.',
      draw: 'Narysuj palcem trasę od miejsca, w którym jesteś, do celu. Możesz odrywać palec i rysować dalej. Dwa palce przesuwają i powiększają mapę.',
      cal: 'Stuknij na mapie miejsce, które potrafisz wskazać w terenie (skrzyżowanie, róg budynku).',
    }[mode] || '';
    if (mode && stream) setCamera(false);
    drawMarkers();
  }

  // ---------- kalibracja ----------
  function addPair(lat, lon) {
    pairs.push({ lat, lon, px: pending.px, py: pending.py });
    savePairs();
    setTapMode(null);
    refresh();
  }

  // ---------- trasa rysowana ręcznie ----------
  $('ldraw').addEventListener('click', () => setTapMode('draw'));
  $('ldrawundo').addEventListener('click', () => { strokes.pop(); drawMarkers(); });
  $('ldrawdone').addEventListener('click', () => {
    const pts = strokes.flat();
    if (pts.length < 2) { $('lhint').textContent = 'Najpierw narysuj trasę palcem na mapie.'; return; }
    const cum = [0];
    for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y));
    target = pts[pts.length - 1];
    route = { pts, cum, custom: true };
    routes = [route]; routeNote = ''; routeAt = Date.now();
    setTapMode(null);
    refresh();
    // teren potrzebny do sprawdzania przeszkód przy powrocie na narysowaną trasę
    setTimeout(() => { try { ensureProc(); } catch (err) { /* bez tego wracamy po prostej */ } refresh(); }, 60);
  });

  $('lcaladd').addEventListener('click', () => setTapMode('cal'));
  $('lcancel').addEventListener('click', () => setTapMode(null));
  $('lcalgps').addEventListener('click', () => { if (fix && pending) addPair(fix.lat, fix.lon); });
  $('lcalsave').addEventListener('click', () => {
    const ll = parseLatLon($('lcalinput').value);
    if (!ll || !pending) { $('lhint').textContent = 'Nie rozumiem tych współrzędnych. Wpisz np. 52.2297, 21.0122 (szerokość, długość).'; return; }
    $('lcalinput').value = '';
    addPair(ll.lat, ll.lon);
  });
  $('lcalclear').addEventListener('click', () => {
    const b = $('lcalclear');
    if (b.dataset.armed !== '1') {
      b.dataset.armed = '1'; b.textContent = 'Na pewno usunąć?';
      setTimeout(() => { b.dataset.armed = ''; b.textContent = 'Usuń kalibrację'; }, 3000);
      return;
    }
    b.dataset.armed = ''; b.textContent = 'Usuń kalibrację';
    pairs = []; track = []; route = null; routes = []; savePairs(); refresh();
  });

  // ---------- trasa do celu ----------
  function ensureProc() {
    if (proc) return;
    if (ocadCtx) { // teren prosto z symboli OCAD-a, na siatce pokrywającej dokładnie wyświetlany obraz
      const grid = BnoSymbols.build(ocadCtx.map, PROC_DIM, symOverrides(ocadCtx.setId), ocadCtx.setId, ocadCtx.region);
      proc = { k: grid.w / W, w: grid.w, h: grid.h, cost: costGrid(grid.cls), contour: grid.contour };
      return;
    }
    const k = Math.min(1, PROC_DIM / Math.max(W, H));
    const w = Math.round(W * k), h = Math.round(H * k);
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const g = c.getContext('2d', { willReadFrequently: true });
    g.drawImage(img, 0, 0, w, h);
    let hi = null;
    const kh = Math.min(1, HI_DIM / Math.max(W, H));
    if (kh > k * 1.2) {
      const ch = document.createElement('canvas');
      ch.width = Math.round(W * kh); ch.height = Math.round(H * kh);
      const gh = ch.getContext('2d', { willReadFrequently: true });
      gh.drawImage(img, 0, 0, ch.width, ch.height);
      hi = { data: gh.getImageData(0, 0, ch.width, ch.height).data, w: ch.width, h: ch.height };
    }
    const res = analyze(g.getImageData(0, 0, w, h).data, w, h, $('lmode').value, hi);
    proc = { k, w, h, cost: costGrid(res.cls), contour: res.contour };
  }

  function toRoute(part) {
    const pts = [];
    const path = part.path, step = Math.max(1, Math.round(path.length / 1500));
    for (let i = 0; i < path.length; i += step) pts.push({ x: (path[i] % proc.w + 0.5) / proc.k, y: (((path[i] / proc.w) | 0) + 0.5) / proc.k });
    pts.push({ x: target.x, y: target.y });
    const cum = [0];
    for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y));
    return { pts, cum, cost: part.cost, crossings: part.crossings };
  }

  // Przyciski wyboru wariantu (A = najszybszy, B = alternatywa).
  let variantsKey = '';
  function renderVariants() {
    const len = (r) => (cal ? Math.round(r.cum[r.cum.length - 1] / cal.pxPerM / 10) * 10 : null);
    const key = routes.map((r) => len(r) + ':' + (r === route) + ':' + !!r.custom + ':' + r.crossings).join('|');
    if (key === variantsKey) return;
    variantsKey = key;
    const box = $('lvariants');
    box.replaceChildren();
    box.hidden = routes.length < 2 && !(route && route.custom);
    routes.forEach((r, i) => {
      const b = document.createElement('button');
      if (r.custom) b.textContent = 'Twoja trasa' + (len(r) == null ? '' : `: ${len(r)} m`);
      else {
        const slower = Math.round((r.cost / routes[0].cost - 1) * 100);
        b.textContent = `Wariant ${'AB'[i]}: ${len(r)} m` + (r.crossings == null ? '' : ` · ${r.crossings} warstw.`)
          + (i === 0 ? ' · najszybszy' : ` · ok. ${slower}% wolniejszy`);
      }
      b.classList.toggle('on', r === route);
      b.addEventListener('click', () => { route = r; refresh(); });
      box.append(b);
    });
  }

  function computeRoute() {
    route = null; routes = [];
    const pos = position();
    if (!target) { refresh(); return; }
    if (!pos) { routeNote = 'Cel ustawiony. Trasa policzy się, gdy będzie kalibracja i pozycja z GPS.'; refresh(); return; }
    if (pos.x < 0 || pos.y < 0 || pos.x >= W || pos.y >= H) { routeNote = 'Jesteś poza mapą – nie policzę trasy.'; refresh(); return; }
    routeNote = proc ? 'Liczę trasę…' : 'Liczę trasę… (pierwsza analiza mapy może potrwać kilkanaście sekund)';
    guide();
    setTimeout(() => {
      try {
        ensureProc();
        const clamp = (v, m) => Math.min(m - 1, Math.max(0, Math.round(v)));
        const a = { x: clamp(pos.x * proc.k, proc.w), y: clamp(pos.y * proc.k, proc.h) };
        const b = { x: clamp(target.x * proc.k, proc.w), y: clamp(target.y * proc.k, proc.h) };
        // jedno przecięcie warstwicy = pół cięcia w górę = (cięcie / 2) * CLIMB_FACTOR metrów po płaskim
        const interval = parseFloat($('lcontour').value);
        const climb = interval > 0 ? { contour: proc.contour, perCrossing: interval / 2 * CLIMB_FACTOR * cal.pxPerM * proc.k } : null;
        const leg = routeLeg(proc.cost, proc.w, proc.h, a, b, climb);
        routeAt = Date.now();
        if (!leg.best) {
          routeNote = 'Nie znajduję przejścia do celu (teren nie do przejścia) – strzałka pokazuje kierunek na wprost.';
        } else {
          routes = [leg.best, leg.alt].filter(Boolean).map(toRoute);
          route = routes[0];
          routeNote = '';
        }
      } catch (err) {
        routeNote = 'Błąd liczenia trasy: ' + err.message;
      }
      refresh();
    }, 30);
  }

  // Punkt trasy w odległości c (w pikselach obrazu) od jej początku.
  function pointAt(r, c) {
    const cum = r.cum, last = cum.length - 1;
    if (c <= 0) return r.pts[0];
    if (c >= cum[last]) return r.pts[last];
    let lo = 0, hi = last;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (cum[m] <= c) lo = m; else hi = m; }
    const t = (c - cum[lo]) / ((cum[hi] - cum[lo]) || 1);
    return { x: r.pts[lo].x + (r.pts[hi].x - r.pts[lo].x) * t, y: r.pts[lo].y + (r.pts[hi].y - r.pts[lo].y) * t };
  }

  // Najbliższe miejsce na odcinku trasy między c0 a c1 (odległości od początku). Zwraca { c, d } w pikselach.
  function project(r, pos, c0, c1) {
    let best = null;
    for (let i = 0; i < r.pts.length - 1; i++) {
      if (r.cum[i + 1] < c0 || r.cum[i] > c1) continue;
      const p = r.pts[i], q = r.pts[i + 1], dx = q.x - p.x, dy = q.y - p.y, len2 = dx * dx + dy * dy;
      const t = len2 ? Math.max(0, Math.min(1, ((pos.x - p.x) * dx + (pos.y - p.y) * dy) / len2)) : 0;
      const d = Math.hypot(p.x + dx * t - pos.x, p.y + dy * t - pos.y);
      if (!best || d < best.d) best = { c: r.cum[i] + Math.sqrt(len2) * t, d };
    }
    return best;
  }

  // "Przyklejenie" do trasy z pamięcią postępu. Szukamy tylko tam, dokąd dało się dobiec od ostatniego
  // odczytu (trochę do tyłu, do przodu tyle, ile pozwala MAX_SPEED), żeby błąd GPS nie przerzucał Cię na
  // fragment trasy po drugiej stronie budynku. Dopiero gdy przez LOST_FIXES odczytów z rzędu jesteś daleko
  // od tego kawałka, szukamy na całej trasie.
  // Zwraca { c: postęp wzdłuż trasy, d: odległość od niej } w pikselach obrazu.
  function matchRoute(pos) {
    if (route.matchFix === fix && route.match) return route.match; // ten sam odczyt GPS: ten sam wynik
    const k = cal.pxPerM, total = route.cum[route.cum.length - 1], now = Date.now();
    let m = null;
    if (route.prog != null) {
      const fwd = MAX_SPEED * (now - route.progAt) / 1000 + RETURN_M;
      m = project(route, pos, route.prog - BACK_M * k, route.prog + fwd * k);
      route.lost = m && m.d <= 2 * RETURN_M * k ? 0 : (route.lost || 0) + 1;
    }
    if (!m || route.lost >= LOST_FIXES) {
      m = project(route, pos, 0, total) || { c: 0, d: Math.hypot(route.pts[0].x - pos.x, route.pts[0].y - pos.y) };
      route.lost = 0;
    }
    route.prog = m.c; route.progAt = now;
    route.matchFix = fix; route.match = m;
    return m;
  }

  // Zszedłeś z trasy -> liczymy nową od miejsca, w którym jesteś.
  function maybeReroute() {
    if (route && route.custom) return; // własnej trasy nie poprawiamy
    const pos = position();
    if (!target || !pos || routeNote.startsWith('Liczę trasę')) return;
    if (!route) { if (!routeAt || Date.now() - routeAt > 20000) { if (!routeAt) computeRoute(); } return; }
    const off = matchRoute(pos).d / cal.pxPerM;
    const g = guidance();
    // do trasy nie da się wrócić po prostej (przeszkoda) -> od razu liczymy nową z miejsca, w którym jesteś
    if (g && g.blocked && Date.now() - routeAt > 5000) { computeRoute(); return; }
    if (off > Math.max(40, 2 * fix.acc) && Date.now() - routeAt > 15000) computeRoute();
  }

  // Czy z a do b da się przejść po prostej bez wchodzenia w teren nie do przejścia (współrzędne obrazu).
  // Jeśli GPS postawił Cię "w budynku", początek odcinka aż do wyjścia z przeszkody nie liczy się.
  function lineClear(a, b) {
    const ax = a.x * proc.k, ay = a.y * proc.k, bx = b.x * proc.k, by = b.y * proc.k;
    const steps = Math.ceil(Math.hypot(bx - ax, by - ay));
    let outside = false;
    for (let i = 0; i <= steps; i++) {
      const t = steps ? i / steps : 0;
      const x = Math.round(ax + (bx - ax) * t), y = Math.round(ay + (by - ay) * t);
      if (x < 0 || y < 0 || x >= proc.w || y >= proc.h) continue;
      if (proc.cost[y * proc.w + x] !== Infinity) outside = true;
      else if (outside) return false;
    }
    return true;
  }

  // Kierunek i dystans albo null. Na trasie strzałka pokazuje kierunek samej linii w miejscu, w którym
  // jesteś (z najbliższych TANGENT_M metrów), więc zakręt wokół budynku nie jest ścinany na skos.
  // Dopiero gdy odejdziesz od linii dalej niż RETURN_M, strzałka prowadzi z powrotem na trasę.
  function guidance() {
    const pos = position();
    if (!target || !pos) return null;
    const straight = Math.hypot(target.x - pos.x, target.y - pos.y) / cal.pxPerM;
    let from = pos, aim = target, dist = straight, off = 0, returning = false, blocked = false;
    if (route) {
      const k = cal.pxPerM, total = route.cum[route.cum.length - 1], m = matchRoute(pos);
      off = m.d / k;
      dist = (total - m.c) / k + off;
      const ahead = pointAt(route, m.c + TANGENT_M * k);
      if (off > Math.max(RETURN_M, fix.acc)) {
        returning = true;
        aim = ahead;
        if (proc) { // wracamy tylko tam, dokąd nie trzeba iść przez jezioro, budynek czy teren zakazany
          const reachable = RETURN_TRY_M.map((d) => pointAt(route, m.c + d * k)).find((q) => lineClear(pos, q));
          if (reachable) aim = reachable; else blocked = true;
        }
      }
      else if (total - m.c > 2 * k) { from = pointAt(route, m.c); aim = ahead; }
    }
    if (Math.hypot(aim.x - from.x, aim.y - from.y) < 1e-6) { from = pos; aim = target; }
    return {
      bearing: bearingOf(cal, aim.x - from.x, aim.y - from.y), // dokąd biec teraz
      targetBearing: bearingOf(cal, target.x - pos.x, target.y - pos.y), // gdzie leży punkt docelowy
      dist, off, returning, blocked, arrived: straight < Math.max(15, fix.acc),
    };
  }

  function guide() {
    const g = guidance();
    let text = routeNote, rel = null;
    if (g && !routeNote.startsWith('Liczę')) {
      if (g.arrived) text = 'Jesteś przy punkcie.';
      else {
        text = `${Math.round(g.dist / 10) * 10} m do celu`;
        if (heading == null) text += ' · brak kompasu, kieruj się mapą';
        else {
          rel = ((g.bearing - heading + 540) % 360) - 180;
          const a = Math.abs(rel);
          text += a < 15 ? ' · prosto' : a > 135 ? ' · zawróć' : (rel > 0 ? ' · w prawo ' : ' · w lewo ') + Math.round(a / 5) * 5 + '°';
        }
        if (g.returning) text += ` · wróć na trasę (${Math.round(g.off / 5) * 5} m obok)`;
        if (g.blocked) text += ' · między Tobą a trasą jest przeszkoda, obejdź ją';
        if (!route) text += ' · brak trasy, kierunek prosto na cel';
        if (routeNote) text += ' · ' + routeNote;
      }
    } else if (!target && W) text = '';
    $('lguide').textContent = text;
    $('lartext').textContent = text || 'Ustaw cel na mapie, żeby zobaczyć strzałkę.';

    const show = stream && rel != null && !(g && g.arrived);
    $('lararrow').hidden = !show;
    $('larpin').hidden = true;
    if (!show) return;
    $('lararrow').style.transform = `translateX(-50%) perspective(420px) rotateX(58deg) rotateZ(${rel.toFixed(1)}deg)`;
    const relT = ((g.targetBearing - heading + 540) % 360) - 180;
    if (Math.abs(relT) < CAM_HFOV / 2) { // punkt docelowy w kadrze: znacznik na horyzoncie
      const r = stage.getBoundingClientRect();
      const x = r.width / 2 + Math.tan(relT * Math.PI / 180) / Math.tan(CAM_HFOV / 2 * Math.PI / 180) * r.width / 2;
      const tilt = pitch == null ? 0 : Math.max(-35, Math.min(35, pitch - 90));
      $('larpin').hidden = false;
      $('larpin').style.left = x + 'px';
      $('larpin').style.top = (r.height * (0.45 + tilt / 90)) + 'px';
    }
  }

  $('ltarget').addEventListener('click', () => setTapMode('target'));
  $('lmode').addEventListener('change', () => { proc = null; if (target && !(route && route.custom)) computeRoute(); });
  try { const saved = localStorage.getItem('bno-contour'); if (saved != null) $('lcontour').value = saved; } catch (err) { /* nieistotne */ }
  $('lcontour').addEventListener('change', () => {
    try { localStorage.setItem('bno-contour', $('lcontour').value); } catch (err) { /* jw. */ }
    if (target && !(route && route.custom)) computeRoute();
  });

  // ---------- kamera ----------
  async function setCamera(on) {
    if (on) {
      if (!navigator.mediaDevices || !window.isSecureContext) { say('Kamera działa tylko na stronie otwartej przez HTTPS (albo localhost).'); return; }
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false });
        video.srcObject = stream;
        video.play().catch(() => {}); // nie czekamy: część przeglądarek rozstrzyga to dopiero po pierwszej klatce
      } catch (err) {
        stream = null;
        say('Nie mogę włączyć kamery: ' + (err.name === 'NotAllowedError' ? 'brak zgody na kamerę dla tej strony.' : err.message));
        return;
      }
    } else if (stream) {
      stream.getTracks().forEach((t) => t.stop());
      stream = null; video.srcObject = null;
    }
    video.hidden = !stream; $('lar').hidden = !stream; $('lmini').hidden = !stream;
    if (stream) $('lmini').append(world); else stage.prepend(world); // ta sama mapa: duża albo jako minimapa
    if (!stream && stage.classList.contains('full')) setFull(false);
    $('lcam').textContent = stream ? 'Pokaż mapę' : 'Kamera';
    $('lcam').classList.toggle('on', !!stream);
    if (stream) stage.scrollIntoView({ block: 'start' }); // obraz z kamery na cały ekran telefonu
    refresh();
  }
  $('lcam').addEventListener('click', () => { startCompass(); setCamera(!stream); });

  // Pełny ekran kamery. Klasa CSS działa wszędzie (także na iPhonie), a tam, gdzie przeglądarka
  // na to pozwala, dodatkowo chowamy jej paski prawdziwym trybem pełnoekranowym.
  function setFull(on) {
    stage.classList.toggle('full', on);
    $('lfull').textContent = on ? 'Zamknij pełny ekran' : 'Pełny ekran';
    try {
      if (on && stage.requestFullscreen) stage.requestFullscreen().catch(() => {});
      else if (!on && document.fullscreenElement) document.exitFullscreen().catch(() => {});
    } catch (err) { /* zostaje wersja CSS */ }
    refresh();
  }
  $('lfull').addEventListener('click', () => setFull(!stage.classList.contains('full')));
  document.addEventListener('fullscreenchange', () => {
    if (!document.fullscreenElement && stage.classList.contains('full')) setFull(false); // wyjście gestem "wstecz"
  });

  // ---------- GPS i kompas ----------
  function setFollow(on) {
    follow = on;
    $('lfollow').textContent = on ? 'Śledzenie: wł.' : 'Śledzenie: wył.';
    $('lfollow').classList.toggle('on', on);
  }
  $('lfollow').addEventListener('click', () => { setFollow(!follow); refresh(); });

  // Kierunek, w który patrzy tylna kamera telefonu trzymanego pionowo (wzór z normy W3C DeviceOrientation).
  function cameraHeading(alpha, beta, gamma) {
    const d = Math.PI / 180;
    const cX = Math.cos(beta * d), cY = Math.cos(gamma * d), cZ = Math.cos(alpha * d);
    const sX = Math.sin(beta * d), sY = Math.sin(gamma * d), sZ = Math.sin(alpha * d);
    const vx = -cZ * sY - sZ * sX * cY, vy = -sZ * sY + cZ * sX * cY;
    return (Math.atan2(vx, vy) / d + 360) % 360;
  }

  function onOrientation(e) {
    let h = null;
    const upright = typeof e.beta === 'number' && e.beta > 45 && typeof e.gamma === 'number';
    if (typeof e.webkitCompassHeading === 'number') h = e.webkitCompassHeading;             // iOS
    else if (e.absolute && typeof e.alpha === 'number') h = upright ? cameraHeading(e.alpha, e.beta, e.gamma) : 360 - e.alpha; // Android
    if (h == null) return;
    h = (h + ((screen.orientation && screen.orientation.angle) || 0) + 360) % 360;
    if (typeof e.beta === 'number') pitch = e.beta;
    if (heading == null || Math.abs(((h - heading + 540) % 360) - 180) > 1.5) {
      heading = h;
      applyView(); guide();
    }
  }

  let compassOn = false;
  async function startCompass() {
    if (compassOn) return;
    try {
      if (typeof DeviceOrientationEvent !== 'undefined' && DeviceOrientationEvent.requestPermission) {
        if (await DeviceOrientationEvent.requestPermission() !== 'granted') return;
      }
      compassOn = true;
      window.addEventListener('deviceorientationabsolute', onOrientation);
      window.addEventListener('deviceorientation', onOrientation);
    } catch (err) { /* bez kompasu mapa też działa */ }
  }

  function stopGps() {
    navigator.geolocation.clearWatch(watchId);
    watchId = null; fix = null;
    if (wake) { wake.release().catch(() => {}); wake = null; }
    $('lgps').textContent = 'Włącz GPS';
    $('lgps').classList.remove('on');
    refresh();
  }

  $('lgps').addEventListener('click', () => {
    if (watchId != null) { stopGps(); return; }
    if (!window.isSecureContext || !navigator.geolocation) {
      say('Przeglądarka udostępnia GPS tylko stronom otwartym przez HTTPS (albo localhost). Ta strona jest otwarta inaczej, więc pozycji nie będzie.');
      return;
    }
    startCompass();
    if (navigator.wakeLock) navigator.wakeLock.request('screen').then((w) => { wake = w; }).catch(() => {});
    watchId = navigator.geolocation.watchPosition((p) => {
      fix = { lat: p.coords.latitude, lon: p.coords.longitude, acc: p.coords.accuracy };
      const last = track[track.length - 1];
      if (!last || distance(last, fix) > 4) {
        track.push({ lat: fix.lat, lon: fix.lon });
        if (track.length > 5000) track.shift();
      }
      refresh();
    }, (err) => {
      say(err.code === 1 ? 'Brak zgody na lokalizację. Zezwól na nią tej stronie w ustawieniach przeglądarki.'
        : 'GPS nie podaje pozycji (' + err.message + '). Wyjdź pod otwarte niebo i spróbuj ponownie.');
      if (err.code === 1) stopGps();
    }, { enableHighAccuracy: true, maximumAge: 1000, timeout: 30000 });
    $('lgps').textContent = 'Wyłącz GPS';
    $('lgps').classList.add('on');
    describe();
  });

  setFollow(true);
  describe();
})();

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
  const PUNCH_M = 10;      // tak blisko środka kółka punkt zalicza się sam (przy słabym GPS do 20 m)

  const ALT_COLORS = ['#1565c0', '#ef6c00'];
  const stage = $('lstage'), world = $('lworld'), img = $('limg'), svg = $('lsvg'), video = $('lvideo');
  const el = {};
  for (const [name, tag] of [['course', 'g'], ['track', 'polyline'], ['alt', 'polyline'], ['alt2', 'polyline'], ['route', 'polyline'], ['cals', 'g'], ['target', 'circle'],
    ['draw', 'polyline'], ['acc', 'circle'], ['head', 'polygon'], ['dot', 'circle'], ['pend', 'circle']]) {
    el[name] = document.createElementNS(SVG, tag);
    el[name].setAttribute('class', 'l-' + name);
    svg.append(el[name]);
  }

  let W = 0, H = 0, mapKey = null, mapName = '';
  let mapScale = 0;                     // mianownik skali mapy (0 = nieznany)
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
  let rot = 0, viewRot = 0, rotOn = false; // obrót mapy na ekranie [rad]; viewRot = obrót aktualnego widoku (mapa albo minimapa)
  let help = 'full', reveal = false;      // sposób prowadzenia; reveal = po biegu pokazujemy pozycję i ślad także w trybie samej mapy
  let run = null, lastPunch = 0, shownRun = null, courseName = ''; // trwający bieg po trasie i oglądany zapisany przebieg
  try { rotOn = localStorage.getItem('bno-rot') === '1'; const h = localStorage.getItem('bno-help'); if (h === 'dir' || h === 'map') help = h; } catch (err) { /* nieistotne */ }

  let sayHook = null; // zakładka "Generacja danych" podgląda komunikaty podczas przygotowania mapy
  const say = (text) => { $('lstatus').textContent = text; if (sayHook) sayHook(text); };

  // ---------- widok mapy ----------
  function applyView() {
    if (stream) {
      // tryb kamery: minimapa wyśrodkowana na Tobie i obrócona tak, żeby "góra" była tam, gdzie patrzysz
      const r = $('lmini').getBoundingClientRect(), pos = hidden() ? null : position();
      viewRot = 0;
      if (pos) {
        vs = r.width / (MINI_SPAN_M * cal.pxPerM);
        let ang = 0;
        if (heading != null) { const v = headingVector(cal, heading); ang = Math.atan2(v.x, -v.y); }
        viewRot = -ang;
        world.style.transform = `translate(${r.width / 2}px, ${r.height * 0.62}px) rotate(${-ang}rad) scale(${vs}) translate(${-pos.x}px, ${-pos.y}px)`;
      } else {
        vs = Math.min(r.width / W, r.height / H);
        world.style.transform = `scale(${vs})`;
      }
    } else {
      vs = s; viewRot = rot;
      world.style.transform = `translate(${ox}px, ${oy}px) rotate(${rot}rad) scale(${s})`;
    }
    drawMarkers();
  }

  let needFit = false; // mapa wczytana, gdy zakładka była ukryta: dopasujemy widok, gdy się pojawi
  function fitView() {
    const r = stage.getBoundingClientRect();
    if (!r.width || !r.height) { needFit = true; return; }
    needFit = false;
    s = Math.min(r.width / W, r.height / H);
    centerOn({ x: W / 2, y: H / 2 });
    applyView();
  }

  function zoomAt(x, y, f) {
    const ns = Math.min(12, Math.max(0.02, s * f));
    f = ns / s;
    ox = x - (x - ox) * f; oy = y - (y - oy) * f; s = ns;
  }

  // Obrót: ekran = R(rot) * (mapa * s) + (ox, oy). Mapa obraca się wokół środka ekranu.
  const rotv = (x, y, a) => ({ x: x * Math.cos(a) - y * Math.sin(a), y: x * Math.sin(a) + y * Math.cos(a) });
  const toMap = (p) => { const q = rotv(p.x - ox, p.y - oy, -rot); return { x: q.x / s, y: q.y / s }; };
  function centerOn(m) {
    const r = stage.getBoundingClientRect(), q = rotv(m.x * s, m.y * s, rot);
    ox = r.width / 2 - q.x; oy = r.height / 2 - q.y;
  }
  function updateRot() { // "góra" ekranu = kierunek, w który patrzysz (gdy obrót jest włączony i działa kompas)
    let a = 0;
    if (rotOn && cal && heading != null) { const v = headingVector(cal, heading); a = -Math.atan2(v.x, -v.y); }
    if (Math.abs(a - rot) < 1e-4) return;
    const r = stage.getBoundingClientRect(), q = rotv(r.width / 2 - ox, r.height / 2 - oy, a - rot);
    ox = r.width / 2 - q.x; oy = r.height / 2 - q.y; rot = a;
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
    const others = routes.filter((r) => r !== route);
    [el.alt, el.alt2].forEach((line, i) => { // niewybrane warianty: przerywane, pierwszy niebieski, drugi pomarańczowy
      const other = others[i];
      line.style.display = other ? '' : 'none';
      if (!other) return;
      line.setAttribute('class', 'l-alt'); line.style.stroke = ALT_COLORS[i];
      line.setAttribute('points', fmt(other.pts)); line.setAttribute('stroke-width', 3 * u);
      line.setAttribute('stroke-dasharray', `${9 * u} ${7 * u}`);
    });

    drawCourse(u);
    const pos = hidden() ? null : position();
    for (const k of ['dot', 'acc', 'head']) el[k].style.display = pos ? '' : 'none';
    const showTrack = !!cal && track.length > 1 && !hidden();
    el.track.style.display = showTrack ? '' : 'none';
    if (showTrack) { el.track.setAttribute('points', fmt(track.map((t) => toPixel(cal, t.lat, t.lon)))); el.track.setAttribute('stroke-width', 2.5 * u); }
    if (!pos) return;
    el.dot.setAttribute('cx', pos.x); el.dot.setAttribute('cy', pos.y);
    el.dot.setAttribute('r', 8 * u); el.dot.setAttribute('stroke-width', 3 * u);
    el.acc.setAttribute('cx', pos.x); el.acc.setAttribute('cy', pos.y);
    el.acc.setAttribute('r', Math.max(8 * u, fix.acc * cal.pxPerM));
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
    updateRot();
    if (follow && pos && W && !hidden()) centerOn(pos);
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
    say(gps + ' · ' + c + (ocadCtx && ocadCtx.note ? ' ' + ocadCtx.note : ocadNote ? ' ' + ocadNote : ''));
  }

  // ---------- mapa ----------
  $('lfile').addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;
    if (/\.(ocd|jgw|jpgw|pgw|pngw|tfw|wld)$/i.test(file.name)) {
      say('Tu wczytujesz samą mapę (PDF, JPG lub PNG) i kalibrujesz ją ręcznie. Pliki OCAD i georeferencji służą do przygotowania treningu w zakładce „Generacja danych”.');
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
  let gridCtx = null; // gotowa siatka terenu treningu: { w, h, cls, contour }
  // Trasa treningu: punkty w kolejności biegu (piksele obrazu) i numer punktu, do którego teraz biegniesz.
  let course = null, courseAt = -1;
  let courses = [];        // trasy treningu: [{ name, points: [{ x, y, type, code }] }] w pikselach obrazu
  let courseFile = null;   // trasy wczytane z pliku (pozycje na świecie albo na mapie), czekające na przeliczenie

  // Wybrana trasa rysowana na mapie jak nadruk: trójkąt startu, kółka z numerami, podwójne kółko mety i linie.
  // Kółko ma rozmiar jak na wydruku (średnica 6 mm w skali mapy). Zaliczone punkty i odcinki są wyblakłe.
  let courseRev = 0, courseSig = '';
  function drawCourse(u) {
    const sc = mapScale || ($('lmode').value === 'sprint' ? 4000 : 10000);
    const R = !course ? 0 : cal ? 0.003 * sc * cal.pxPerM : Math.max(W, H) * 0.008;
    el.course.setAttribute('stroke-width', Math.max(R * 0.12, 1.5 * u));
    const sig = courseRev + ':' + courseAt + ':' + R.toFixed(2) + ':' + Math.round(viewRot * 12);
    if (sig === courseSig) return;
    courseSig = sig;
    el.course.replaceChildren();
    if (!course) return;
    const add = (tag, attrs, dim, text) => {
      const n = document.createElementNS(SVG, tag);
      for (const k in attrs) n.setAttribute(k, typeof attrs[k] === 'number' ? attrs[k].toFixed(1) : attrs[k]);
      if (dim) n.setAttribute('opacity', 0.35);
      if (text != null) n.textContent = text;
      el.course.append(n);
    };
    const rad = (p) => (p.type === 'start' ? R * 1.35 : p.type === 'meta' ? R * 1.17 : R);
    const dir = (a, b) => Math.atan2(b.y - a.y, b.x - a.x);
    let num = 0;
    course.forEach((p, i) => {
      const dim = i < courseAt, prev = course[i - 1], next = course[i + 1];
      if (next) {
        const d = Math.hypot(next.x - p.x, next.y - p.y), a = rad(p), b = rad(next);
        if (d > a + b) add('line', { x1: p.x + (next.x - p.x) / d * a, y1: p.y + (next.y - p.y) / d * a, x2: next.x - (next.x - p.x) / d * b, y2: next.y - (next.y - p.y) / d * b }, dim);
      }
      if (p.type === 'start') {
        const a0 = next ? dir(p, next) : -Math.PI / 2, r = rad(p);
        add('polygon', { points: [0, 1, 2].map((k) => (p.x + Math.cos(a0 + k * 2.0944) * r).toFixed(1) + ',' + (p.y + Math.sin(a0 + k * 2.0944) * r).toFixed(1)).join(' ') }, dim);
      } else if (p.type === 'meta') {
        add('circle', { cx: p.x, cy: p.y, r: R * 0.83 }, dim); add('circle', { cx: p.x, cy: p.y, r: R * 1.17 }, dim);
      } else {
        add('circle', { cx: p.x, cy: p.y, r: R }, dim);
        // numer stawiamy po tej stronie kółka, która jest najdalej od linii dochodzącej i odchodzącej
        const taken = [prev && dir(p, prev), next && dir(p, next)].filter((v) => v != null && v !== undefined && v !== false);
        let best = -Math.PI / 4, bs = -1;
        for (let k = 0; k < 8; k++) {
          const a = -Math.PI / 4 + k * Math.PI / 4;
          const sc2 = taken.length ? Math.min(...taken.map((t) => Math.abs(Math.atan2(Math.sin(a - t), Math.cos(a - t))))) : 9;
          if (sc2 > bs + 1e-6) { bs = sc2; best = a; }
        }
        const tx = p.x + Math.cos(best) * R * 2, ty = p.y + Math.sin(best) * R * 2; // numer zawsze prosto, także na obróconej mapie
        add('text', { x: tx, y: ty, 'font-size': R * 1.5, transform: `rotate(${(-viewRot * 180 / Math.PI).toFixed(0)} ${tx.toFixed(1)} ${ty.toFixed(1)})` }, dim, String(++num));
      }
    });
  }

  function setCourse(points, name) {
    course = points && points.length ? points : null;
    courseName = name || '';
    dropRun();
    courseAt = -1; courseRev++;
    showNext();
  }
  // Lista tras do wyboru; przy jednej trasie wybiera się sama.
  function setCourses(list) {
    courses = list || [];
    const sel = $('lcourse');
    sel.replaceChildren();
    sel.hidden = courses.length < 2;
    courses.forEach((c, i) => { const o = document.createElement('option'); o.value = i; o.textContent = `Trasa: ${c.name} (${c.points.filter((p) => p.type === 'punkt').length} pkt)`; sel.append(o); });
    setCourse(courses.length ? courses[0].points : null, courses.length ? courses[0].name : '');
  }
  $('lcourse').addEventListener('change', () => { const c = courses[+$('lcourse').value]; setCourse(c.points, c.name); target = null; route = null; routes = []; refresh(); });

  // Przeliczenie tras z pliku na piksele obrazu: z pozycji na świecie (przez kalibrację) albo z pozycji na mapie
  // OCAD-a (gdy znamy położenie obrazu na tej mapie). Zwraca dopisek do komunikatu.
  function resolveCourses(left, top, mmImg) {
    if (!courseFile) return '';
    const crsGeo = courseFile.geo && BnoAlign.detectCrs(courseFile.geo);
    let lost = 0;
    // trasa bez startu albo bez mety zwykle oznacza, że w Course Setterze nie dodano ich do tej trasy
    const gaps = courseFile.courses.map((c) => {
      const miss = [c.controls[0].type !== 'start' && 'startu', c.controls[c.controls.length - 1].type !== 'meta' && 'mety'].filter(Boolean);
      return miss.length ? `${c.name} nie ma ${miss.join(' ani ')}` : '';
    }).filter(Boolean);
    const list = courseFile.courses.map((c) => ({
      name: c.name,
      points: c.controls.map((q) => {
        let ll = q.lat != null ? { lat: q.lat, lon: q.lon } : null;
        if (!ll && crsGeo && q.mx != null) ll = BnoAlign.ocadToLatLon(courseFile.geo, crsGeo, q.mx, q.my); // projekt tras z własną georeferencją
        let p = null;
        if (ll && cal) p = toPixel(cal, ll.lat, ll.lon);
        else if (q.mx != null && mmImg) p = { x: (q.mx - left) / mmImg, y: (top - q.my) / mmImg }; // te same milimetry co mapa OCAD
        if (!p || p.x < 0 || p.y < 0 || p.x > W || p.y > H) { lost++; return null; }
        return { x: p.x, y: p.y, type: q.type, code: q.code };
      }).filter(Boolean),
    })).filter((c) => c.points.some((p) => p.type === 'punkt'));
    setCourses(list);
    if (!list.length) return '. UWAGA: żaden punkt trasy nie leży na tym obrazie mapy – sprawdź, czy plik trasy jest do tej mapy';
    return `. Trasy z pliku: ${list.map((c) => `${c.name} (${c.points.filter((p) => p.type === 'punkt').length} pkt)`).join(', ')}`
      + (lost ? `; ${lost} pozycji poza obrazem pominięto` : '')
      + (gaps.length ? `. UWAGA: trasa ${gaps.join(', trasa ')} – sprawdź w Course Setterze, czy tak ma być` : '') + (courseFile.notes.length ? '. ' + courseFile.notes.join(' ') : '');
  }

  // Siatka terenu zapisana jako PNG (czerwony = kategoria, zielony = warstwica), przygotowana przez admina.
  function loadGrid(url) {
    const gi = new Image();
    gi.onload = () => {
      try {
        const c = document.createElement('canvas');
        c.width = gi.naturalWidth; c.height = gi.naturalHeight;
        const g = c.getContext('2d', { willReadFrequently: true });
        g.drawImage(gi, 0, 0);
        const d = g.getImageData(0, 0, c.width, c.height).data, n = c.width * c.height;
        const cls = new Uint8Array(n), contour = new Uint8Array(n), max = BnoCore.TERRAIN.length;
        for (let i = 0; i < n; i++) { const v = d[i * 4]; cls[i] = v < max ? v : 0; contour[i] = d[i * 4 + 1] > 127 ? 1 : 0; }
        gridCtx = { w: c.width, h: c.height, cls, contour };
        proc = null;
        $('lmode').hidden = true; // rodzaj mapy jest już "wliczony" w siatkę
        ocadNote = 'Teren tego treningu jest przygotowany z góry.';
        refresh();
      } catch (err) { /* zostaje analiza obrazu w telefonie */ }
    };
    gi.src = url;
  }
  async function openPair(ocdFile, imgFile, worldFile, courseSrc) {
    try {
      let map = null, world = null;
      courseFile = null;
      if (courseSrc) {
        say('Czytam plik trasy…');
        courseFile = /\.xml$/i.test(courseSrc.name) ? BnoCourse.parseIofXml(await courseSrc.text()) : BnoCourse.parseOcadCourses(await courseSrc.arrayBuffer());
      }
      if (ocdFile) { say('Czytam plik OCAD…'); map = BnoOcad.parse(await ocdFile.arrayBuffer()); }
      if (worldFile) {
        // sześć liczb: rozmiar piksela w X, obrót, obrót, rozmiar piksela w Y (ujemny), współrzędne środka lewego górnego piksela
        const v = (await worldFile.text()).trim().split(/\s+/).map((t) => parseFloat(t.replace(',', '.')));
        if (v.length >= 6 && v.every(isFinite) && v[0] > 0) world = { a: v[0], d: v[1], b: v[2], e: v[3], c: v[4], f: v[5] };
      }
      say(/\.pdf$/i.test(imgFile.name) ? 'Zamieniam PDF na obraz…' : 'Wczytuję mapę…');
      const f = await BnoFile.open(imgFile);
      loadMap(f.url, { key: 'bno-pair:' + imgFile.name + ':' + imgFile.size, name: f.name, image: f.pdf ? f.url : null,
        ocad: map ? { map, dpi: f.dpi, world } : null, world: map ? null : world });
    } catch (err) { say(err.message); }
  }

  // Kalibracja z samego pliku georeferencji obrazu (bez pliku OCAD).
  function attachWorld(wf) {
    const crs = BnoAlign.detectCrs({ x: wf.c, y: wf.f, realWorld: true, grid: 0 });
    if (!crs) { say('Plik georeferencji ma współrzędne w układzie, którego nie rozpoznaję – skalibruj mapę ręcznie.'); return; }
    pairs = [[0, 0], [W, 0], [0, H], [W, H]].map(([px, py]) => Object.assign(BnoAlign.tmInverse(wf.c + wf.a * px + wf.b * py, wf.f + wf.d * px + wf.e * py, crs), { px, py }));
    cal = fit(pairs); locked = true;
    $('lcaladd').hidden = true; $('lcalclear').hidden = true;
    ocadNote = `Kalibracja automatyczna z pliku georeferencji obrazu (${crs.name})` + resolveCourses(0, 0, 0) + '.';
    refresh();
  }
  let ocadNote = '';

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
    const wf = o.world, perMm = map.geo.scale / 1000; // metry terenu na milimetr mapy
    const exact = wf && Math.abs(map.geo.angle) < 0.01 && Math.abs(wf.b) < 1e-9 && Math.abs(wf.d) < 1e-9; // obraz ma własną georeferencję
    // 2. zgrubne położenie obrazu na całej mapie OCAD
    const over = BnoSymbols.build(map, 2400, symOverrides(setId), setId);
    const a1 = exact
      ? { scale: wf.a / perMm / (25.4 / dpi), x: (wf.c - wf.a / 2 - map.geo.x) / perMm - over.bounds.x0, y: over.bounds.y1 - (wf.f - wf.e / 2 - map.geo.y) / perMm, score: 1 }
      : BnoAlign.align(P, { cat: cats(over.cls), w: over.w, h: over.h, mm: 1 / over.k });
    if (!a1) throw new Error('Obraz jest większy niż mapa w pliku OCAD – to chyba nie ta sama mapa.');
    const mmImg = 25.4 / dpi * a1.scale; // ile mm mapy OCAD ma jeden piksel obrazu
    let left = over.bounds.x0 + a1.x, top = over.bounds.y1 - a1.y;
    // 3. dokładne położenie: mapa OCAD policzona gęsto tylko wokół obrazu
    const m = 4; // mm zapasu
    const fine = BnoSymbols.build(map, PROC_DIM, symOverrides(setId), setId, { x0: left - m, x1: left + W * mmImg + m, y0: top - H * mmImg - m, y1: top + m });
    const a2 = BnoAlign.align(P, { cat: cats(fine.cls), w: fine.w, h: fine.h, mm: 1 / fine.k }, [a1.scale]);
    if (!exact && a2 && a2.score >= a1.score - 0.05) { left = fine.bounds.x0 + a2.x; top = fine.bounds.y1 - a2.y; }
    const score = exact ? (a2 ? a2.score : 0) : a2 ? Math.max(a1.score, a2.score) : a1.score;
    mapScale = map.geo.scale;
    ocadCtx = { map, setId, region: { x0: left, x1: left + W * mmImg, y0: top - H * mmImg, y1: top } };
    proc = null;
    ensureProc();
    // 4. położenie na świecie z georeferencji pliku
    const crs = BnoAlign.detectCrs(map.geo);
    let note = `Mapa z pliku OCAD (${BnoSymbols.SETS[setId].name}, 1:${Math.round(map.geo.scale)}), `
      + (exact ? 'obraz osadzony według swojego pliku georeferencji' : 'obraz dopasowany automatycznie')
      + `: zgodność terenu ${Math.round(Math.max(0, score) * 100)}%`;
    if (o.dpi && Math.abs(a1.scale - 1) > 0.01) note += `, wydruk w skali 1:${Math.round(map.geo.scale / a1.scale)}`;
    if (!o.dpi) note += `, obraz ok. ${Math.round(300 / a1.scale)} dpi`;
    if (score < 0.35) note += '. UWAGA: słaba zgodność – sprawdź, czy obraz pochodzi z tego pliku OCAD';
    if (crs) {
      pairs = [[0, 0], [W, 0], [0, H], [W, H]].map(([px, py]) => Object.assign(BnoAlign.ocadToLatLon(map.geo, crs, left + px * mmImg, top - py * mmImg), { px, py }));
      cal = fit(pairs); locked = true;
      $('lcaladd').hidden = true; $('lcalclear').hidden = true;
      note += `. Kalibracja automatyczna z georeferencji (${crs.name})`;
      if (Math.abs(map.geo.angle) > 0.01) note += `; mapa obrócona o ${map.geo.angle.toFixed(1)}° – ten przypadek nie był sprawdzony w terenie`;
    } else note += '. Plik nie ma georeferencji w znanym układzie – skalibruj mapę ręcznie dwoma punktami';
    note += resolveCourses(left, top, mmImg);
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
      mapImage = opts.image || null; mapScale = +opts.scale || 0;
      reveal = false; shownRun = null; $('lresult').hidden = true;
      ocadCtx = null; ocadNote = ''; gridCtx = null; $('lmode').hidden = false;
      if (opts.grid) loadGrid(opts.grid);
      setCourses(opts.courses || []);
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
      fitView(); describe(); guide(); renderRuns();
      if (opts.world) attachWorld(opts.world);
      if (opts.ocad) {
        say('Dopasowuję obraz do mapy z pliku OCAD… (to może potrwać kilkanaście sekund)');
        setTimeout(() => { try { attachOcad(opts.ocad); } catch (err) { say('Nie udało się połączyć PDF-a z plikiem OCAD: ' + err.message); } }, 80);
      }
    };
    img.onerror = () => say(opts.preset ? 'Nie udało się pobrać mapy treningu. Sprawdź połączenie z internetem.' : 'Nie udało się wczytać tego pliku jako obrazu.');
    img.src = src;
  }

  window.BnoLive = {
    // dla zakładki "Generacja danych": wczytanie plików mapy (obraz/PDF + OCAD i/lub plik georeferencji)
    prepare(files, onStatus) {
      const isWorld = (f) => /\.(jgw|jpgw|pgw|pngw|tfw|wld)$/i.test(f.name), isOcd = (f) => /\.ocd$/i.test(f.name), isXml = (f) => /\.xml$/i.test(f.name);
      sayHook = onStatus;
      (async () => {
        // plik .ocd może być mapą albo projektem tras z OCAD Course Setting: rozróżniamy po nagłówku
        let ocd = null, courseSrc = files.find(isXml) || null;
        for (const f of files.filter(isOcd)) {
          if (BnoCourse.isCourseProject(await f.slice(0, 8).arrayBuffer())) { if (!courseSrc) courseSrc = f; } else if (!ocd) ocd = f;
        }
        const world = files.find(isWorld), other = files.find((f) => !isOcd(f) && !isWorld(f) && !isXml(f));
        if (!other) { say('Brakuje obrazu mapy: dołącz PDF albo JPG/PNG tej samej mapy.'); return; }
        openPair(ocd, other, world, courseSrc);
      })().catch((err) => say(err.message));
    },
    exportPackage,
    state: () => ({ loaded: !!W, calibrated: !!cal, ocad: !!ocadCtx, name: mapName, courses: courses.map((c) => c.name) }),
    openTraining(t) {
      say('Pobieram mapę treningu…');
      loadMap(t.plik, { key: 'trening:' + t.id, name: t.plik, title: t.nazwa, preset: t.kalibracja, mode: t.rodzaj, contour: t.ciecie, grid: t.siatka, scale: t.skala,
        courses: Array.isArray(t.trasy) ? t.trasy.map((c) => ({ name: c.nazwa, points: (c.punkty || []).map((p) => ({ x: +p.px, y: +p.py, type: p.typ, code: p.kod })) })) : [] });
    },
  };

  // Dla admina: dane skalibrowanej mapy w formacie wpisu do treningi/treningi.json.
  // Komplet plików treningu. Uczestnik dostaje gotowe: obraz do wyświetlenia, siatkę terenu (policzoną tu,
  // z pliku OCAD albo z obrazu) i kalibrację. Jego telefon niczego już nie analizuje.
  // meta: { nazwa, opis, miejsce, dojazd: {lat, lon} | null }. Zwraca { files: [{ name, label, url, size }], entry }.
  const EXPORT_DIM = 4000; // dłuższy bok publikowanego obrazu mapy
  const toBlob = (canvas, type, q) => new Promise((resolve) => canvas.toBlob(resolve, type, q));
  let exportUrls = [];
  async function exportPackage(meta) {
    if (!W) throw new Error('Najpierw wczytaj pliki mapy.');
    if (!cal) throw new Error('Mapa nie ma kalibracji. Dołącz plik OCAD albo plik georeferencji obrazu, albo skalibruj mapę ręcznie w zakładce „Na żywo”.');
    ensureProc();
    for (const u of exportUrls) URL.revokeObjectURL(u);
    exportUrls = [];
    const id = (meta.nazwa || mapName).replace(/\.[^.]+$/, '').toLowerCase().replace(/ł/g, 'l').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'mapa';
    // 1. obraz mapy jako JPG
    const es = Math.min(1, EXPORT_DIM / Math.max(W, H));
    const ic = document.createElement('canvas');
    ic.width = Math.round(W * es); ic.height = Math.round(H * es);
    const ig = ic.getContext('2d');
    ig.fillStyle = '#fff'; ig.fillRect(0, 0, ic.width, ic.height);
    ig.drawImage(img, 0, 0, ic.width, ic.height);
    // 2. siatka terenu jako PNG: kanał czerwony = kategoria terenu, zielony = warstwica
    const gc = document.createElement('canvas');
    gc.width = proc.w; gc.height = proc.h;
    const data = new ImageData(proc.w, proc.h);
    for (let i = 0; i < proc.cls.length; i++) { data.data[i * 4] = proc.cls[i]; data.data[i * 4 + 1] = proc.contour[i] ? 255 : 0; data.data[i * 4 + 3] = 255; }
    gc.getContext('2d').putImageData(data, 0, 0);
    const files = [];
    for (const [blob, name, label] of [[await toBlob(ic, 'image/jpeg', 0.88), id + '.jpg', 'obraz mapy'], [await toBlob(gc, 'image/png'), id + '.siatka.png', 'siatka terenu']]) {
      if (!blob) throw new Error('Przeglądarka nie zapisała pliku (za mało pamięci?).');
      const url = URL.createObjectURL(blob);
      exportUrls.push(url);
      files.push({ name, label, url, size: blob.size });
    }
    const r = (v, k) => Math.round(v * k) / k;
    const mid = pairs.reduce((acc, q) => ({ lat: acc.lat + q.lat / pairs.length, lon: acc.lon + q.lon / pairs.length }), { lat: 0, lon: 0 });
    const start = meta.dojazd || mid;
    const entry = {
      id,
      nazwa: meta.nazwa || 'NAZWA TRENINGU',
      opis: meta.opis || '',
      miejsce: meta.miejsce || '',
      dojazd: { lat: r(start.lat, 1e5), lon: r(start.lon, 1e5) },
      plik: 'treningi/' + id + '.jpg',
      siatka: 'treningi/' + id + '.siatka.png',
      skala: ocadCtx ? Math.round(ocadCtx.map.geo.scale) : undefined,
      rodzaj: ocadCtx ? (ocadCtx.map.geo.scale <= 5000 ? 'sprint' : 'forest') : $('lmode').value,
      ciecie: meta.ciecie != null ? meta.ciecie : parseFloat($('lcontour').value),
      zrodlo: ocadCtx ? 'OCAD' : 'obraz',
      trasy: courses.length ? courses.map((c) => ({ nazwa: c.name, punkty: c.points.map((p) => ({ px: r(p.x * es, 10), py: r(p.y * es, 10), typ: p.type, kod: p.code })) })) : undefined,
      kalibracja: pairs.map((q) => ({ lat: r(q.lat, 1e7), lon: r(q.lon, 1e7), px: r(q.px * es, 100), py: r(q.py * es, 100) })),
    };
    return { files, entry };
  }

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
      strokes.push([toMap(p)]);
    }
  });
  stage.addEventListener('pointermove', (e) => {
    if (!ptrs.has(e.pointerId) || !W) return;
    const prev = ptrs.get(e.pointerId), now = local(e);
    if (ptrs.size === 1 && tapMode === 'draw') {
      // jeden palec rysuje, dwa palce przesuwają i powiększają mapę
      const st = strokes[strokes.length - 1], q = toMap(now);
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
    if (ptrs.size === 0 && moved < 8 && Date.now() - downAt < 600 && W) { const m = toMap(p); tap(m.x, m.y); }
  });
  stage.addEventListener('pointercancel', (e) => ptrs.delete(e.pointerId));
  stage.addEventListener('wheel', (e) => {
    if (!W || stream) return;
    e.preventDefault();
    const p = local(e);
    zoomAt(p.x, p.y, e.deltaY < 0 ? 1.25 : 0.8);
    applyView();
  }, { passive: false });
  window.addEventListener('resize', () => { if (W) { if (needFit) fitView(); else applyView(); } });

  function tap(x, y) {
    if (!tapMode || tapMode === 'draw' || x < 0 || y < 0 || x > W || y > H) return;
    if (tapMode === 'target') {
      target = { x, y };
      if (course) { // stuknięcie przy punkcie trasy: cel wskakuje na jego środek, a "Następny punkt" liczy dalej od niego
        const reach = cal ? 15 * cal.pxPerM : Math.max(W, H) * 0.015;
        let best = -1, bd = reach;
        course.forEach((p, i) => { const d = Math.hypot(p.x - x, p.y - y); if (d < bd) { bd = d; best = i; } });
        if (best >= 0) { target = { x: course[best].x, y: course[best].y }; courseAt = best; showNext(); }
      }
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
    if (gridCtx) { // trening z gotową siatką terenu: nic nie trzeba liczyć
      proc = { k: gridCtx.w / W, w: gridCtx.w, h: gridCtx.h, cls: gridCtx.cls, cost: costGrid(gridCtx.cls, BnoStore.costs()), contour: gridCtx.contour };
      return;
    }
    if (ocadCtx) { // teren prosto z symboli OCAD-a, na siatce pokrywającej dokładnie wyświetlany obraz
      const grid = BnoSymbols.build(ocadCtx.map, PROC_DIM, symOverrides(ocadCtx.setId), ocadCtx.setId, ocadCtx.region);
      proc = { k: grid.w / W, w: grid.w, h: grid.h, cls: grid.cls, cost: costGrid(grid.cls, BnoStore.costs()), contour: grid.contour };
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
    proc = { k, w, h, cls: res.cls, cost: costGrid(res.cls, BnoStore.costs()), contour: res.contour };
  }

  function toRoute(part) {
    const pts = [];
    const path = part.path, step = Math.max(1, Math.round(path.length / 1500));
    for (let i = 0; i < path.length; i += step) pts.push({ x: (path[i] % proc.w + 0.5) / proc.k, y: (((path[i] / proc.w) | 0) + 0.5) / proc.k });
    pts.push({ x: target.x, y: target.y });
    const cum = [0];
    for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y));
    return { pts, cum, cost: part.cost, crossings: part.crossings, easy: part.easy };
  }

  // Przyciski wyboru wariantu (A = najszybszy, B i C = inne drogi, nie więcej niż 30% wolniejsze).
  // Kolor paska na przycisku = kolor linii na mapie: wybrany czerwony, pozostałe niebieski i pomarańczowy.
  let variantsKey = '';
  function renderVariants() {
    const len = (r) => (cal ? Math.round(r.cum[r.cum.length - 1] / cal.pxPerM / 10) * 10 : null);
    const key = routes.map((r) => len(r) + ':' + (r === route) + ':' + !!r.custom + ':' + r.crossings).join('|');
    if (key === variantsKey) return;
    variantsKey = key;
    const box = $('lvariants');
    box.replaceChildren();
    box.hidden = routes.length < 2 && !(route && route.custom);
    const base = BnoStore.summary().base;
    routes.forEach((r, i) => {
      const b = document.createElement('button');
      if (r.custom) b.textContent = 'Twoja trasa' + (len(r) == null ? '' : `: ${len(r)} m`);
      else {
        const slower = Math.round((r.cost / routes[0].cost - 1) * 100);
        // znamy Twoje tempo po ścieżce -> podajemy czas w minutach, inaczej tylko porównanie w procentach
        const secs = (x) => (base && cal ? x.cost / proc.k / cal.pxPerM * base : null);
        const speed = i === 0 ? (secs(r) == null ? 'najszybszy' : `ok. ${mmss(secs(r) * 1000)} · najszybszy`)
          : slower < 3 ? 'praktycznie tak samo szybki'
            : secs(r) == null ? `ok. ${slower}% wolniejszy` : `ok. +${mmss((secs(r) - secs(routes[0])) * 1000)} (${slower}%)`;
        b.textContent = `${'ABC'[i]}: ${len(r)} m` + (r.crossings == null ? '' : ` · ${r.crossings} warstw.`)
          + (r.easy == null ? '' : ` · łatwy teren ${Math.round(r.easy * 100)}%`) + ' · ' + speed;
      }
      b.classList.toggle('on', r === route);
      const k = routes.filter((x) => x !== route).indexOf(r);
      b.style.borderLeft = '6px solid ' + (r === route ? '#e53935' : ALT_COLORS[k] || '#888');
      b.addEventListener('click', () => { route = r; refresh(); });
      box.append(b);
    });
  }

  function computeRoute() {
    route = null; routes = [];
    const pos = position();
    if (!target) { refresh(); return; }
    if (help !== 'full') { routeNote = ''; refresh(); return; } // sam kierunek albo sama mapa: wariantu nie liczymy
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
        const leg = routeLeg(proc.cost, proc.w, proc.h, a, b, climbCfg());
        routeAt = Date.now();
        if (!leg.best) {
          routeNote = 'Nie znajduję przejścia do celu (teren nie do przejścia) – strzałka pokazuje kierunek na wprost.';
        } else {
          routes = leg.variants.map(toRoute);
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
    if (help !== 'full' || (route && route.custom)) return; // własnej trasy nie poprawiamy, a bez wariantu nie ma czego
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
    if (!target || !pos || hidden()) return null;
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
      if (g.arrived) text = stream ? 'Jesteś przy punkcie – szukaj lampionu.' : 'Jesteś przy punkcie.';
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
        if (!route && help === 'full') text += ' · brak trasy, kierunek prosto na cel';
        if (routeNote) text += ' · ' + routeNote;
      }
    } else if (!target && W) text = '';
    if (hidden() && target) text = 'Sama mapa: znajdź punkt. Apka potwierdzi go sygnałem, gdy dobiegniesz.';
    $('lguide').textContent = text;
    $('lartext').textContent = text || 'Ustaw cel na mapie, żeby zobaczyć strzałkę.';

    drawGround(g); // wstęga trasy na ziemi i lampion przy celu
    $('larnext').hidden = !(stream && course && g && g.arrived && (courseAt < course.length - 1 || run));
    const show = stream && rel != null && !(g && g.arrived);
    $('lararrow').hidden = !show || arMode === 'ribbon';
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

  // ---------- rysowanie "na ziemi": wstęga trasy i lampion ----------
  // Prosty model kamery: telefon trzymany pionowo na wysokości CAM_H, patrzy w kierunku kompasu, pochylony
  // w dół o (90 - pitch) stopni, teren płaski. Dokładność zależy od GPS i kompasu, więc to wskazówka, nie pomiar.
  const CAM_H = 1.4;        // wysokość telefonu nad ziemią [m]
  const FLAG_RANGE_M = 15;  // z tej odległości widać lampion przy celu
  const RIBBON_M = 60;      // tyle metrów trasy przed Tobą rysuje wstęga
  let arMode = 'arrow';
  try { if (localStorage.getItem('bno-ar') === 'ribbon') arMode = 'ribbon'; } catch (err) { /* nieistotne */ }
  const showArMode = () => { $('larmode').textContent = arMode === 'ribbon' ? 'Tryb: wstęga' : 'Tryb: strzałka'; };
  showArMode();
  $('larmode').addEventListener('click', () => {
    arMode = arMode === 'ribbon' ? 'arrow' : 'ribbon';
    try { localStorage.setItem('bno-ar', arMode); } catch (err) { /* jw. */ }
    showArMode(); guide();
  });

  // Punkt na ziemi (albo "up" metrów nad nią) w odległości dist i kierunku bearing -> piksel ekranu albo null.
  function toScreen(view, bearing, dist, up) {
    const th = (bearing - heading) * Math.PI / 180;
    const f = dist * Math.cos(th), r = dist * Math.sin(th), down = CAM_H - (up || 0);
    const z = f * view.cos + down * view.sin;        // odległość wzdłuż osi kamery
    if (z < 0.6) return null;                        // za plecami albo tuż pod nogami
    const y = -f * view.sin + down * view.cos;       // w dół obrazu
    return { x: view.w / 2 + r / z * view.f, y: view.h / 2 + y / z * view.f, z };
  }

  function drawGround(g) {
    const cv = $('larcanvas');
    if (!stream) return;
    const rect = stage.getBoundingClientRect(), dpr = Math.min(2, window.devicePixelRatio || 1);
    if (cv.width !== Math.round(rect.width * dpr) || cv.height !== Math.round(rect.height * dpr)) { cv.width = Math.round(rect.width * dpr); cv.height = Math.round(rect.height * dpr); }
    const c = cv.getContext('2d');
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.clearRect(0, 0, rect.width, rect.height);
    const pos = position();
    if (!g || !pos || heading == null) return;
    const depress = Math.max(-20, Math.min(80, 90 - (pitch == null ? 75 : pitch))) * Math.PI / 180;
    const view = { w: rect.width, h: rect.height, f: rect.width / 2 / Math.tan(CAM_HFOV / 2 * Math.PI / 180), cos: Math.cos(depress), sin: Math.sin(depress) };
    const polar = (p) => ({ bearing: bearingOf(cal, p.x - pos.x, p.y - pos.y), dist: Math.hypot(p.x - pos.x, p.y - pos.y) / cal.pxPerM });
    const straight = polar(target);

    if (arMode === 'ribbon' && !g.arrived) {
      // punkty trasy co 2 m, od Twojego miejsca na trasie do RIBBON_M przed Tobą (bez trasy: prosto na cel)
      const pts = [];
      if (route) {
        const k = cal.pxPerM, m = matchRoute(pos), total = route.cum[route.cum.length - 1];
        for (let d = 0; d <= RIBBON_M && m.c + d * k <= total + 2 * k; d += 2) pts.push(polar(pointAt(route, m.c + d * k)));
      } else for (let d = 2; d <= Math.min(RIBBON_M, straight.dist); d += 2) pts.push({ bearing: straight.bearing, dist: d });
      const scr = pts.map((p) => toScreen(view, p.bearing, Math.max(p.dist, 0.01), 0));
      // pierwszy nieprzerwany widoczny odcinek rysujemy jako jeden pas: szeroki blisko, zwężający się w dal
      const run = [];
      for (const q of scr) { if (q) run.push(q); else if (run.length) break; }
      if (run.length > 1) {
        const band = (half) => {
          const left = [], right = [];
          run.forEach((q, i) => {
            const a = run[Math.max(0, i - 1)], b = run[Math.min(run.length - 1, i + 1)];
            const len = Math.hypot(b.x - a.x, b.y - a.y) || 1, nx = -(b.y - a.y) / len, ny = (b.x - a.x) / len;
            const hw = Math.max(1.5, half * view.f / q.z); // pół szerokości pasa w pikselach
            left.push([q.x + nx * hw, q.y + ny * hw]); right.push([q.x - nx * hw, q.y - ny * hw]);
          });
          c.beginPath();
          left.concat(right.reverse()).forEach((pt, i) => (i ? c.lineTo(pt[0], pt[1]) : c.moveTo(pt[0], pt[1])));
          c.closePath(); c.fill();
        };
        c.fillStyle = 'rgba(255,255,255,0.8)'; band(0.45);
        c.fillStyle = 'rgba(229,57,53,0.88)'; band(0.33);
      }
    }

    if (straight.dist <= FLAG_RANGE_M) drawFlag(c, view, straight);
  }

  // Lampion punktu kontrolnego: biało-pomarańczowy kwadrat 30 cm na stojaku, w miejscu celu.
  function drawFlag(c, view, at) {
    const dist = Math.max(at.dist, 1.5);
    const top = toScreen(view, at.bearing, dist, 1.0), foot = toScreen(view, at.bearing, dist, 0);
    if (!top) { // cel za plecami albo poza kadrem: mały lampion przy krawędzi ekranu po właściwej stronie
      const rel = ((at.bearing - heading + 540) % 360) - 180;
      paintFlag(c, rel > 0 ? view.w - 34 : 34, view.h * 0.5, 40);
      return;
    }
    const size = Math.max(34, Math.min(view.h * 0.45, 0.3 * view.f / top.z)); // bok lampionu w pikselach
    const x = Math.max(size / 2 + 6, Math.min(view.w - size / 2 - 6, top.x)), y = Math.max(size / 2 + 60, Math.min(view.h - size, top.y));
    if (foot && x === top.x) { // stojak od ziemi do lampionu
      c.strokeStyle = 'rgba(255,255,255,0.95)'; c.lineWidth = Math.max(3, size * 0.09);
      c.beginPath(); c.moveTo(foot.x, foot.y); c.lineTo(x, y + size / 2); c.stroke();
      c.strokeStyle = '#444'; c.lineWidth = Math.max(1.5, size * 0.045);
      c.beginPath(); c.moveTo(foot.x, foot.y); c.lineTo(x, y + size / 2); c.stroke();
    }
    paintFlag(c, x, y, size);
  }

  function paintFlag(c, x, y, size) {
    const h = size / 2;
    c.save();
    c.shadowColor = 'rgba(0,0,0,0.45)'; c.shadowBlur = size * 0.15; c.shadowOffsetY = size * 0.05;
    c.fillStyle = '#fff';
    c.fillRect(x - h, y - h, size, size);
    c.restore();
    c.fillStyle = '#f26b1d'; // pomarańczowa połowa po przekątnej, jak na lampionie
    c.beginPath(); c.moveTo(x + h, y - h); c.lineTo(x + h, y + h); c.lineTo(x - h, y + h); c.closePath(); c.fill();
    c.strokeStyle = 'rgba(40,40,40,0.9)'; c.lineWidth = Math.max(1.5, size * 0.035);
    c.strokeRect(x - h, y - h, size, size);
  }

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

  // ---------- sposób prowadzenia ----------
  // full = wariant i strzałka po nim, dir = sam kierunek i odległość do punktu, map = sama mapa bez pozycji
  function hidden() { return help === 'map' && !reveal; }
  $('lhelp').value = help;
  $('lhelp').addEventListener('change', () => {
    help = $('lhelp').value;
    try { localStorage.setItem('bno-help', help); } catch (err) { /* nieistotne */ }
    route = null; routes = []; routeNote = '';
    if (help === 'full' && target) computeRoute(); else refresh();
  });

  // ---------- obracanie mapy zgodnie z kierunkiem patrzenia ----------
  const showRot = () => { $('lrot').textContent = rotOn ? 'Obrót mapy: wł.' : 'Obrót mapy: wył.'; $('lrot').classList.toggle('on', rotOn); };
  showRot();
  $('lrot').addEventListener('click', () => {
    rotOn = !rotOn;
    try { localStorage.setItem('bno-rot', rotOn ? '1' : '0'); } catch (err) { /* jw. */ }
    if (rotOn) startCompass();
    showRot(); refresh();
  });

  // ---------- sygnał zaliczenia punktu ----------
  let audio = null;
  function initSound() { // przeglądarka pozwala włączyć dźwięk tylko po dotknięciu ekranu
    try {
      if (!audio) audio = new (window.AudioContext || window.webkitAudioContext)();
      if (audio.state === 'suspended') audio.resume();
    } catch (err) { /* zostaje wibracja */ }
  }
  function signal() {
    try { if (navigator.vibrate) navigator.vibrate([150, 80, 150]); } catch (err) { /* brak wibracji */ }
    if (!audio) return;
    try {
      [0, 0.18].forEach((d, i) => {
        const o = audio.createOscillator(), g = audio.createGain();
        o.frequency.value = i ? 1320 : 990; g.gain.value = 0.25;
        o.connect(g); g.connect(audio.destination);
        o.start(audio.currentTime + d); o.stop(audio.currentTime + d + 0.14);
      });
    } catch (err) { /* jw. */ }
  }

  // ---------- bieg po trasie: start, zaliczanie punktów, międzyczasy ----------
  const mmss = (ms) => {
    const t = Math.max(0, Math.round(ms / 1000)), m = Math.floor(t / 60);
    return (m >= 60 ? Math.floor(m / 60) + ':' + String(m % 60).padStart(2, '0') : m) + ':' + String(t % 60).padStart(2, '0');
  };
  let runTimer = null;
  function tickRun() {
    $('lrun').hidden = !run;
    if (run) $('lruntext').textContent = 'Czas ' + mmss(Date.now() - run.t0);
  }
  function dropRun() {
    if (runTimer) { clearInterval(runTimer); runTimer = null; }
    run = null;
    tickRun();
  }
  function startRun() {
    reveal = false; shownRun = null; track = [];
    $('lresult').hidden = true;
    run = { t0: Date.now(), key: mapKey, title: $('ltitle').textContent || mapName, course: courseName, splits: [], track: [] };
    if (course[0].type === 'start') run.splits.push({ i: 0, type: 'start', code: course[0].code, t: 0 });
    lastPunch = Date.now();
    runTimer = setInterval(tickRun, 1000);
    tickRun();
  }
  function split(auto) {
    const c = course[courseAt];
    run.splits.push({ i: courseAt, type: c.type, code: c.code, t: Date.now() - run.t0, auto });
    lastPunch = Date.now();
    signal();
  }
  function advance() {
    courseAt++;
    if (course[courseAt].type === 'start' && courseAt < course.length - 1) courseAt++; // ze startu od razu na pierwszy punkt
    target = { x: course[courseAt].x, y: course[courseAt].y };
    showNext();
    setTapMode(null);
    computeRoute();
  }
  function showNext() {
    const b = $('lnext');
    b.hidden = !course;
    if (!course) return;
    const n = course.filter((p) => p.type !== 'start').length;
    const done = course.slice(0, courseAt + 1).filter((p) => p.type !== 'start').length;
    const last = courseAt >= course.length - 1;
    b.textContent = !run && courseAt < 0 ? 'Start' : last ? (run ? 'Zalicz metę ręcznie' : 'Trasa ukończona') : run ? `Zalicz punkt ${done} ręcznie` : `Następny punkt (${done + 1}/${n})`;
    b.disabled = last && !run;
    $('larnext').textContent = b.textContent;
  }
  // Przycisk: przed biegiem startuje zegar, w biegu ręcznie zalicza punkt, do którego biegniesz (gdy GPS go nie złapał).
  function nextControl() {
    if (!course) return;
    const last = courseAt >= course.length - 1;
    if (last && !run) return;
    initSound();
    if (!run) startRun(); else if (courseAt >= 0) split(false);
    if (last) { finishRun(false); return; }
    advance();
  }
  // Dobiegłeś do punktu, na który biegniesz: zaliczamy go sami i ustawiamy następny.
  function autoPunch() {
    if (!run || !course || courseAt < 0 || !cal || !fix || !target) return;
    const c = course[courseAt];
    if (target.x !== c.x || target.y !== c.y || Date.now() - lastPunch < 3000) return;
    const p = toPixel(cal, fix.lat, fix.lon);
    if (Math.hypot(p.x - c.x, p.y - c.y) / cal.pxPerM > Math.max(PUNCH_M, Math.min(fix.acc, 20))) return;
    split(true);
    if (courseAt >= course.length - 1) finishRun(false); else advance();
  }
  $('lnext').addEventListener('click', nextControl);
  $('larnext').addEventListener('click', nextControl);

  function climbCfg() { // jedno przecięcie warstwicy = pół cięcia w górę = (cięcie / 2) * przelicznik metrów po płaskim
    const interval = parseFloat($('lcontour').value);
    return interval > 0 && cal ? { contour: proc.contour, perCrossing: interval / 2 * BnoStore.climbFactor() * cal.pxPerM * proc.k } : null;
  }
  // Długość najszybszego wariantu apki między dwoma punktami trasy, w metrach (null = nie da się policzyć).
  function legLength(p, q) {
    try {
      ensureProc();
      const clamp = (v, m) => Math.min(m - 1, Math.max(0, Math.round(v)));
      const leg = routeLeg(proc.cost, proc.w, proc.h, { x: clamp(p.x * proc.k, proc.w), y: clamp(p.y * proc.k, proc.h) },
        { x: clamp(q.x * proc.k, proc.w), y: clamp(q.y * proc.k, proc.h) }, climbCfg());
      if (!leg.best) return null;
      const path = leg.best.path;
      let len = 0;
      for (let i = 1; i < path.length; i++) len += Math.hypot(path[i] % proc.w - path[i - 1] % proc.w, ((path[i] / proc.w) | 0) - ((path[i - 1] / proc.w) | 0));
      return Math.round(len / proc.k / cal.pxPerM);
    } catch (err) { return null; }
  }
  const ll = (p) => ({ lat: p[0], lon: p[1] });
  function summarise(r, ctrl) {
    const splits = r.splits.slice(), trk = r.track;
    if (!splits.length || splits[0].type !== 'start') splits.unshift({ i: -1, type: 'start', t: 0, free: true });
    const label = (sp) => (sp.free ? 'początek' : sp.type === 'start' ? 'start' : sp.type === 'meta' ? 'meta'
      : String(ctrl.slice(0, sp.i + 1).filter((c) => c.type === 'punkt').length));
    const legs = [];
    for (let k = 1; k < splits.length; k++) {
      const a = splits[k - 1], b = splits[k];
      let ran = 0;
      for (let q = 1; q < trk.length; q++) if (trk[q - 1][2] >= a.t / 1000 && trk[q][2] <= b.t / 1000) ran += distance(ll(trk[q - 1]), ll(trk[q]));
      legs.push({ name: label(a) + ' → ' + label(b), time: b.t - a.t, ran: Math.round(ran), opt: a.free ? null : legLength(ctrl[a.i], ctrl[b.i]), auto: !!b.auto });
    }
    return legs;
  }

  // Odcinki śladu do nauki własnego tempa: kawałki po 25–40 m w jednym rodzaju terenu, tylko z dobrym GPS i w ruchu.
  // Blisko ścieżki (w zasięgu błędu GPS) przyjmujemy, że biegłeś ścieżką; na granicy dwóch terenów odcinek odpada.
  function paceWindows(trk, interval) {
    const out = [];
    if (!proc || !cal) return out;
    const TR = BnoCore.TERRAIN, k = proc.k, rad = 6 * cal.pxPerM * k;
    const TRAIL = new Set([T.PATH, T.PAVED, T.PATH2, T.PATH3, T.PATH4]);
    const at = (x, y) => (x < 0 || y < 0 || x >= proc.w || y >= proc.h ? -1 : proc.cls[(y | 0) * proc.w + (x | 0)]);
    const classOf = (x, y) => {
      const c0 = at(x, y);
      if (c0 < 0) return -1;
      let trail = TRAIL.has(c0) ? c0 : -1, same = true;
      for (const f of [0.5, 1]) for (let a = 0; a < 8; a++) {
        const c = at(x + Math.cos(a * Math.PI / 4) * rad * f, y + Math.sin(a * Math.PI / 4) * rad * f);
        if (TRAIL.has(c) && (trail < 0 || TR[c].cost < TR[trail].cost)) trail = c;
        if (c !== c0) same = false;
      }
      return trail >= 0 ? trail : same && TR[c0].cost !== Infinity && !TR[c0].internal ? c0 : -1;
    };
    const crossings = (a, b) => {
      const n = Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) * k);
      let cnt = 0, was = false;
      for (let i = 0; i <= n; i++) {
        const t = n ? i / n : 0, x = (a.x + (b.x - a.x) * t) * k, y = (a.y + (b.y - a.y) * t) * k;
        const on = x >= 0 && y >= 0 && x < proc.w && y < proc.h && !!proc.contour[(y | 0) * proc.w + (x | 0)];
        if (on && !was && i) cnt++;
        was = on;
      }
      return cnt;
    };
    let w = null;
    const flush = () => { if (w && w.d >= 25) out.push(w); w = null; };
    for (let i = 1; i < trk.length; i++) {
      const a = trk[i - 1], b = trk[i], dt = b[2] - a[2], d = distance(ll(a), ll(b));
      if (!(dt > 0.3 && dt <= 10) || a[3] > 15 || b[3] > 15 || d / dt < 0.7 || d / dt > 8) { flush(); continue; }
      const pa = toPixel(cal, a[0], a[1]), pb = toPixel(cal, b[0], b[1]);
      const cls = classOf((pa.x + pb.x) / 2 * k, (pa.y + pb.y) / 2 * k);
      if (cls < 0) { flush(); continue; }
      if (w && w.cls !== cls) flush();
      if (!w) w = { cls, d: 0, t: 0, cross: 0 };
      w.d += d; w.t += dt; w.cross += interval > 0 ? crossings(pa, pb) : 0;
      if (w.d >= 40) flush();
    }
    flush();
    return out;
  }

  function finishRun(partial) {
    const r = run, ctrl = course;
    dropRun();
    reveal = true;
    const total = partial || !r.splits.length ? Date.now() - r.t0 : r.splits[r.splits.length - 1].t;
    courseAt = -1; target = null; route = null; routes = []; routeNote = '';
    showNext(); refresh();
    if (r.track.length < 2 && r.splits.length < 2) return; // nic się nie wydarzyło
    $('lresult').hidden = false; $('lresult').textContent = 'Liczę podsumowanie biegu…';
    setTimeout(() => {
      const legs = summarise(r, ctrl), interval = parseFloat($('lcontour').value) || 0;
      let learned = 0;
      try {
        ensureProc();
        const win = paceWindows(r.track, interval);
        learned = win.reduce((sum, w) => sum + w.d, 0);
        BnoStore.addWindows(win, interval);
      } catch (err) { /* bez terenu nie uczymy się tempa */ }
      const stored = { id: r.t0, key: r.key, title: r.title, course: r.course, total, partial: !!partial, legs, learned: Math.round(learned),
        track: r.track.map((p) => [Math.round(p[0] * 1e6) / 1e6, Math.round(p[1] * 1e6) / 1e6, Math.round(p[2])]) };
      BnoStore.saveRun(stored);
      showRun(stored);
    }, 60);
  }
  function twoTap(b, fn) { // przyciski, których nie chcesz nacisnąć przypadkiem w biegu
    const label = b.textContent;
    b.addEventListener('click', () => {
      if (b.dataset.armed !== '1') {
        b.dataset.armed = '1'; b.textContent = 'Na pewno?';
        setTimeout(() => { b.dataset.armed = ''; b.textContent = label; }, 3000);
        return;
      }
      b.dataset.armed = ''; b.textContent = label;
      fn();
    });
  }
  twoTap($('lrunstop'), () => { if (run) finishRun(true); });

  // ---------- podsumowanie, lista przebiegów, GPX ----------
  function download(name, text, type) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type }));
    a.download = name;
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  }
  function saveGpx(r) {
    const esc = (t) => String(t || '').replace(/[<>&"]/g, (ch) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[ch]));
    const pts = r.track.map((p) => `<trkpt lat="${p[0]}" lon="${p[1]}"><time>${new Date(r.id + p[2] * 1000).toISOString()}</time></trkpt>`).join('\n');
    const day = new Date(r.id).toISOString().slice(0, 10);
    download(`bno-${day}.gpx`, `<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1" creator="BKS Wataha BnO" xmlns="http://www.topografix.com/GPX/1/1">\n<metadata><time>${new Date(r.id).toISOString()}</time></metadata>\n<trk><name>${esc((r.title || 'Trening') + (r.course ? ' – ' + r.course : ''))}</name><type>running</type><trkseg>\n${pts}\n</trkseg></trk>\n</gpx>\n`, 'application/gpx+xml');
  }
  const mk = (tag, text, cls) => { const e = document.createElement(tag); if (text != null) e.textContent = text; if (cls) e.className = cls; return e; };
  const when = (r) => new Date(r.id).toLocaleString('pl-PL', { day: 'numeric', month: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  function showRun(r) {
    shownRun = r; reveal = true;
    track = r.track.map(ll);
    const box = $('lresult');
    box.hidden = false; box.replaceChildren();
    box.append(mk('h3', `${r.course ? 'Trasa ' + r.course : 'Bieg'} · ${when(r)} · czas ${mmss(r.total)}` + (r.partial ? ' (przerwany)' : '')));
    if (r.legs.length) {
      const wrap = mk('div', null, 'tablewrap'), table = mk('table'), head = mk('tr'), body = mk('tbody');
      for (const h of ['Odcinek', 'Czas', 'Przebiegłeś', 'Wariant apki', 'Nadłożone']) head.append(mk('th', h));
      const thead = mk('thead'); thead.append(head);
      let ran = 0, opt = 0, known = true;
      for (const l of r.legs) {
        const tr = mk('tr');
        const extra = l.opt == null ? '—' : l.ran > l.opt ? `+${l.ran - l.opt} m` : '0 m';
        for (const v of [l.name + (l.auto ? '' : ' ✋'), mmss(l.time), l.ran + ' m', l.opt == null ? '—' : l.opt + ' m', extra]) tr.append(mk('td', v));
        body.append(tr);
        ran += l.ran; if (l.opt == null) known = false; else opt += l.opt;
      }
      const sum = mk('tr');
      for (const v of ['Razem', mmss(r.total), ran + ' m', known ? opt + ' m' : '—', known ? (ran > opt ? `+${ran - opt} m` : '0 m') : '—']) sum.append(mk('th', v));
      body.append(sum);
      table.append(thead, body); wrap.append(table); box.append(wrap);
    }
    box.append(mk('p', 'Niebieska linia na mapie to Twój ślad. „Wariant apki” to długość najszybszej drogi między punktami według założeń; ✋ oznacza punkt zaliczony ręcznie.'
      + (r.learned ? ` Do Twojego tempa doszło ${r.learned} m pomiaru.` : ''), 'note'));
    const row = mk('div', null, 'tools'), g = mk('button', 'Pobierz ślad GPX'), close = mk('button', 'Zamknij podsumowanie');
    g.addEventListener('click', () => saveGpx(r));
    close.addEventListener('click', () => { box.hidden = true; shownRun = null; track = []; refresh(); });
    row.append(g, close); box.append(row);
    renderRuns(); refresh();
  }
  function renderRuns() {
    const list = BnoStore.runs().filter((r) => r.key === mapKey).reverse();
    $('lruns').hidden = !list.length;
    const box = $('lrunlist');
    box.replaceChildren();
    for (const r of list) {
      const row = mk('div', null, 'tools');
      row.append(mk('span', `${when(r)} · ${r.course || 'bez trasy'} · ${mmss(r.total)}` + (r.partial ? ' (przerwany)' : '')));
      const show = mk('button', 'Pokaż'), g = mk('button', 'GPX'), del = mk('button', 'Usuń');
      show.addEventListener('click', () => { showRun(r); $('lresult').scrollIntoView({ block: 'nearest' }); });
      g.addEventListener('click', () => saveGpx(r));
      twoTap(del, () => { if (shownRun && shownRun.id === r.id) { $('lresult').hidden = true; shownRun = null; track = []; } BnoStore.deleteRun(r.id); refresh(); });
      row.append(show, g, del); box.append(row);
    }
  }
  // zmieniło się własne tempo albo lista przebiegów (także w zakładce „Założenia”)
  window.addEventListener('bno-store', () => {
    if (proc) proc.cost = costGrid(proc.cls, BnoStore.costs());
    renderRuns();
    if (target && help === 'full' && !(route && route.custom) && !run) computeRoute();
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
    const tilted = typeof e.beta === 'number' && (pitch == null || Math.abs(e.beta - pitch) > 1.5);
    if (tilted) pitch = e.beta;
    if (heading == null || Math.abs(((h - heading + 540) % 360) - 180) > 1.5 || (tilted && stream)) {
      heading = h;
      updateRot(); applyView(); guide();
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
    startCompass(); initSound();
    if (navigator.wakeLock) navigator.wakeLock.request('screen').then((w) => { wake = w; }).catch(() => {});
    watchId = navigator.geolocation.watchPosition((p) => {
      fix = { lat: p.coords.latitude, lon: p.coords.longitude, acc: p.coords.accuracy };
      const last = track[track.length - 1];
      if (!last || distance(last, fix) > 4) {
        track.push({ lat: fix.lat, lon: fix.lon });
        if (track.length > 5000) track.shift();
      }
      if (run) {
        if (run.track.length < 30000) run.track.push([fix.lat, fix.lon, (Date.now() - run.t0) / 1000, fix.acc]);
        autoPunch();
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

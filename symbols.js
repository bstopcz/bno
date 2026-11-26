// Znaczenie symboli map do BnO (numery wg specyfikacji IOF) i zamiana obiektów z pliku OCAD na siatkę terenu.
// Każdy symbol dostaje "rodzaj": klasę terenu z core.js oraz sposób nanoszenia (powierzchnia, nakładka, linia...).
(function (root) {
  'use strict';
  const { T, TERRAIN } = root.BnoCore;

  // Sposoby nanoszenia, w kolejności rysowania (późniejsze przykrywają wcześniejsze):
  //  area     - powierzchnia zastępuje to, co było (otwarte, las, zieleń, utwardzone)
  //  overlay  - nakładka: zmienia pole tylko, gdy jest wolniejsza niż to, co już tam jest (podszyt, bagno, kamienie)
  //  hard     - powierzchnia nie do przejścia albo woda (zastępuje wszystko poza budynkami)
  //  slowline - linia do przekroczenia z karą (strumień, skarpa, płot do przejścia)
  //  path     - ścieżka / droga (zastępuje teren, także zakazany: droga przez osiedle jest dozwolona)
  //  wall     - linia nie do przejścia (przykrywa także ścieżki)
  //  gap      - przejście przez przeszkodę (punkt przejścia, most)
  //  oob      - nadruk trasy: teren lub granica wyłączona
  //  contour  - warstwica (nie zmienia terenu, liczy się do przewyższeń)
  const K = (cls, mode, widthM) => ({ cls, mode, widthM: widthM || 0 });
  const KIND = {
    contour: { mode: 'contour' },
    open: K(T.OPEN, 'area'), rough: K(T.ROUGH, 'area'), forest: K(T.FOREST, 'area'),
    slow: K(T.GREEN1, 'area'), walk: K(T.GREEN2, 'area'), fight: K(T.GREEN3, 'area'),
    cult: K(T.CULT, 'area'), paved: K(T.PAVED, 'area'), barerock: K(T.OPEN, 'area'),
    under1: K(T.UNDER1, 'overlay'), under2: K(T.UNDER2, 'overlay'), marsh: K(T.MARSH, 'overlay'),
    softmarsh: K(T.UNDER1, 'overlay'), stony: K(T.STONY, 'overlay'), boulders: K(T.BOULDERS, 'overlay'),
    sand: K(T.UNDER1, 'overlay'), stonyfight: K(T.GREEN3, 'overlay'),
    lake: K(T.LAKE, 'hard'), shallow: K(T.WATER, 'hard'), impveg: K(T.IMPVEG, 'hard'),
    forbidden: K(T.FORBIDDEN, 'hard'), building: K(T.BUILDING, 'hard'), canopy: K(T.PAVED, 'hard'),
    rockarea: K(T.CLIFF, 'hard'), obstarea: K(T.OBST, 'hard'),
    stream: K(T.STREAM, 'slowline', 2), ditch: K(T.DITCH, 'slowline', 1.5), bank: K(T.OBST, 'slowline', 2),
    lowobst: K(T.DITCH, 'slowline', 1.5), fence: K(T.FENCE, 'slowline', 1.5), marshline: K(T.MARSH, 'slowline', 3),
    road: K(T.PATH, 'path', 4), track: K(T.PATH, 'path', 3), footpath: K(T.PATH2, 'path', 2),
    smallpath: K(T.PATH3, 'path', 1.5), faintpath: K(T.PATH4, 'path', 1.5), ride: K(T.PATH4, 'path', 2),
    cliff: K(T.CLIFF, 'wall', 2.5), wall: K(T.WALL, 'wall', 2), riverline: K(T.LAKE, 'wall', 2.5),
    crossing: K(T.PATH2, 'gap', 4), bridge: K(T.PATH, 'gap', 3),
    oob: K(T.OOB, 'oob'), oobline: K(T.OOB, 'oob', 2),
    ignore: { mode: 'ignore' },
  };
  const ORDER = ['area', 'overlay', 'hard', 'slowline', 'path', 'wall', 'gap', 'oob'];

  // ---- tabele symboli: numer główny -> rodzaj (opcjonalnie osobno dla linii / powierzchni) ----
  // Źródła: wiki IOF ze specyfikacjami ISOM 2017-2 i ISSprOM 2019-2 (rewizja 6, 2024), Przepisy IOF 17.2
  // oraz zestawy symboli OpenOrienteering dla ISOM 2000 i ISSOM 2007 (z tabelami przenumerowania).
  // 'pavedline': droga utwardzona narysowana linią (gruba) albo tylko krawędź/stopień nawierzchni (cienka).
  const PAVED = { area: 'paved', line: 'pavedline' };
  const WATERX = { area: 'lake', line: 'riverline' };

  // ISOM 2017-2 (las)
  const ISOM2017 = {
    101: 'contour', 102: 'contour', 103: 'ignore', 104: 'bank', 105: 'lowobst', 106: 'ignore', 107: 'bank', 108: 'lowobst',
    113: 'ignore', 114: 'stony',
    201: 'cliff', 202: 'bank', 206: 'rockarea', 208: 'ignore', 209: 'stony', 210: 'under1', 211: 'boulders', 212: 'stonyfight',
    213: 'sand', 214: 'barerock', 215: 'bank',
    301: WATERX, 302: 'shallow', 304: 'stream', 305: 'ditch', 306: 'ignore', 307: WATERX, 308: 'marsh', 309: 'marshline', 310: 'softmarsh',
    401: 'open', 402: 'open', 403: 'rough', 404: 'rough', 405: 'forest', 406: 'slow', 407: 'under1', 408: 'walk', 409: 'under2', 410: 'fight',
    411: 'impveg', 412: 'cult', 413: 'cult', 414: 'cult',
    501: PAVED, 502: 'road', 503: 'road', 504: 'track', 505: 'footpath', 506: 'smallpath', 507: 'faintpath', 508: 'ride',
    512: 'bridge', 513: 'fence', 514: 'lowobst', 515: 'wall', 516: 'fence', 517: 'lowobst', 518: 'wall', 519: 'crossing',
    520: 'forbidden', 521: 'building', 522: 'canopy', 529: 'wall', 532: { line: 'footpath', area: 'paved' },
    708: 'oobline', 709: 'oob', 710: 'crossing', 714: 'oob',
  };
  // ISSprOM 2019-2 (sprint): ta sama numeracja, inne znaczenie kilku symboli
  const ISSPROM2019 = Object.assign({}, ISOM2017, {
    208: 'stony', 210: 'stony', 533: 'under1',
  });
  // ISOM 2000 (las, dawna numeracja)
  const ISOM2000 = {
    101: 'contour', 102: 'contour', 103: 'ignore', 106: 'bank', 107: 'lowobst', 108: 'lowobst', 109: 'bank', 110: 'lowobst',
    201: 'cliff', 202: 'rockarea', 203: 'bank', 208: 'stony', 210: 'stony', 211: 'sand', 212: 'barerock',
    301: WATERX, 302: 'lake', 304: WATERX, 305: 'stream', 306: 'ditch', 307: 'ignore', 308: 'marshline', 309: WATERX, 310: 'marsh', 311: 'softmarsh',
    401: 'open', 402: 'open', 403: 'rough', 404: 'rough', 405: 'forest', 406: 'slow', 407: 'under1', 408: 'walk', 409: 'under2', 410: 'fight',
    411: 'slow', 412: 'cult', 413: 'cult', 415: 'cult',
    501: 'road', 502: 'road', 503: 'road', 504: 'road', 505: 'track', 506: 'footpath', 507: 'smallpath', 508: 'faintpath', 509: 'ride',
    512: 'crossing', 518: 'bridge', 519: 'fence', 520: 'lowobst', 521: 'wall', 522: 'fence', 523: 'lowobst', 524: 'wall', 525: 'crossing',
    526: 'building', 527: 'forbidden', 528: 'forbidden', 529: PAVED, 534: 'wall',
    707: 'oobline', 708: 'crossing', 709: 'oob', 710: 'oob',
  };
  // ISSOM 2007 (sprint, dawna numeracja)
  const ISSOM2007 = {
    101: 'contour', 102: 'contour', 103: 'ignore', 106: 'bank', 108: 'lowobst', 109: 'bank', 110: 'lowobst',
    201: 'cliff', 202: 'rockarea', 203: 'bank', 208: 'stony', 210: 'stony', 211: 'sand', 212: 'barerock',
    304: WATERX, 305: 'shallow', 306: 'ditch', 307: 'ignore', 308: 'marshline', 309: WATERX, 310: 'marsh', 311: 'softmarsh',
    401: 'open', 402: 'open', 403: 'rough', 404: 'rough', 405: 'forest', 406: 'slow', 407: 'under1', 408: 'walk', 409: 'under2', 410: 'fight',
    411: 'slow', 412: 'cult', 413: 'cult', 415: 'cult', 421: 'impveg',
    506: 'footpath', 507: 'smallpath', 508: 'faintpath', 509: 'ride', 512: 'bridge', 518: 'bridge',
    519: { line: 'fence', area: 'obstarea' }, 521: { line: 'wall', area: 'building' }, 522: 'fence', 524: 'wall', 525: 'crossing',
    526: { area: 'building', line: 'wall' }, 527: 'forbidden', 528: 'forbidden', 529: PAVED, 534: 'wall',
    707: 'oobline', 708: 'crossing', 709: 'oob', 714: 'oob',
  };
  // Wyjątki po pełnym numerze (numer * 1000 + podnumer).
  const SPRINT_SUB = { 512100: 'ignore', 512200: 'bridge', 512300: 'paved' }; // 512.1: krawędź mostu, pod którym wolno tylko przejść
  const ISSOM_SUB = { 526200: 'canopy' };

  const SETS = {
    isom2017: { name: 'ISOM 2017 (las)', table: ISOM2017, sub: {} },
    issprom2019: { name: 'ISSprOM 2019 (sprint)', table: ISSPROM2019, sub: SPRINT_SUB },
    isom2000: { name: 'ISOM 2000 (las, dawna numeracja)', table: ISOM2000, sub: {} },
    issom2007: { name: 'ISSOM 2007 (sprint, dawna numeracja)', table: ISSOM2007, sub: ISSOM_SUB },
  };

  // Który zestaw symboli ma plik: po skali (sprint do 1:5 000) i po typach kilku charakterystycznych numerów
  // (np. 501 to w nowych zestawach powierzchnia utwardzona, a w ISOM 2000 linia autostrady).
  function detectSet(map) {
    const type = (n) => { for (const s of map.symbols.values()) if (((s.num / 1000) | 0) === n) return s.type; return 0; };
    let modern = 0;
    if (type(501) === 3) modern += 2; else if (type(501) === 2) modern -= 2;
    if (type(521) === 3) modern += 2; else if (type(521) === 2) modern -= 1;
    if (type(529) === 3) modern -= 2; else if (type(529) === 2) modern += 1;
    if (type(526) === 3) modern -= 2;
    if (type(519) === 2) modern -= 2; else if (type(519) === 1) modern += 1; // 519: dawniej mur (linia), teraz punkt przejścia
    if (type(106) === 2 && type(104) === 1) modern -= 1;                      // 104 jako punkt (kreska spadku) = dawna numeracja
    const sprint = map.geo.scale > 0 && map.geo.scale <= 5000;
    return sprint ? (modern >= 0 ? 'issprom2019' : 'issom2007') : (modern >= 0 ? 'isom2017' : 'isom2000');
  }

  function kindOf(setId, sym, overrides) {
    const key = String(sym.num);
    if (overrides && overrides[key] && KIND[overrides[key]]) return overrides[key];
    const set = SETS[setId];
    let k = set.sub[sym.num] || set.table[(sym.num / 1000) | 0] || 'ignore';
    if (typeof k === 'object') k = (sym.type === 3 ? k.area : sym.type === 2 ? k.line : null) || 'ignore';
    if (k === 'pavedline') k = sym.lineWidth >= 0.3 ? 'road' : 'ignore'; // gruba linia = droga, cienka = krawędź nawierzchni
    // pierwsze wydanie ISSprOM 2019 nazywało symbol 410 "Impassable vegetation"; od 2019-2 tę rolę ma 411
    if (((sym.num / 1000) | 0) === 410 && /impass|uncross|nieprzeb|nie do prze/i.test(sym.name || '')) k = 'impveg';
    const mode = KIND[k].mode;
    // symbol o złym typie geometrii dla danego rodzaju (np. punktowy "budynek") nie jest nanoszony
    if (sym.type === 1 && mode !== 'gap') return 'ignore';
    if (sym.type === 3 && (mode === 'slowline' || mode === 'path' || mode === 'wall')) return 'ignore';
    if (sym.type === 2 && (mode === 'area' || mode === 'overlay')) return 'ignore';
    return k;
  }

  // Zamiana mapy z pliku OCAD na siatkę: { w, h, cls, contour, mpp (metry na pole), used (symbole z licznikami) }.
  function build(map, gridDim, overrides, setId) {
    setId = setId || detectSet(map);
    const used = new Map();
    const b = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
    for (const o of map.objects) {
      const sym = map.symbols.get(o.sym) || { num: o.sym, type: o.type, name: '(symbol bez definicji)', lineWidth: 0 };
      let u = used.get(o.sym);
      if (!u) { u = { sym, count: 0, kind: sym.hidden ? 'ignore' : kindOf(setId, sym, overrides), auto: kindOf(setId, sym, null) }; used.set(o.sym, u); }
      u.count++;
      if (u.kind === 'ignore') continue;
      for (const r of o.rings) for (let i = 0; i < r.length; i += 2) {
        if (r[i] < b.x0) b.x0 = r[i]; if (r[i] > b.x1) b.x1 = r[i];
        if (r[i + 1] < b.y0) b.y0 = r[i + 1]; if (r[i + 1] > b.y1) b.y1 = r[i + 1];
      }
    }
    if (!(b.x1 > b.x0) || !(b.y1 > b.y0)) throw new Error('Nie rozpoznałem w tym pliku żadnego symbolu terenu. Sprawdź tabelę symboli poniżej.');
    const pad = 2; // mm marginesu
    b.x0 -= pad; b.y0 -= pad; b.x1 += pad; b.y1 += pad;
    const scale = map.geo.scale || 10000;
    // pól na milimetr: tyle, żeby dłuższy bok miał gridDim pól, ale nie gęściej niż 0,25 m terenu na pole
    const k = Math.min(gridDim / Math.max(b.x1 - b.x0, b.y1 - b.y0), scale / 1000 / 0.25);
    const w = Math.max(8, Math.round((b.x1 - b.x0) * k)), h = Math.max(8, Math.round((b.y1 - b.y0) * k));
    const mpp = scale / 1000 / k;
    const X = (x) => (x - b.x0) * k, Y = (y) => (b.y1 - y) * k; // w OCAD-zie oś Y rośnie do góry

    const n = w * h;
    const cls = new Uint8Array(n).fill(T.FOREST), contour = new Uint8Array(n);
    const canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    const g = canvas.getContext('2d', { willReadFrequently: true });
    g.lineJoin = 'round'; g.lineCap = 'round';

    // obiekty pogrupowane wg (sposób, klasa, szerokość linii)
    const groups = new Map();
    for (const o of map.objects) {
      const u = used.get(o.sym), kind = KIND[u.kind];
      if (kind.mode === 'ignore') continue;
      let width = 0;
      if (o.type === 2 || kind.mode === 'gap') {
        const real = (u.sym.lineWidth || 0) * k;                 // grubość z definicji symbolu, w polach
        // minimum w polach: przeszkoda musi być szczelna, a przejście musi przebić ją na wylot
        const need = kind.mode === 'gap' ? 7 : kind.mode === 'wall' || kind.mode === 'oob' ? 3 : 2;
        width = Math.max(need, real, (kind.widthM || 0) / mpp);
      }
      const key = kind.mode + '|' + (kind.cls == null ? '' : kind.cls) + '|' + Math.round(width * 2) / 2 + '|' + (o.type === 3 ? 'a' : o.type === 2 ? 'l' : 'p');
      if (!groups.has(key)) groups.set(key, { kind, width, type: o.type, list: [] });
      groups.get(key).list.push(o);
    }

    const paint = (grp) => {
      g.clearRect(0, 0, w, h);
      g.fillStyle = '#000'; g.strokeStyle = '#000'; g.lineWidth = grp.width;
      g.beginPath();
      for (const o of grp.list) {
        if (o.type === 1) { // punkt (np. punkt przejścia): kółko
          const r = o.rings[0]; if (!r) continue;
          g.moveTo(X(r[0]) + grp.width / 2, Y(r[1])); g.arc(X(r[0]), Y(r[1]), grp.width / 2, 0, Math.PI * 2);
          continue;
        }
        for (const r of o.rings) {
          g.moveTo(X(r[0]), Y(r[1]));
          for (let i = 2; i < r.length; i += 2) g.lineTo(X(r[i]), Y(r[i + 1]));
          if (o.type === 3) g.closePath();
        }
      }
      if (grp.type === 3) g.fill('evenodd'); else if (grp.type === 1) g.fill(); else g.stroke();
      return g.getImageData(0, 0, w, h).data;
    };
    const cost = (c) => TERRAIN[c].cost;

    const sorted = [...groups.values()].sort((p, q) => ORDER.indexOf(p.kind.mode) - ORDER.indexOf(q.kind.mode) || cost(q.kind.cls || 0) * 0 + 0);
    for (const grp of sorted) {
      const mode = grp.kind.mode, c = grp.kind.cls;
      if (mode === 'contour') continue;
      const a = paint(grp);
      const limit = grp.type === 3 ? 127 : 40; // linie liczymy także z częściowo pokrytych pól, żeby były ciągłe
      for (let i = 0; i < n; i++) {
        if (a[i * 4 + 3] <= limit) continue;
        const cur = cls[i];
        if (mode === 'area') cls[i] = c;
        else if (mode === 'overlay') { if (cost(cur) < cost(c)) cls[i] = c; }
        else if (mode === 'hard') { if (cur !== T.BUILDING) cls[i] = c; }
        else if (mode === 'slowline') { if (cost(cur) !== Infinity && cost(cur) < cost(c)) cls[i] = c; }
        else if (mode === 'path') { if (cur !== T.BUILDING) cls[i] = c; }
        else cls[i] = c; // wall, gap, oob
      }
    }
    for (const grp of groups.values()) {
      if (grp.kind.mode !== 'contour') continue;
      const a = paint(grp);
      for (let i = 0; i < n; i++) if (a[i * 4 + 3] > 40) contour[i] = 1;
    }
    return { w, h, cls, contour, mpp, scale, set: setId, setName: SETS[setId].name, used: [...used.values()].sort((p, q) => p.sym.num - q.sym.num), bounds: b, k };
  }

  // Nazwy rodzajów do tabeli symboli (po polsku).
  const KIND_NAMES = {
    ignore: 'pomijany', contour: 'warstwica', open: 'teren otwarty', rough: 'otwarty nierówny / z drzewami', forest: 'las (biały)',
    slow: 'zielony jasny', walk: 'zielony średni', fight: 'zielony ciemny', cult: 'pole uprawne / sad', paved: 'utwardzone', barerock: 'naga skała',
    under1: 'podszyt: wolny bieg', under2: 'podszyt: marsz', marsh: 'bagno', softmarsh: 'bagno niewyraźne', stony: 'teren kamienisty', boulders: 'rumowisko',
    sand: 'piasek', stonyfight: 'kamienie: bardzo trudny teren', rockarea: 'skała / głaz nie do przejścia', obstarea: 'murek (powierzchnia) do przejścia', lake: 'woda nie do przejścia', shallow: 'woda płytka', impveg: 'zieleń nie do przejścia', forbidden: 'teren zakazany',
    building: 'budynek', canopy: 'zadaszenie (przejście)', stream: 'strumień', ditch: 'mały rów', bank: 'skarpa / skałka do przejścia',
    lowobst: 'niska przeszkoda', fence: 'płot / mur do przejścia', marshline: 'wąskie bagno', road: 'droga', track: 'droga gruntowa',
    footpath: 'ścieżka', smallpath: 'mała ścieżka', faintpath: 'ścieżka słabo widoczna', ride: 'przecinka', cliff: 'skała nie do przejścia',
    wall: 'mur / płot nie do przejścia', riverline: 'brzeg wody nie do przejścia', crossing: 'punkt przejścia', bridge: 'most / tunel',
    oob: 'teren wyłączony (nadruk)', oobline: 'granica wyłączona (nadruk)',
  };

  root.BnoSymbols = { SETS, KIND, KIND_NAMES, detectSet, kindOf, build };
})(typeof self !== 'undefined' ? self : this);

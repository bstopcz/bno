// Opis wariantu słowami: po czym biegniesz, co przecinasz, jakie obiekty mijasz, skąd atakujesz punkt.
// Teren bierzemy z siatki (ta sama, na której liczony jest wariant), a obiekty punktowe (kamienie, górki,
// wykroty...) z pliku OCAD – na mapie wczytanej tylko jako obraz opis jest bez obiektów punktowych.
// Działa w przeglądarce (globalny BnoOpis) i w Node (module.exports).
(function (root) {
  'use strict';
  const { T, TERRAIN } = typeof module !== 'undefined' && module.exports ? require('./core.js') : root.BnoCore;

  const STEP_M = 2;        // co tyle metrów próbkujemy drogę
  const MIN_RUN_M = 15;    // krótszy kawałek innego terenu nie dostaje własnego kroku
  const NEAR_M = 15;       // obiekt bliżej trasy niż tyle metrów "mijasz"
  const MAX_OBJ = 2;       // tyle wzmianek o obiektach najwyżej na jeden odcinek
  const OBJ_RUN_M = 40;    // na krótszym odcinku obiektów nie wymieniamy
  const ATTACK_MIN_M = 15; // punkt ataku nie bliżej punktu niż tyle (bliżej to już sam punkt)
  const ATTACK_MAX_M = 150;
  const CATCH_M = 150;     // tak daleko za punktem szukamy linii zatrzymującej

  // Obiekty punktowe: mianownik, biernik ("mijasz ..."), liczba mnoga, dopełniacz ("z ..."), rodzaj żeński.
  // rank: jak pewny jest obiekt w terenie (3 = nie do pomylenia, 1 = jeden z wielu podobnych, np. drzewo w parku).
  const O = (nom, acc, pl, gen, fem, rank) => ({ nom, acc, pl, gen, fem: !!fem, rank: rank || 2 });
  const OBJECTS = {
    boulder: O('kamień', 'kamień', 'kamienie', 'kamienia'),
    bigboulder: O('duży kamień', 'duży kamień', 'duże kamienie', 'dużego kamienia', false, 3),
    cluster: O('grupa kamieni', 'grupę kamieni', 'grupy kamieni', 'grupy kamieni', true, 3),
    knoll: O('górka', 'górkę', 'górki', 'górki', true, 3),
    depression: O('dołek', 'dołek', 'dołki', 'dołka'),
    pit: O('dół', 'dół', 'doły', 'dołu', false, 3),
    landform: O('obiekt rzeźby terenu', 'obiekt rzeźby terenu', 'obiekty rzeźby terenu', 'obiektu rzeźby terenu', false, 1),
    cave: O('jama skalna', 'jamę skalną', 'jamy skalne', 'jamy skalnej', true, 3),
    well: O('studnia', 'studnię', 'studnie', 'studni', true, 3),
    spring: O('źródło', 'źródło', 'źródła', 'źródła', false, 3),
    waterhole: O('oczko wodne', 'oczko wodne', 'oczka wodne', 'oczka wodnego'),
    waterfeat: O('obiekt wodny', 'obiekt wodny', 'obiekty wodne', 'obiektu wodnego', false, 1),
    tree: O('wyraźne drzewo', 'wyraźne drzewo', 'wyraźne drzewa', 'wyraźnego drzewa', false, 1),
    bush: O('krzak', 'krzak', 'krzaki', 'krzaka', false, 1),
    vegfeat: O('obiekt roślinny', 'obiekt roślinny', 'obiekty roślinne', 'obiektu roślinnego', false, 1),
    rootstock: O('wykrot', 'wykrot', 'wykroty', 'wykrotu', false, 3),
    tower: O('wieża', 'wieżę', 'wieże', 'wieży', true, 3),
    stand: O('ambona', 'ambonę', 'ambony', 'ambony', true, 3),
    cairn: O('kopiec', 'kopiec', 'kopce', 'kopca', false, 3),
    anthill: O('mrowisko', 'mrowisko', 'mrowiska', 'mrowiska'),
    rack: O('paśnik', 'paśnik', 'paśniki', 'paśnika', false, 3),
    manmade: O('obiekt sztuczny', 'obiekt sztuczny', 'obiekty sztuczne', 'obiektu sztucznego', false, 1),
  };

  // Rodzaje nawierzchni: narzędnik ("biegniesz ..."), dopełniacz ("do ...", "ze ..."), biernik ("przetnij ..."), mianownik.
  const S = (ins, gen, acc, nom, trail) => ({ ins, gen, acc, nom, trail: !!trail });
  const SURF = {
    road: S('drogą', 'drogi', 'drogę', 'droga', true),
    paved: S('po utwardzonym', 'terenu utwardzonego', 'teren utwardzony', 'teren utwardzony', true),
    path: S('ścieżką', 'ścieżki', 'ścieżkę', 'ścieżka', true),
    small: S('małą ścieżką', 'małej ścieżki', 'małą ścieżkę', 'mała ścieżka', true),
    faint: S('słabą ścieżką', 'słabej ścieżki', 'słabą ścieżkę', 'słaba ścieżka', true),
    forest: S('lasem', 'lasu', 'las', 'las'),
    open: S('terenem otwartym', 'terenu otwartego', 'teren otwarty', 'teren otwarty'),
    green: S('gęstszym lasem', 'gęstszego lasu', 'gęstszy las', 'gęstszy las'),
    marsh: S('przez bagno', 'bagna', 'bagno', 'bagno'),
    stony: S('terenem kamienistym', 'terenu kamienistego', 'teren kamienisty', 'teren kamienisty'),
    // przeszkody liniowe: tylko do przecięcia
    stream: S('', 'strumienia', 'strumień', 'strumień'),
    ditch: S('', 'rowu', 'rów', 'rów'),
    fence: S('', 'płotu', 'płot', 'płot'),
    bank: S('', 'skarpy', 'skarpę', 'skarpa'),
    block: S('', 'przeszkody', 'przeszkodę', 'przeszkoda nie do przejścia'),
  };
  const LINE = { stream: 1, ditch: 1, fence: 1, bank: 1 };

  function groupOf(c, ocad) {
    switch (c) {
      case T.PATH: return ocad ? 'road' : 'path';
      case T.PAVED: return 'paved';
      case T.PATH2: return 'path';
      case T.PATH3: return 'small';
      case T.PATH4: return 'faint';
      case T.OPEN: case T.ROUGH: case T.CULT: return 'open';
      case T.GREEN1: case T.GREEN2: case T.GREEN3: case T.UNDER1: case T.UNDER2: return 'green';
      case T.MARSH: case T.WATER: return 'marsh';
      case T.STONY: case T.BOULDERS: return 'stony';
      case T.STREAM: return 'stream';
      case T.DITCH: return 'ditch';
      case T.FENCE: return 'fence';
      case T.OBST: return 'bank';
      default: return TERRAIN[c] && TERRAIN[c].cost === Infinity ? 'block' : 'forest';
    }
  }

  const WINDS = ['na północ', 'na północny wschód', 'na wschód', 'na południowy wschód', 'na południe', 'na południowy zachód', 'na zachód', 'na północny zachód'];
  const round10 = (m) => (m < 30 ? Math.round(m / 5) * 5 : Math.round(m / 10) * 10);
  const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
  const NUM = { m: ['', '', 'dwa', 'trzy', 'cztery'], f: ['', '', 'dwie', 'trzy', 'cztery'] };

  // o: { pts: [{x, y}] droga w pikselach obrazu, cls, w, h: siatka terenu, k: pól siatki na piksel obrazu,
  //      pxPerM: pikseli obrazu na metr, north: { x, y } kierunek północy na obrazie (domyślnie góra),
  //      objects: [{ kind, x, y }] w pikselach obrazu, forest: mapa leśna (punkt ataku), ocad: teren z pliku OCAD }
  // Zwraca { steps: [{ text, x, y }], marks: [{ x, y, attack }] } – marks to obiekty wymienione w opisie.
  function describe(o) {
    const pts = o.pts, step = STEP_M * o.pxPerM;
    if (!pts || pts.length < 2 || !(step > 0)) return { steps: [], marks: [] };
    const north = o.north || { x: 0, y: -1 }, east = { x: -north.y, y: north.x };
    const wind = (ax, ay, bx, by) => {
      const vx = bx - ax, vy = by - ay;
      const deg = (Math.atan2(vx * east.x + vy * east.y, vx * north.x + vy * north.y) * 180 / Math.PI + 360) % 360;
      return { deg, text: WINDS[Math.round(deg / 45) % 8] };
    };
    const classAt = (x, y) => {
      const gx = Math.floor(x * o.k), gy = Math.floor(y * o.k);
      return gx < 0 || gy < 0 || gx >= o.w || gy >= o.h ? -1 : o.cls[gy * o.w + gx];
    };

    // 1. droga pocięta na równe kroki
    const s = [];
    let carry = 0;
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1], b = pts[i], d = Math.hypot(b.x - a.x, b.y - a.y);
      if (!d) continue;
      let t = carry;
      for (; t < d; t += step) s.push({ x: a.x + (b.x - a.x) * t / d, y: a.y + (b.y - a.y) * t / d });
      carry = t - d;
    }
    const end = pts[pts.length - 1];
    s.push({ x: end.x, y: end.y });
    const n = s.length;
    if (n < 4) return { steps: [], marks: [] };
    const g = s.map((p) => { const c = classAt(p.x, p.y); return c < 0 ? 'forest' : groupOf(c, o.ocad); });
    const metres = (a, b) => (b - a) * STEP_M;

    // 2. odcinki jednego terenu. Krótkie wtrącenia (poniżej MIN_RUN_M) wsiąkają w dłuższego sąsiada, zaczynając
    //    od najkrótszych. Wyjątki: przeszkoda liniowa (strumień, rów, płot, skarpa) i wąska ścieżka albo droga
    //    przecięta w poprzek – te zostają jako "przetnij ...".
    const NARROW = { road: 1, path: 1, small: 1, faint: 1 };
    let runs = [];
    for (let i = 0; i < n; i++) {
      const last = runs[runs.length - 1];
      if (last && last.g === g[i]) last.b = i; else runs.push({ g: g[i], a: i, b: i });
    }
    const size = (r) => metres(r.a, r.b + 1);
    const keep = (r) => LINE[r.g] || (NARROW[r.g] && size(r) < MIN_RUN_M); // kandydat na przecięcie
    const fuse = () => { // sąsiednie odcinki tego samego terenu to jeden odcinek
      for (let q = runs.length - 1; q > 0; q--) if (runs[q - 1].g === runs[q].g) { runs[q - 1].b = runs[q].b; runs.splice(q, 1); }
    };
    for (let guard = 0; guard < 10000; guard++) {
      let pick = -1;
      runs.forEach((r, q) => { if (r.g === 'block' || (!keep(r) && size(r) < MIN_RUN_M)) if (pick < 0 || size(r) < size(runs[pick])) pick = q; });
      if (pick < 0 || runs.length < 2) break;
      const p = runs[pick - 1], nx = runs[pick + 1];
      const into = !p ? nx : !nx ? p : keep(p) !== keep(nx) ? (keep(p) ? nx : p) : size(p) >= size(nx) ? p : nx;
      if (into === p) p.b = runs[pick].b; else nx.a = runs[pick].a;
      runs.splice(pick, 1);
      fuse();
    }
    // kandydat na przecięcie jest nim naprawdę tylko między dwoma odcinkami poza ścieżką; inaczej to kawałek drogi
    for (let q = runs.length - 1; q >= 0; q--) {
      const r = runs[q];
      if (!keep(r)) continue;
      const p = runs[q - 1], nx = runs[q + 1];
      if (LINE[r.g] || (p && nx && !SURF[p.g].trail && !SURF[nx.g].trail)) { r.cross = true; continue; }
      const into = p && SURF[p.g].trail ? p : nx && SURF[nx.g].trail ? nx : p || nx;
      if (!into) continue;
      if (into === p) p.b = r.b; else nx.a = r.a;
      runs.splice(q, 1);
    }
    for (let q = runs.length - 1; q > 0; q--) {
      const x = runs[q - 1], y = runs[q];
      if (!x.cross && !y.cross && x.g === y.g) { x.b = y.b; runs.splice(q, 1); }
    }

    // zmiana rodzaju drogi bez skrętu (ścieżka przechodzi w drogę) to dalej ten sam krok: zostaje nazwa dłuższej części
    const heading = (a, b) => Math.atan2(s[b].y - s[a].y, s[b].x - s[a].x) * 180 / Math.PI;
    const bend = (p, r) => { // skręt między końcem odcinka p a początkiem r, w stopniach (dodatni = w prawo)
      const w = Math.round(16 / STEP_M);
      return ((heading(r.a, Math.min(r.b, r.a + w)) - heading(Math.max(p.a, p.b - w), p.b) + 540) % 360) - 180;
    };
    for (let q = runs.length - 1; q > 0; q--) {
      const a = runs[q - 1], b = runs[q];
      if (a.cross || b.cross || !SURF[a.g].trail || !SURF[b.g].trail || Math.abs(bend(a, b)) >= 30) continue;
      if (b.b - b.a > a.b - a.a) a.g = b.g;
      a.b = b.b; runs.splice(q, 1);
    }

    // 3. obiekty przy trasie
    const near = [];
    const R = NEAR_M * o.pxPerM;
    for (const ob of o.objects || []) {
      if (!OBJECTS[ob.kind]) continue;
      let best = Infinity, at = -1;
      for (let i = 0; i < n; i++) { const d = Math.hypot(s[i].x - ob.x, s[i].y - ob.y); if (d < best) { best = d; at = i; } }
      if (best > R) continue;
      const p = s[Math.max(0, at - 1)], q = s[Math.min(n - 1, at + 1)];
      const cross = (q.x - p.x) * (ob.y - p.y) - (q.y - p.y) * (ob.x - p.x);
      const dist = best / o.pxPerM;
      near.push({ kind: ob.kind, x: ob.x, y: ob.y, at, dist, side: dist < 4 ? 'przy samej trasie' : cross > 0 ? 'po prawej' : 'po lewej' });
    }
    near.sort((a, b) => a.at - b.at);
    const mentions = (run) => {
      // obiekty wymieniamy tylko w lesie, poza ścieżką (na ścieżce prowadzi ścieżka) i na dłuższym odcinku
      if (!o.forest || SURF[run.g].trail || metres(run.a, run.b) < OBJ_RUN_M) return [];
      let list = near.filter((ob) => ob.at >= run.a && ob.at <= run.b);
      if (!list.length) return [];
      const groups = [];
      for (const ob of list) {
        const last = groups[groups.length - 1];
        if (last && last.kind === ob.kind && last.side === ob.side && metres(last.at, ob.at) <= 30) { last.items.push(ob); last.at = ob.at; last.dist = Math.min(last.dist, ob.dist); }
        else groups.push({ kind: ob.kind, side: ob.side, at: ob.at, first: ob.at, dist: ob.dist, items: [ob] });
      }
      list = groups;
      const rank = (m) => OBJECTS[m.kind].rank + (m.items.length > 1 ? 0.5 : 0);
      if (list.length > MAX_OBJ) list = list.slice().sort((a, b) => rank(b) - rank(a) || a.dist - b.dist).slice(0, MAX_OBJ).sort((a, b) => a.first - b.first);
      return list;
    };
    const objText = (m) => {
      const f = OBJECTS[m.kind], c = m.items.length;
      return c === 1 ? f.acc : c <= 4 ? NUM[f.fem ? 'f' : 'm'][c] + ' ' + f.pl : `${c} × ${f.nom}`;
    };

    // 4. kroki
    const steps = [], marks = [];
    const dirOf = (a, b) => wind(s[a].x, s[a].y, s[b].x, s[b].y);
    const turn = (q) => { // skręt na początku odcinka q względem końca poprzedniego
      const r = runs[q], p = runs[q - 1];
      if (!p) return '';
      const d = bend(p, r);
      return Math.abs(d) < 30 ? '' : d > 0 ? ' w prawo' : ' w lewo';
    };
    // Wyraźne skręty wewnątrz odcinka (co najmniej 40 stopni, nie bliżej niż 20 m od jego końców i od siebie).
    const bends = (r) => {
      const w = Math.round(16 / STEP_M), gap = Math.round(20 / STEP_M), parts = [{ a: r.a, b: r.b, deg: 0 }];
      let i = r.a + gap;
      while (i <= r.b - gap) {
        const d = ((heading(i, Math.min(r.b, i + w)) - heading(Math.max(r.a, i - w), i) + 540) % 360) - 180;
        if (Math.abs(d) < 40) { i++; continue; }
        let best = i, bd = d; // szczyt skrętu w najbliższych 16 m
        for (let j = i + 1; j <= Math.min(r.b - gap, i + w); j++) {
          const dj = ((heading(j, Math.min(r.b, j + w)) - heading(Math.max(r.a, j - w), j) + 540) % 360) - 180;
          if (Math.abs(dj) > Math.abs(bd)) { best = j; bd = dj; }
        }
        parts[parts.length - 1].b = best;
        parts.push({ a: best, b: r.b, deg: bd });
        i = best + gap;
      }
      return parts;
    };
    runs.forEach((r, q) => {
      const f = SURF[r.g], prev = runs[q - 1], at = s[r.a];
      if (r.cross) { steps.push({ text: `Przetnij ${f.acc}.`, x: at.x, y: at.y, at: r.a }); return; }
      const parts = bends(r); // odcinek pocięty w miejscach wyraźnych skrętów
      const len = round10(metres(parts[0].a, parts[0].b)), dir = dirOf(parts[0].a, parts[0].b).text;
      const before = prev && !prev.cross ? SURF[prev.g] : null;
      let text;
      if (!prev) text = `${cap(f.ins)} ${len} m ${dir}.`;
      else if (f.trail && before && before.trail) text = `Skręć${turn(q)} w ${f.acc}, ${len} m ${dir}.`.replace('w teren utwardzony', 'na utwardzone');
      else if (f.trail) text = r.g === 'paved' ? `Wybiegasz na utwardzone, ${len} m ${dir}.` : `Dobiegasz do ${f.gen},${turn(q) ? ' nią' + turn(q) : ' nią'} ${len} m ${dir}.`;
      else if (before && before.trail) text = `Zejdź z ${before.gen}${turn(q)} w ${f.acc}, ${len} m ${dir}.`.replace('z ścieżki', 'ze ścieżki').replace('z słabej', 'ze słabej');
      else text = `Dalej ${f.ins} ${len} m ${dir}.`;
      steps.push({ text, x: at.x, y: at.y, at: r.a });
      for (const part of parts.slice(1)) {
        steps.push({ text: `Skręć ${part.deg > 0 ? 'w prawo' : 'w lewo'}, dalej ${f.ins} ${round10(metres(part.a, part.b))} m ${dirOf(part.a, part.b).text}.`,
          x: s[part.a].x, y: s[part.a].y, at: part.a });
      }
      for (const m of mentions(r)) {
        const first = m.items[0];
        steps.push({ text: `${cap(m.side)} mijasz ${objText(m)}.`.replace('Przy samej trasie mijasz', 'Tuż przy trasie mijasz'), x: first.x, y: first.y, at: first.at });
        for (const it of m.items) marks.push({ x: it.x, y: it.y });
      }
    });

    steps.sort((a, b) => a.at - b.at);

    // 5. punkt ataku i linia zatrzymująca – tylko w lesie i tylko gdy punkt nie leży przy ścieżce
    const last = runs[runs.length - 1];
    if (o.forest && last && !last.cross && !SURF[last.g].trail) {
      const far = metres(last.a, last.b);
      const toEnd = (x, y) => Math.hypot(end.x - x, end.y - y) / o.pxPerM;
      const cands = near.filter((ob) => ob.at >= last.a && toEnd(ob.x, ob.y) >= ATTACK_MIN_M && toEnd(ob.x, ob.y) <= ATTACK_MAX_M);
      const prev = runs[runs.length - 2];
      if (far >= 30) {
        if (cands.length) {
          // najpewniejszy obiekt; przy równych ten bliżej punktu
          const ob = cands.slice().sort((a, b) => OBJECTS[b.kind].rank - OBJECTS[a.kind].rank || toEnd(a.x, a.y) - toEnd(b.x, b.y))[0];
          steps.push({ text: `Punkt ataku: ${OBJECTS[ob.kind].nom} ${ob.side}. Stąd ${round10(toEnd(ob.x, ob.y))} m ${wind(ob.x, ob.y, end.x, end.y).text} do punktu.`, x: ob.x, y: ob.y, attack: true });
          marks.push({ x: ob.x, y: ob.y, attack: true });
        } else if (prev) {
          const what = prev.cross ? `przecięcie ${SURF[prev.g].gen}` : !SURF[prev.g].trail ? `skraj ${SURF[prev.g].gen}`
            : `miejsce zejścia z ${SURF[prev.g].gen}`.replace('z ścieżki', 'ze ścieżki').replace('z słabej', 'ze słabej');
          const p = s[last.a];
          steps.push({ text: `Punkt ataku: ${what}. Stąd ${round10(toEnd(p.x, p.y))} m ${wind(p.x, p.y, end.x, end.y).text} do punktu.`
            + (far > ATTACK_MAX_M ? ' To daleko i bez pewnego obiektu po drodze – pilnuj kierunku i licz odległość.' : ''), x: p.x, y: p.y, attack: true });
          marks.push({ x: p.x, y: p.y, attack: true });
        } else {
          steps.push({ text: `Brak pewnego punktu ataku: ${round10(far)} m bez wyraźnego obiektu – pilnuj kierunku i licz odległość.`, x: s[0].x, y: s[0].y, attack: true });
        }
      }
      // co jest za punktem, gdybyś go przebiegł
      const w = Math.round(20 / STEP_M), p = s[Math.max(0, n - 1 - w)];
      const d = Math.hypot(end.x - p.x, end.y - p.y);
      if (d > 0 && far >= 30) {
        const ux = (end.x - p.x) / d, uy = (end.y - p.y) / d;
        for (let m = 10; m <= CATCH_M; m += STEP_M) {
          const c = classAt(end.x + ux * m * o.pxPerM, end.y + uy * m * o.pxPerM);
          if (c < 0) break;
          const grp = groupOf(c, o.ocad), f = SURF[grp];
          if (f.trail || LINE[grp] || grp === 'block' || (grp === 'open' && last.g !== 'open')) {
            steps.push({ text: `Jeśli przebiegniesz punkt: po ok. ${round10(m)} m jest ${f.nom}.`, x: end.x, y: end.y });
            break;
          }
        }
      }
    }
    return { steps, marks };
  }

  const api = { describe, OBJECTS };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.BnoOpis = api;
})(typeof self !== 'undefined' ? self : this);

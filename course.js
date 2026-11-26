// Czytanie plików z trasami: eksport IOF XML 3.0 (OCAD Course Setting, Purple Pen, Condes)
// oraz plik projektu tras OCAD (.ocd z FileType = 1). Wynik w obu przypadkach:
//   { courses: [{ name, controls: [{ code, type: 'start' | 'punkt' | 'meta', lat?, lon?, mx?, my? }] }], notes: [] }
// lat/lon to pozycja na świecie, mx/my to milimetry na mapie (układ papieru OCAD-a, oś Y do góry).
(function (root) {
  'use strict';

  const TYPE = { start: 'start', control: 'punkt', finish: 'meta' };

  // ---- IOF XML 3.0 ----
  function parseIofXml(text) {
    const doc = new DOMParser().parseFromString(text, 'application/xml');
    if (doc.getElementsByTagName('parsererror').length) throw new Error('Plik trasy nie jest poprawnym XML-em.');
    const all = (el, name) => [...el.getElementsByTagNameNS('*', name)];
    const child = (el, name) => [...el.children].find((c) => c.localName === name) || null;
    const txt = (el, name) => { const c = child(el, name); return c ? c.textContent.trim() : ''; };
    const race = all(doc, 'RaceCourseData')[0];
    if (!race) throw new Error('To nie jest eksport tras IOF XML 3.0 (brak sekcji RaceCourseData). W OCAD-zie wybierz eksport tras w formacie IOF XML 3.0.');
    const controls = new Map();
    for (const c of [...race.children].filter((e) => e.localName === 'Control')) {
      const id = txt(c, 'Id'), pos = child(c, 'Position'), mp = child(c, 'MapPosition');
      const item = { code: id };
      if (pos && pos.getAttribute('lat') && pos.getAttribute('lng')) { item.lat = parseFloat(pos.getAttribute('lat')); item.lon = parseFloat(pos.getAttribute('lng')); }
      if (mp && mp.getAttribute('x') != null) { item.mx = parseFloat(mp.getAttribute('x')); item.my = parseFloat(mp.getAttribute('y')); }
      controls.set(id, item);
    }
    const courses = [], notes = [];
    for (const c of [...race.children].filter((e) => e.localName === 'Course')) {
      const list = [];
      for (const cc of [...c.children].filter((e) => e.localName === 'CourseControl')) {
        const kind = TYPE[(cc.getAttribute('type') || 'Control').toLowerCase()];
        const ctrl = controls.get(txt(cc, 'Control'));
        if (!kind || !ctrl) continue; // przejścia obowiązkowe, wymiany map itp. pomijamy
        list.push(Object.assign({ type: kind }, ctrl));
      }
      if (list.some((p) => p.type === 'punkt')) courses.push({ name: txt(c, 'Name') || 'Trasa ' + (courses.length + 1), controls: list });
    }
    if (!courses.length) throw new Error('W pliku XML nie ma żadnej trasy z punktami kontrolnymi.');
    if (![...controls.values()].some((c) => c.lat != null)) notes.push('Plik trasy nie ma współrzędnych geograficznych punktów, tylko pozycje na mapie – użyję ich razem z plikiem OCAD mapy.');
    return { courses, notes };
  }

  // ---- projekt tras OCAD (.ocd, FileType = 1) ----
  // Punkty kontrolne to obiekty z opisem w napisach typu 1 (pierwsze pole = kod, Y = rodzaj: s/c/f),
  // trasy to napisy typu 2 (pierwsze pole = nazwa, potem kolejne pozycje: s<kod>, c<kod>, f<kod>).
  function parseOcadCourses(buffer) {
    const d = new DataView(buffer), size = d.byteLength;
    if (size < 60 || d.getUint16(0, true) !== 0x0cad) throw new Error('To nie jest plik OCAD.');
    const version = d.getInt16(4, true), modern = version >= 12;
    const inside = (o, len) => o > 0 && o + len <= size;
    const utf8 = new TextDecoder(version >= 11 ? 'utf-8' : 'windows-1250');
    // pozycje obiektów w kolejności indeksu (także usuniętych, bo napisy odwołują się do numeru w indeksie)
    const objs = [];
    const headerSize = modern ? 56 : version === 9 ? 32 : 40;
    for (let blk = d.getUint32(12, true), guard = 0; blk && inside(blk, 4 + 256 * 40) && guard < 100000; blk = d.getUint32(blk, true), guard++) {
      for (let k = 0; k < 256; k++) {
        const e = blk + 4 + 40 * k, pos = d.getInt32(e + 16, true);
        const o = { ok: false, x: 0, y: 0, status: d.getUint8(e + 30), view: d.getUint8(e + 31) };
        if (inside(pos, headerSize + 8)) { o.ok = true; o.x = (d.getInt32(pos + headerSize, true) >> 8) / 100; o.y = (d.getInt32(pos + headerSize + 4, true) >> 8) / 100; }
        objs.push(o);
      }
    }
    const csObjects = [], courseStrings = [];
    let scalePar = '';
    for (let blk = d.getUint32(32, true), guard = 0; blk && inside(blk, 4 + 256 * 16) && guard < 1000; blk = d.getUint32(blk, true), guard++) {
      for (let k = 0; k < 256; k++) {
        const e = blk + 4 + 16 * k, pos = d.getUint32(e, true), len = d.getInt32(e + 4, true), type = d.getInt32(e + 8, true), objIndex = d.getInt32(e + 12, true);
        if ((type !== 1 && type !== 2 && type !== 1039) || !inside(pos, len) || len <= 0) continue;
        let bytes = new Uint8Array(buffer, pos, len);
        const zero = bytes.indexOf(0);
        if (zero >= 0) bytes = bytes.subarray(0, zero);
        const fields = utf8.decode(bytes).split('\t');
        if (type === 1) csObjects.push({ code: fields[0], fields: fields.slice(1), objIndex });
        else if (type === 2) courseStrings.push(fields);
        else scalePar = fields.slice(1);
      }
    }
    if (!courseStrings.length) throw new Error('W tym pliku OCAD nie ma tras. Dołącz plik projektu tras z OCAD Course Setting albo eksport tras IOF XML 3.0.');
    // numer obiektu w napisie liczony od 0 czy od 1? Wybieramy wariant, przy którym więcej punktów trafia w istniejące obiekty.
    const hits = (base) => csObjects.filter((c) => { const o = objs[c.objIndex - base]; return o && o.ok && o.status === 1; }).length;
    const base = hits(1) >= hits(0) ? 1 : 0;
    const geo = { scale: 0, x: 0, y: 0, angle: 0, grid: 0, realWorld: false };
    for (const part of scalePar || []) {
      const v = parseFloat(part.slice(1));
      if (part[0] === 'm') geo.scale = v; else if (part[0] === 'x') geo.x += v; else if (part[0] === 'y') geo.y += v;
      else if (part[0] === 'b') geo.x += v || 0; else if (part[0] === 'c') geo.y += v || 0;
      else if (part[0] === 'a') geo.angle = v; else if (part[0] === 'i') geo.grid = v; else if (part[0] === 'r') geo.realWorld = v === 1;
    }
    const byCode = new Map();
    for (const c of csObjects) {
      const o = objs[c.objIndex - base];
      const kind = (c.fields.find((f) => f[0] === 'Y') || 'Yc').slice(1);
      if (o && o.ok && TYPE[{ s: 'start', c: 'control', f: 'finish' }[kind]]) byCode.set(c.code, { code: c.code, mx: o.x, my: o.y });
    }
    const courses = [];
    for (const fields of courseStrings) {
      const list = [];
      for (const f of fields.slice(1)) {
        const kind = { s: 'start', c: 'control', f: 'finish' }[f[0]];
        const ctrl = kind && byCode.get(f.slice(1));
        if (ctrl) list.push(Object.assign({ type: TYPE[kind] }, ctrl));
      }
      if (list.some((p) => p.type === 'punkt')) courses.push({ name: fields[0] || 'Trasa ' + (courses.length + 1), controls: list });
    }
    if (!courses.length) throw new Error('Nie udało się odczytać tras z pliku projektu OCAD (trasy są, ale nie umiem powiązać ich punktów z pozycjami). Wyeksportuj trasy jako IOF XML 3.0.');
    return { courses, geo, notes: ['Trasy odczytane wprost z pliku projektu OCAD. Ten sposób nie był sprawdzony na wielu plikach – obejrzyj punkty na mapie przed publikacją.'] };
  }

  // Czy plik .ocd jest projektem tras (a nie mapą)?
  const isCourseProject = (buffer) => new DataView(buffer).byteLength > 4 && new DataView(buffer).getUint8(2) === 1;

  root.BnoCourse = { parseIofXml, parseOcadCourses, isCourseProject };
})(typeof self !== 'undefined' ? self : this);

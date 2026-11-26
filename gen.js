// Zakładka "Generacja danych": przygotowanie kompletu plików treningu przez admina.
(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const status = (text) => { $('gstatus').textContent = text; };

  // Pakowanie plików do ZIP-a bez kompresji (obraz JPG i siatka PNG są już skompresowane).
  const CRC = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; CRC[n] = c >>> 0; }
  const crc32 = (bytes) => { let c = 0xffffffff; for (let i = 0; i < bytes.length; i++) c = CRC[(c ^ bytes[i]) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  function makeZip(entries) { // entries: [{ name, bytes: Uint8Array }]
    const enc = new TextEncoder(), now = new Date();
    const time = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
    const date = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
    const parts = [], central = [];
    let offset = 0;
    for (const e of entries) {
      const name = enc.encode(e.name), crc = crc32(e.bytes);
      const head = new DataView(new ArrayBuffer(30));
      head.setUint32(0, 0x04034b50, true); head.setUint16(4, 20, true); head.setUint16(6, 0x0800, true); head.setUint16(8, 0, true);
      head.setUint16(10, time, true); head.setUint16(12, date, true); head.setUint32(14, crc, true);
      head.setUint32(18, e.bytes.length, true); head.setUint32(22, e.bytes.length, true); head.setUint16(26, name.length, true);
      const cd = new DataView(new ArrayBuffer(46));
      cd.setUint32(0, 0x02014b50, true); cd.setUint16(4, 20, true); cd.setUint16(6, 20, true); cd.setUint16(8, 0x0800, true);
      cd.setUint16(12, time, true); cd.setUint16(14, date, true); cd.setUint32(16, crc, true);
      cd.setUint32(20, e.bytes.length, true); cd.setUint32(24, e.bytes.length, true); cd.setUint16(28, name.length, true); cd.setUint32(42, offset, true);
      parts.push(head.buffer, name, e.bytes);
      central.push(cd.buffer, name);
      offset += 30 + name.length + e.bytes.length;
    }
    const cdSize = central.reduce((sum, p) => sum + p.byteLength, 0);
    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true); end.setUint16(8, entries.length, true); end.setUint16(10, entries.length, true);
    end.setUint32(12, cdSize, true); end.setUint32(16, offset, true);
    return new Blob([...parts, ...central, end.buffer], { type: 'application/zip' });
  }
  let zipUrl = null;

  $('gfile').addEventListener('change', (e) => {
    const files = [...e.target.files];
    if (!files.length) return;
    $('gfiles').replaceChildren(); $('gout').hidden = true; $('gcopy').hidden = true;
    $('gchosen').textContent = 'Wybrane pliki: ' + files.map((f) => f.name).join(', ');
    BnoLive.prepare(files, (text) => {
      status(text);
      const st = BnoLive.state();
      $('gform').hidden = !st.loaded;
    });
  });

  $('ggen').addEventListener('click', async () => {
    const out = $('gout'), box = $('gfiles');
    box.replaceChildren();
    out.hidden = false; $('gcopy').hidden = true;
    const nazwa = $('gname').value.trim();
    if (!nazwa) { out.value = 'Wpisz nazwę treningu.'; return; }
    let dojazd = null;
    if ($('gstart').value.trim()) {
      dojazd = BnoGeo.parseLatLon($('gstart').value);
      if (!dojazd) { out.value = 'Nie rozumiem współrzędnych miejsca startu. Wpisz np. 52.2747, 20.9306 albo zostaw pole puste.'; return; }
    }
    out.value = 'Przygotowuję pliki treningu…';
    await new Promise((resolve) => setTimeout(resolve, 30));
    try {
      const pack = await BnoLive.exportPackage({ nazwa, opis: $('gdesc').value.trim(), miejsce: $('gplace').value.trim(), dojazd, ciecie: parseFloat($('gcontour').value) });
      // jeden plik ZIP: obraz mapy, siatka terenu i wpis treningu
      const json = JSON.stringify(pack.entry, null, 2);
      const entries = [];
      for (const f of pack.files) entries.push({ name: f.name, bytes: new Uint8Array(await (await fetch(f.url)).arrayBuffer()) });
      entries.push({ name: pack.entry.id + '.json', bytes: new TextEncoder().encode(json) });
      const zip = makeZip(entries);
      if (zipUrl) URL.revokeObjectURL(zipUrl);
      zipUrl = URL.createObjectURL(zip);
      const link = document.createElement('a');
      link.href = zipUrl; link.download = pack.entry.id + '.zip'; link.className = 'maplink';
      link.textContent = `Pobierz: ${pack.entry.id}.zip (${(zip.size / 1048576).toFixed(1).replace('.', ',')} MB)`;
      box.append(link);
      const list = document.createElement('p');
      list.className = 'note';
      list.textContent = 'W środku: ' + entries.map((e) => e.name).join(', ') + '.';
      box.append(list);
      out.value = json;
      $('gcopy').hidden = false;
      for (const t of pack.entry.trasy || []) {
        const miss = [t.punkty[0].typ !== 'start' && 'startu', t.punkty[t.punkty.length - 1].typ !== 'meta' && 'mety'].filter(Boolean);
        if (miss.length) list.textContent += ` Uwaga: trasa ${t.nazwa} nie ma ${miss.join(' ani ')}.`;
      }
      if (!pack.entry.trasy) list.textContent += ' Uwaga: paczka nie zawiera trasy (nie dołączono pliku trasy), więc uczestnik nie dostanie przycisku „Następny punkt”.';
    } catch (err) {
      out.value = err.message;
    }
  });

  $('gcopy').addEventListener('click', () => {
    const out = $('gout');
    out.select();
    const done = () => { $('gcopy').textContent = 'Skopiowano'; setTimeout(() => { $('gcopy').textContent = 'Kopiuj wpis'; }, 2000); };
    if (navigator.clipboard) navigator.clipboard.writeText(out.value).then(done).catch(() => {}); else done();
  });

  $('gpreview').addEventListener('click', () => { $('tabbtn-live').click(); window.scrollTo(0, 0); });
})();

// Zakładka "Generacja danych": przygotowanie kompletu plików treningu przez admina.
(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const status = (text) => { $('gstatus').textContent = text; };

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
      for (const f of pack.files) {
        const link = document.createElement('a');
        link.href = f.url; link.download = f.name; link.className = 'maplink';
        link.textContent = `Pobierz: ${f.name} (${f.label}, ${Math.round(f.size / 1024)} kB)`;
        box.append(link);
      }
      out.value = JSON.stringify(pack.entry, null, 2);
      $('gcopy').hidden = false;
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

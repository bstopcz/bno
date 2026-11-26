// Zakładka "Założenia": tabela prędkości generowana z tych samych liczb, których używa silnik.
(function () {
  'use strict';
  const { TERRAIN, CLIMB_FACTOR } = BnoCore;
  const body = document.getElementById('speeds');
  for (const t of TERRAIN) {
    if (t.internal) continue;
    if (t.ocad && !body.dataset.ocadHeader) { // klasy rozróżniane tylko przy czytaniu pliku OCAD
      body.dataset.ocadHeader = '1';
      const sep = document.createElement('tr'), th = document.createElement('th');
      th.colSpan = 4; th.textContent = 'Tylko z pliku OCAD (z obrazu nie da się tego odróżnić)'; th.style.textAlign = 'left';
      sep.append(th); body.append(sep);
    }
    const tr = document.createElement('tr');
    const name = document.createElement('td'), sw = document.createElement('i');
    sw.style.background = `rgb(${t.rgb.join(',')})`;
    name.append(sw, t.name);
    const mult = document.createElement('td'), speed = document.createElement('td'), ex = document.createElement('td');
    if (t.cost === Infinity) {
      mult.textContent = '—'; speed.textContent = 'nie do przejścia'; ex.textContent = '—';
      tr.className = 'blocked';
    } else {
      mult.textContent = '×' + String(t.cost).replace('.', ',');
      speed.textContent = Math.round(100 / t.cost) + '%';
      ex.textContent = Math.round(100 * t.cost) + ' m';
    }
    tr.append(name, mult, speed, ex);
    body.append(tr);
  }
  for (const el of document.querySelectorAll('[data-climb]')) el.textContent = CLIMB_FACTOR;

  // ---- Twoje tempo: mnożniki policzone z zapisanych biegów ----
  const $ = (id) => document.getElementById(id), S = window.BnoStore;
  const num = (v) => String(v).replace('.', ',');
  function renderPace() {
    const s = S.summary(), box = $('pace');
    $('pon').checked = s.on;
    if (s.base) {
      const sec = Math.round(s.base * 1000);
      $('pstate').textContent = `Twoje tempo po ścieżce i nawierzchni: ${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')} min/km (z ${s.baseMetres} m pomiaru).`
        + (s.on ? '' : ' Własne tempo jest wyłączone – warianty liczą się według tabeli standardowej.');
    } else $('pstate').textContent = `Za mało danych: potrzeba ${s.need.base} m biegu po ścieżkach lub nawierzchni z trasą w apce (masz ${s.baseMetres} m). Do tego czasu warianty liczą się według tabeli standardowej.`;
    box.replaceChildren();
    const row = (cells, cls) => { const tr = document.createElement('tr'); if (cls) tr.className = cls; for (const c of cells) { const td = document.createElement('td'); td.textContent = c; tr.append(td); } box.append(tr); };
    for (const r of s.rows) {
      if (r.internal || r.def === Infinity || r.def === 1) continue;
      if (!r.metres && TERRAIN[r.i].ocad) continue; // rzadkie klasy pokazujemy dopiero, gdy są dane
      row([r.name, '×' + num(r.def), r.mine != null ? '×' + num(r.mine) : '—', r.metres + ' m' + (r.mine == null && s.base ? ` (trzeba ${s.need.cls})` : '')]);
    }
    row(['1 m w górę = … m po płaskim', num(CLIMB_FACTOR), s.climb != null ? num(s.climb) : '—', s.climbMetres + ' m podejść' + (s.climb == null ? ` (trzeba ${s.need.climb})` : '')]);
  }
  $('pon').addEventListener('change', () => S.setOn($('pon').checked));
  $('preset').addEventListener('click', () => {
    const b = $('preset');
    if (b.dataset.armed !== '1') { b.dataset.armed = '1'; b.textContent = 'Na pewno wyzerować?'; setTimeout(() => { b.dataset.armed = ''; b.textContent = 'Wyzeruj moje tempo'; }, 3000); return; }
    b.dataset.armed = ''; b.textContent = 'Wyzeruj moje tempo';
    S.resetPace();
  });
  $('bexport').addEventListener('click', () => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([S.exportAll()], { type: 'application/json' }));
    a.download = `bno-kopia-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.append(a); a.click(); a.remove();
    $('bstate').textContent = `Kopia zapisana do pliku (${S.runs().length} przebiegów i Twoje tempo).`;
  });
  $('bimport').addEventListener('change', (e) => {
    const f = e.target.files[0];
    if (!f) return;
    f.text().then((t) => { const r = S.importAll(t); $('bstate').textContent = `Wczytano kopię: ${r.runs} przebiegów i tempo.`; })
      .catch((err) => { $('bstate').textContent = err.message; });
    e.target.value = '';
  });
  window.addEventListener('bno-store', renderPace);
  renderPace();
})();

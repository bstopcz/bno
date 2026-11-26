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
})();

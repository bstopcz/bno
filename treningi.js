// Zakładka "Treningi": gotowe, skalibrowane mapy z pliku treningi/treningi.json.
// Lista leży w repozytorium strony, więc zmienić ją może tylko osoba z prawem zapisu do repo (admin).
(function () {
  'use strict';
  const box = document.getElementById('trainings');
  const note = document.getElementById('trainings-note');

  const el = (tag, cls, text) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  };

  function card(t) {
    const c = el('article', 'card');
    c.append(el('h3', null, t.nazwa || 'Trening bez nazwy'));
    const facts = [];
    if (t.skala) facts.push('skala 1:' + String(t.skala).replace(/\B(?=(\d{3})+(?!\d))/g, ' '));
    if (t.ciecie) facts.push('warstwice co ' + String(t.ciecie).replace('.', ',') + ' m');
    facts.push(t.rodzaj === 'sprint' ? 'sprint' : 'mapa leśna');
    c.append(el('p', 'facts', facts.join(' · ')));
    if (t.opis) c.append(el('p', null, t.opis));

    const where = el('div', 'where');
    where.append(el('b', null, 'Gdzie to jest'));
    where.append(el('p', null, t.miejsce || 'Brak opisu dojazdu.'));
    const d = t.dojazd;
    if (d && isFinite(d.lat) && isFinite(d.lon)) {
      const a = el('a', 'maplink', 'Prowadź do miejsca startu w Mapach Google');
      a.href = 'https://www.google.com/maps/dir/?api=1&destination=' + encodeURIComponent(d.lat + ',' + d.lon);
      a.target = '_blank'; a.rel = 'noopener';
      where.append(a);
    }
    c.append(where);

    const open = el('button', 'on', 'Otwórz mapę');
    open.addEventListener('click', () => {
      BnoLive.openTraining(t);
      document.getElementById('tabbtn-live').click();
      window.scrollTo(0, 0);
    });
    c.append(open);
    return c;
  }

  fetch('treningi/treningi.json', { cache: 'no-cache' })
    .then((r) => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
    .then((list) => {
      const ok = (Array.isArray(list) ? list : []).filter((t) => t && t.plik && Array.isArray(t.kalibracja) && t.kalibracja.length >= 2);
      box.replaceChildren(...ok.map(card));
      note.textContent = ok.length ? '' : 'Nie ma jeszcze żadnego treningu. Wróć tu później albo wczytaj własną mapę w zakładce „Na żywo”.';
    })
    .catch(() => {
      note.textContent = 'Nie udało się pobrać listy treningów. Sprawdź połączenie z internetem i odśwież stronę.';
    });
})();

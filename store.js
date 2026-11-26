// Dane biegacza trzymane w tym telefonie (localStorage): zapisane przebiegi i własne tempo w terenie.
// Nic nie jest wysyłane na serwer. Kopię zapasową robi się plikiem (exportAll / importAll).
(function (root) {
  'use strict';
  const { TERRAIN, CLIMB_FACTOR } = root.BnoCore;
  const RUNS = 'bno-runs', PACE = 'bno-pace';
  const MAX_RUNS = 25;      // tyle ostatnich przebiegów pamiętamy
  const MIN_BASE_M = 300;   // tyle metrów po ścieżce/asfalcie trzeba, żeby znać tempo bazowe
  const MIN_CLASS_M = 200;  // tyle metrów w danym terenie, żeby podmienić jego mnożnik
  const MIN_CLIMB_M = 40;   // tyle metrów podejść, żeby podmienić przelicznik przewyższeń

  const mem = {}; // zapas, gdy przeglądarka nie daje localStorage
  const read = (k, d) => { try { const v = JSON.parse(localStorage.getItem(k)); return v == null ? (k in mem ? mem[k] : d) : v; } catch (e) { return k in mem ? mem[k] : d; } };
  const write = (k, v) => { mem[k] = v; try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch (e) { return false; } };
  let asked = false;
  // prosimy przeglądarkę, żeby nie czyściła danych tej strony przy braku miejsca
  const keep = () => { if (!asked && root.navigator && navigator.storage && navigator.storage.persist) { asked = true; navigator.storage.persist().catch(() => {}); } };
  const changed = () => { try { root.dispatchEvent(new Event('bno-store')); } catch (e) { /* poza przeglądarką */ } };

  // ---- przebiegi ----
  const runs = () => read(RUNS, []);
  function putRuns(list) {
    while (list.length > MAX_RUNS) list.shift();
    while (!write(RUNS, list) && list.length > 1) list.shift(); // brak miejsca: wypadają najstarsze
  }
  function saveRun(run) {
    keep();
    const list = runs().filter((r) => r.id !== run.id);
    list.push(run);
    list.sort((a, b) => a.id - b.id);
    putRuns(list);
    changed();
  }
  function deleteRun(id) { putRuns(runs().filter((r) => r.id !== id)); changed(); }

  // ---- własne tempo ----
  // cls[i] = [metry, sekundy] z odcinków bez przeciętych warstwic; climb = [sekundy, metry × mnożnik terenu,
  // metry podejścia × mnożnik terenu, metry podejścia] z odcinków z warstwicami.
  const pace = () => Object.assign({ on: true, cls: {}, climb: [0, 0, 0, 0] }, read(PACE, {}));
  const BASE = TERRAIN.map((t, i) => (t.cost === 1 ? i : -1)).filter((i) => i >= 0);

  function summary() {
    const p = pace();
    let bd = 0, bt = 0;
    for (const i of BASE) { const a = p.cls[i]; if (a) { bd += a[0]; bt += a[1]; } }
    const base = bd >= MIN_BASE_M && bt > 0 ? bt / bd : null; // sekundy na metr po ścieżce
    const rows = TERRAIN.map((t, i) => {
      const a = p.cls[i] || [0, 0];
      let mine = null;
      if (base && t.cost !== Infinity && t.cost !== 1 && !t.internal && a[0] >= MIN_CLASS_M) mine = Math.min(20, Math.max(1, Math.round(a[1] / a[0] / base * 100) / 100));
      return { i, name: t.name, def: t.cost, mine, metres: Math.round(a[0]), internal: !!t.internal };
    });
    let climb = null;
    const c = p.climb;
    if (base && c[3] >= MIN_CLIMB_M && c[2] > 0) climb = Math.min(15, Math.max(2, Math.round((c[0] / base - c[1]) / c[2] * 10) / 10));
    return { on: p.on, base, baseMetres: Math.round(bd), rows, climb, climbMetres: Math.round(c[3]), need: { base: MIN_BASE_M, cls: MIN_CLASS_M, climb: MIN_CLIMB_M } };
  }

  // Mnożniki terenu do liczenia wariantów: własne tam, gdzie jest dość danych, reszta standardowa. null = same standardowe.
  function costs() {
    const s = summary();
    if (!s.on || !s.base) return null;
    return s.rows.map((r) => (r.mine != null ? r.mine : r.def));
  }
  function climbFactor() {
    const s = summary();
    return s.on && s.climb != null ? s.climb : CLIMB_FACTOR;
  }

  // windows: [{ cls, d (m), t (s), cross (przecięte warstwice) }], interval: cięcie warstwicowe w metrach (0 = brak)
  function addWindows(windows, interval) {
    if (!windows.length) return;
    keep();
    const p = pace();
    for (const w of windows) {
      const t = TERRAIN[w.cls];
      if (!t || t.cost === Infinity || !(w.d > 0) || !(w.t > 0)) continue;
      if (!w.cross || !interval) {
        const a = p.cls[w.cls] || (p.cls[w.cls] = [0, 0]);
        a[0] = Math.round((a[0] + w.d) * 10) / 10; a[1] = Math.round((a[1] + w.t) * 10) / 10;
      } else {
        const up = w.cross * interval / 2;
        p.climb = [p.climb[0] + w.t, p.climb[1] + w.d * t.cost, p.climb[2] + up * t.cost, p.climb[3] + up].map((v) => Math.round(v * 10) / 10);
      }
    }
    write(PACE, p);
    changed();
  }
  function setOn(on) { const p = pace(); p.on = !!on; write(PACE, p); changed(); }
  function resetPace() { write(PACE, { on: pace().on, cls: {}, climb: [0, 0, 0, 0] }); changed(); }

  // ---- kopia zapasowa ----
  const exportAll = () => JSON.stringify({ app: 'bks-wataha-bno', wersja: 1, zapisano: new Date().toISOString(), przebiegi: runs(), tempo: pace() });
  function importAll(text) {
    let d;
    try { d = JSON.parse(text); } catch (e) { throw new Error('To nie jest plik kopii zapasowej tej apki.'); }
    if (!d || d.app !== 'bks-wataha-bno' || !Array.isArray(d.przebiegi)) throw new Error('To nie jest plik kopii zapasowej tej apki.');
    const have = new Map(runs().map((r) => [r.id, r]));
    for (const r of d.przebiegi) if (r && typeof r.id === 'number' && Array.isArray(r.track)) have.set(r.id, r);
    const list = [...have.values()].sort((a, b) => a.id - b.id);
    putRuns(list);
    if (d.tempo && typeof d.tempo === 'object' && d.tempo.cls) write(PACE, Object.assign({ on: true, cls: {}, climb: [0, 0, 0, 0] }, d.tempo));
    changed();
    return { runs: d.przebiegi.length };
  }

  root.BnoStore = { runs, saveRun, deleteRun, summary, costs, climbFactor, addWindows, setOn, resetPace, exportAll, importAll };
})(typeof self !== 'undefined' ? self : this);

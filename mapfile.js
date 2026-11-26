// Otwieranie pliku mapy wybranego przez użytkownika: obraz bierzemy wprost, PDF zamieniamy na obraz.
// Wszystko dzieje się w przeglądarce; plik nie jest nigdzie wysyłany.
(function (root) {
  'use strict';
  const CDN = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/';
  const LONG_SIDE = 4000; // dłuższy bok obrazu z PDF w pikselach (A4 wychodzi w ok. 340 dpi)
  const MAX_DPI = 600;

  let libPromise = null;
  // Moduł do czytania PDF (pdf.js) pobieramy dopiero, gdy ktoś faktycznie wybierze PDF.
  function pdfLib() {
    if (root.pdfjsLib) return Promise.resolve(root.pdfjsLib);
    if (!libPromise) {
      libPromise = new Promise((resolve, reject) => {
        const fail = () => { libPromise = null; reject(new Error('Nie udało się pobrać modułu do czytania PDF. Sprawdź połączenie z internetem i spróbuj ponownie.')); };
        const s = document.createElement('script');
        s.src = CDN + 'pdf.min.js';
        s.onerror = fail;
        s.onload = async () => {
          try {
            // skrypt pomocniczy z innej domeny nie może być uruchomiony wprost w tle, więc podajemy go jako lokalną kopię
            const code = await (await fetch(CDN + 'pdf.worker.min.js')).text();
            root.pdfjsLib.GlobalWorkerOptions.workerSrc = URL.createObjectURL(new Blob([code], { type: 'text/javascript' }));
            resolve(root.pdfjsLib);
          } catch (err) { fail(); }
        };
        document.head.append(s);
      });
    }
    return libPromise;
  }

  // Zwraca { url, name, dpi, pdf, pages }: url obrazu do wczytania, nazwę pliku obrazu i (dla PDF) jego DPI.
  async function open(file) {
    const isPdf = file.type === 'application/pdf' || /\.pdf$/i.test(file.name);
    if (!isPdf) return { url: URL.createObjectURL(file), name: file.name, dpi: null, pdf: false, pages: 1 };
    const pdfjs = await pdfLib();
    let doc;
    try {
      doc = await pdfjs.getDocument({ data: await file.arrayBuffer() }).promise;
    } catch (err) {
      throw new Error('Nie udało się otworzyć tego PDF-a (plik uszkodzony albo zabezpieczony hasłem).');
    }
    const page = await doc.getPage(1);
    const base = page.getViewport({ scale: 1 }); // 1 jednostka = 1/72 cala
    const scale = Math.min(LONG_SIDE / Math.max(base.width, base.height), MAX_DPI / 72);
    const vp = page.getViewport({ scale });
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(vp.width); canvas.height = Math.round(vp.height);
    const g = canvas.getContext('2d');
    g.fillStyle = '#fff'; g.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: g, viewport: vp }).promise;
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
    if (!blob) throw new Error('Nie udało się zamienić PDF-a na obraz (za mało pamięci?).');
    return { url: URL.createObjectURL(blob), name: file.name.replace(/\.pdf$/i, '') + '.png', dpi: scale * 72, pdf: true, pages: doc.numPages };
  }

  root.BnoFile = { open };
})(typeof self !== 'undefined' ? self : this);

(() => {
  'use strict';

  const grid = document.getElementById('grid');
  const countEl = document.getElementById('book-count');
  const searchInput = document.getElementById('search-input');
  const seriesSelect = document.getElementById('series-select');
  const emptyState = document.getElementById('empty-state');

  let allBooks = [];

  function populateSeries(books) {
    const counts = new Map();
    for (const b of books) {
      const s = b.series || 'Lainnya';
      counts.set(s, (counts.get(s) || 0) + 1);
    }

    // Only list series with >= 2 books as dedicated filters, sorted alphabetically
    const multiSeries = [...counts.entries()]
      .filter(([, c]) => c >= 2)
      .sort((a, b) => a[0].localeCompare(b[0]));

    const frag = document.createDocumentFragment();
    for (const [series, cnt] of multiSeries) {
      const opt = document.createElement('option');
      opt.value = series;
      opt.textContent = `${series} (${cnt})`;
      frag.appendChild(opt);
    }
    seriesSelect.appendChild(frag);
  }

  function render(books) {
    grid.innerHTML = '';
    countEl.textContent = `${books.length} buku`;
    emptyState.classList.toggle('hidden', books.length > 0);

    const frag = document.createDocumentFragment();
    for (const b of books) {
      const card = document.createElement('a');
      card.className = 'card';
      card.href = `reader.html?book=${encodeURIComponent(b.id)}`;
      card.title = b.title;

      const thumbWrap = document.createElement('div');
      thumbWrap.className = 'thumb-wrap';

      if (b.cover) {
        const img = document.createElement('img');
        img.src = b.cover;
        img.alt = b.title;
        img.loading = 'lazy';
        img.decoding = 'async';
        thumbWrap.appendChild(img);
      }

      const badges = document.createElement('div');
      badges.className = 'badge-row';

      if (b.hasAudio) {
        const ab = document.createElement('span');
        ab.className = 'badge badge-audio';
        ab.textContent = 'Audio';
        badges.appendChild(ab);
      }

      const pb = document.createElement('span');
      pb.className = 'badge';
      pb.textContent = `${b.pages}p`;
      badges.appendChild(pb);

      thumbWrap.appendChild(badges);
      card.appendChild(thumbWrap);

      const meta = document.createElement('div');
      meta.className = 'card-meta';
      const title = document.createElement('p');
      title.className = 'card-title';
      title.textContent = b.title;
      meta.appendChild(title);
      card.appendChild(meta);

      frag.appendChild(card);
    }
    grid.appendChild(frag);
  }

  function applyFilter() {
    const q = searchInput.value.trim().toLowerCase();
    const series = seriesSelect.value;
    const filtered = allBooks.filter((b) => {
      if (series && b.series !== series) return false;
      if (q && !b.title.toLowerCase().includes(q)) return false;
      return true;
    });
    render(filtered);
  }

  async function init() {
    try {
      const res = await fetch('library.json');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      allBooks = await res.json();
      populateSeries(allBooks);
      render(allBooks);
    } catch (err) {
      countEl.textContent = 'Error';
      emptyState.textContent = `Gagal memuat daftar buku: ${err.message}`;
      emptyState.classList.remove('hidden');
    }
  }

  searchInput.addEventListener('input', applyFilter);
  seriesSelect.addEventListener('change', applyFilter);

  init();
})();

<script>
	import App from './App.svelte';
  import { onMount } from 'svelte';
  import { createClient } from '@supabase/supabase-js';
  import Select from 'svelte-select';

  /* ─────────── Supabase init ─────────── */
  const supabase = createClient(
    import.meta.env.VITE_SUPABASE_URL,
    import.meta.env.VITE_SUPABASE_ANON_KEY
  );

  /* ─────────── Reactive state ─────────── */
  let searchQuery   = '';
  let results       = [];
  let loading       = false;
  let error         = null;

  /* pagination */
  let currentPage   = 1;
  const pageSize    = 20;
  let hasMorePages  = false;
  let totalHits     = 0;
  let totalPages    = 0;

  /* summary counts */
  let totalMeetings   = 0;
  let totalMunis      = 0;
  let totalProvinces  = 0;

  /* UI controls */
  let municipalities  = [];
  let muniFilter      = null;        // {label,value}
  let provinces       = [];
  let provinceFilter  = null;        // {label,value}
  let sortBy          = { label: 'Newest first', value: 'date' };

  let hasSearched    = false;       // guards “No results found”
  $: provinceOnly = !searchQuery.trim() && !muniFilter && !!provinceFilter;

  // when searchQuery updates hasSearched is reset
  $: if (searchQuery) {
    hasSearched = false;
  }

  /* --- constants --- */
  const AVERAGE_WPM        = 150;      // tweak to suit your speakers
  const SECONDS_PER_WORD   = 60 / AVERAGE_WPM;

  /* --- helpers --- */
  const formatTime = s =>
    s != null
      ? `${Math.floor(s / 60)}:${Math.floor(s % 60)
          .toString()
          .padStart(2, '0')}`
      : '';

  const formatDate = iso =>
    iso ? new Date(iso).toLocaleDateString() : '';

  /** Convert "hh:mm:ss" | "mm:ss" | seconds number to seconds number */
  function toSeconds(t) {
    if (typeof t === 'number') return t;
    if (!t) return 0;
    return t.split(':').map(Number).reduce((acc, cur) => acc * 60 + cur, 0);
  }

  /* --- first-match utilities --- */
  function wordsBeforeFirstMention(text, termRegex) {
    if (!termRegex) return 0;
    const m = termRegex.exec(text);
    if (!m) return 0;              // term not found (shouldn’t happen)
    return text
      .slice(0, m.index)           // text *before* the hit
      .trim()
      .split(/\s+/)
      .filter(Boolean).length;     // # of words preceding the hit
  }

  function calcJumpSec(row, termRegex) {
    const words  = wordsBeforeFirstMention(row.text, termRegex);
    const base   = toSeconds(row.start_time); // seconds into the video where paragraph starts
    const offset = Math.round(words * SECONDS_PER_WORD); // ≈ seconds into paragraph
    return Math.max(base + offset - 8, 0); // “-8 s” pre-roll for context
  }

  /* build regex each time query changes */
  $: highlightRegex = (() => {
    if (!searchQuery.trim()) return null;
    const terms =
      searchQuery.match(/"[^"]+"|\w+/g)?.map(t => t.replace(/"/g, ''));
    if (!terms?.length) return null;
    return new RegExp(`(${terms.join('|')})`, 'gi');
  })();

  function highlight(text) {
    return highlightRegex
      ? text.replace(highlightRegex, '<mark>$1</mark>')
      : text;
  }

  function ytLink(url = '', sec = 0) {
    if (!url) return '#';
    return `${url}${url.includes('?') ? '&' : '?'}t=${sec}s`;
  }

  async function retry(fn, retries = 3, delay = 1000) {
  for (let i = 0; i < retries; i++) {
    try {
      return await fn();
    } catch (err) {
      if (i === retries - 1) throw err;
      await new Promise(r => setTimeout(r, delay));
    }
  }
}

  /* ─────────── Search RPC ─────────── */
  async function searchParagraphs() {
    const hasKeywords  = searchQuery.trim().length > 0;
    const hasMuni      = !!muniFilter;
    const hasProvince  = !!provinceFilter;

    if (provinceOnly) {
      hasSearched = true;
      return;
    }

    if (!hasKeywords && !hasMuni && !hasProvince) {
      // Nothing to search for
      results = [];
      totalHits = totalPages = totalMeetings = totalMunis = totalProvinces = 0;
      hasMorePages = false;
      hasSearched  = false;
      return;
    }

    loading = true;
    error   = null;
    hasSearched = true;

    const termRegex = (() => {
      if (!hasKeywords) return null;
      const terms =
        searchQuery.match(/"[^"]+"|\w+/g)?.map(t => t.replace(/"/g, ''));
      return terms?.length ? new RegExp(`\\b(${terms.join('|')})\\b`, 'i') : null;
    })();

    const muniParam = hasMuni
      ? (typeof muniFilter === 'object' ? muniFilter.value : muniFilter)
      : null;

    const provParam = hasProvince
      ? (typeof provinceFilter === 'object' ? provinceFilter.value : provinceFilter)
      : null;

    const qParam = hasKeywords ? searchQuery : '';

    const rpcName =
      (!hasKeywords && (hasProvince || hasMuni))
        ? 'search_paragraphs_geo'
        : 'search_paragraphs';

    console.log(
      `RPC: ${rpcName} q=${qParam}, page=${currentPage}, pagesize=${pageSize}, ` +
      `muni=${muniParam}, prov=${provParam}, sort_by=${sortBy}`
    );

    try {
      let data;
      await retry(async () => {
        const response = await supabase.rpc(
          rpcName,
          {
            q: qParam,
            page: currentPage,
            pagesize: pageSize,
            municipality_filter: muniParam,
            province_filter:     provParam,
            sort_by: typeof sortBy === 'object' ? sortBy.value : sortBy
          }
        );
        if (response.error) throw response.error;
        data = response.data;
});

      results = (data ?? []).map(r => ({
        ...r,
        jumpSec: calcJumpSec(r, termRegex)
      }));

      if (results.length) {
        totalHits       = results[0].total_hits;
        totalMeetings   = results[0].total_meetings;
        totalMunis      = results[0].total_munis;
        totalProvinces  = results[0].total_provinces ?? 0;
        totalPages      = Math.ceil(totalHits / pageSize);
      } else {
        totalHits = totalPages = totalMeetings = totalMunis = totalProvinces = 0;
      }
      hasMorePages = currentPage < totalPages;
    } catch (err) {
      error = err.message;
      results = [];
      hasMorePages = false;
      totalHits = totalPages = totalMeetings = totalMunis = totalProvinces = 0;
    } finally {
      loading = false;
    }
  }

  function handleSearch() {
    currentPage = 1;
    searchParagraphs();
  }

  function goToPage(page) {
    currentPage = page;
    searchParagraphs();
  }

  /* — watch filters — */
  let lastMuniValue = null;
  $: if ((muniFilter ? muniFilter.value : null) !== lastMuniValue) {
    if (lastMuniValue !== null) handleSearch();
    lastMuniValue = muniFilter ? muniFilter.value : null;
  }

  let lastProvValue = null;
  $: if ((provinceFilter ? provinceFilter.value : null) !== lastProvValue) {
    if (lastProvValue !== null) handleSearch();
    lastProvValue = provinceFilter ? provinceFilter.value : null;
  }

  /* ─────────── Load dropdown options ─────────── */
  onMount(async () => {
    const { data, error: joinError } = await supabase
      .from('municipalities')
      .select('id, municipality, province, meetings!inner(id)')
      .order('municipality');

    if (joinError) {
      console.error('Error fetching municipalities / provinces:', joinError.message);
      error = `Failed to load filters: ${joinError.message}`;
      municipalities = provinces = [];
      return;
    }

    /* municipalities */
    municipalities = Array.from(new Set(data.map(row => row.municipality)))
      .sort()
      .map(muni => ({ label: muni, value: muni }));

    /* provinces */
    provinces = Array.from(new Set(data.map(row => row.province)))
      .sort()
      .map(p => ({ label: p, value: p }));
  });

  const sortOptions = [
    { label: 'Newest first', value: 'date' },
    { label: 'Relevance',    value: 'relevance' }
  ];
</script>

<!----- HTML ----->
<main class="municipal-search">
  <img src="/spyglass.png" alt="Municipal Search Logo" class="spyglass-img" />
  <!-- Hero -->
  <section class="hero">
    <h1>Search Municipal Meetings</h1>
    <!-- Search bar -->
    <div class="search-bar">
      <input
        type="text"
        placeholder="Enter a keyword…"
        bind:value={searchQuery}
        on:keyup={(e) => e.key === 'Enter' && handleSearch()} />
      <button on:click={handleSearch} disabled={loading}>
        {#if loading}<span class="spinner"></span>{/if}Search
      </button>
    </div>
  </section>

  <!-- Content layout -->
  <div class="content">

    <!-- Sidebar -------------------------------------------------------->
    <aside class="sidebar">
      <!-- Filters -->
      <div class="card">
        <h2>Filters</h2>

        <!-- Province filter -->
        <Select
          items={provinces}
          bind:value={provinceFilter}
          on:select={handleSearch}
          clearable={true}
          placeholder="All provinces"
          searchable={true}
        />

        <!-- Municipality filter -->
        <Select
          items={municipalities}
          bind:value={muniFilter}
          on:select={handleSearch}
          clearable={true}
          placeholder="All municipalities"
          searchable={true}
        />

        <!-- Sort selector -->
        <Select
          items={sortOptions}
          bind:value={sortBy}
          on:select={handleSearch}
          clearable={false}
          search={false}
        />
      </div>

      <!-- Summary (only when we have results) -->
      {#if totalHits && !error}
        <div class="card summary">
          <div><span>{totalHits.toLocaleString()}</span><small>segments</small></div>
          <div><span>{totalMeetings.toLocaleString()}</span><small>meetings</small></div>
        </div>
      {/if}
    </aside>

    <!-- Results area --------------------------------------------------->
    <section class="results">

      {#if error}
        <div class="alert error">Error: {error}</div>
      {/if}

      {#if totalHits && !error}
        <div class="pager top">
          <button on:click={() => goToPage(currentPage - 1)} disabled={currentPage===1||loading}>
            ‹ Prev
          </button>
          <span>Page {currentPage} / {totalPages}</span>
          <button on:click={() => goToPage(currentPage + 1)} disabled={!hasMorePages||loading}>
            Next ›
          </button>
        </div>
      {/if}

      <!-- Results list -->
      {#if results.length}
        <ul class="results-list">
          {#each results as r (r.id)}
            <li class="result-card">
              <header>
                <h3>{r.title}</h3>
                <span class="location">{r.municipality}, {r.province}</span>
                <time>{formatDate(r.held_at)}</time>
              </header>

              <p class="excerpt">{@html highlight(r.text)}</p>

              <footer>
                {#if r.start_time}
                  <span class="time">{formatTime(r.start_time)}</span>
                {/if}
                {#if r.video_url}
                <a
                  href={ytLink(r.video_url, r.jumpSec)}
                  target="_blank"
                  rel="noreferrer"
                >
                  ▶ Watch clip
                </a>
                {/if}
              </footer>
            </li>
          {/each}
        </ul>

        <div class="pager bottom">
          <button on:click={() => goToPage(currentPage - 1)} disabled={currentPage===1||loading}>
            ‹ Prev
          </button>
          <span>Page {currentPage} / {totalPages}</span>
          <button on:click={() => goToPage(currentPage + 1)} disabled={!hasMorePages||loading}>
            Next ›
          </button>
        </div>
   
      {:else if hasSearched && !loading && !error && !provinceOnly}
        <div class="alert">No results found – try different terms.</div>
      {/if}

    </section>
  </div>
</main>

<!----- CSS ----->
<style>
  :root {
    /* Core palette – tweak only these */
    --clr-bg:            #e8e8e3;   /* overall page background              */
    --clr-surface:       #e8e8e3;   /* cards, dark panels, buttons          */
    --clr-surface-glass: #fbfbfb; /* glass‑y card background     */
  
    --clr-text:          #1a4190;   /* main copy color                      */
    --clr-text-muted:    rgb(66, 69, 70);   /* subdued text (timestamps, hints)     */
  
    --clr-accent:        #1a4190;   /* brand / highlight                    */
    --clr-accent-hover:  #1a4190;   /* hover / active state                 */
  
    --clr-error:         #ef4444;   /* error state     */ 
    --clr-input:       #f7f6f6;   /* input fields, select boxes           */ 
    
  }
  
  /* ---------- Base ----------- */
  :global(html){font-size:14px;}
  :global(body){
    margin:0;
    color:var(--clr-text);
    background-color:var(--clr-bg);
    font-family: "finalsix", sans-serif;
font-weight: 500;
font-style: normal;
  }

  
  *{box-sizing:border-box;margin:0;padding:0}
  
  /* Glassy cards */
  .card{
    background:var(--clr-surface-glass);
    backdrop-filter:blur(12px);
    border:1px solid var(--clr-surface-alt);
    border-radius:10px;
    padding:1rem;
    margin-bottom:1rem;
  }

  img {
    position: absolute;
  }

  .spyglass-img {
    top: 0rem;
    left: 0rem;
    width: 250px;
  }

  a {
    font-size: 0.8rem;
    font-weight: bold;
    font-family: "finalsix", sans-serif;
font-weight: 500;
font-style: normal;
  }
  
  /* ---------- Svelte Select ----------- */
  :global(.svelte-select){

    background-color: var(--clr-input)!important;
    color:var(--clr-accent);
    font-size:1rem!important;
    border-radius:4px!important;
    appearance:none;-webkit-appearance:none;-moz-appearance:none;
    --font-size:1rem;
    font-family: "finalsix", sans-serif !important;
font-weight: 400;
font-style: normal;
    margin:2rem 0!important;
    box-shadow: rgba(0, 0, 0, 0.16) 0px 10px 36px 0px, rgba(0, 0, 0, 0.06) 0px 0px 0px 1px !important;
  }
  :global(.svelte-select input){
    color:var(--clr-accent)!important;
    font-size:1rem!important;
    font-family: "finalsix", sans-serif !important;
  }
  :global(.svelte-select-list){
    font-size:1rem!important;
    z-index:20!important;
  }
  :global(.svelte-select-list .item){background-color:var(--clr-surface-alt)!important;}
  :global(.svelte-select-list .item.active){background-color:var(--clr-accent)!important;color:var(--clr-surface)!important;}
  :global(.svelte-select-list .item:hover),
  :global(.svelte-select-list .item.first.hover){background-color:var(--clr-accent-hover)!important;color:var(--clr-surface)!important;}
  :global(.svelte-select-list .list-item){
    background-color:var(--clr-surface-alt)!important;
    opacity: 1 !important;
  }
  /* ---------- Hero ----------- */
  .hero{text-align:center;padding:2rem 1rem 2.5rem;margin-top:2rem;position: relative;}
  .hero h1{
    font-size:clamp(3rem,5vw,2.6rem);
    color:var(--clr-text);
    text-shadow:
    1px 1px 2px rgba(0, 0, 0, 0.4),
   -1px -1px 0 rgba(255, 255, 255, 0.4);
    margin-bottom:.5rem;
    
    font-family: "finalsix", sans-serif;
font-weight: 500;
font-style: normal;
    
    
    text-transform:uppercase;
  }

  /* Search bar */
  .search-bar{display:flex;justify-content:center;gap:.75rem;flex-wrap:wrap}
  .search-bar input{
    flex:1 1 260px;max-width:400px;
    background-color: var(--clr-input)!important;
    border:1px solid var(--clr-surface);
    border-radius:8px;
    padding:.65rem .9rem;
    color:#4f5259;
    font-size:1.5rem;
    margin-top:2rem;
    margin-right: 1.5rem;
    font-family: "finalsix", sans-serif;
font-weight: 400;
font-style: normal;
    box-shadow: rgba(0, 0, 0, 0.16) 0px 10px 36px 0px, rgba(0, 0, 0, 0.06) 0px 0px 0px 1px;
  }
  .search-bar input:focus{outline:none;border-color:var(--clr-surface);}
  
  .search-bar input::placeholder{
    color:rgba(0, 0, 0, 0.112);
    font-weight:400;
    font-weight:200;
  }
  .search-bar button{
    all: unset;
    padding:.65rem 2rem;
    border-radius:8px;
    background:none;
    color:var(--clr-text);
    cursor:pointer;
    font-weight:600;
    display:flex;align-items:center;gap:.5rem;
    font-size:1rem;
    margin-top:2rem;
    transition: all .2s ease-in-out;
    box-shadow: rgba(0, 0, 0, 0.16) 0px 10px 36px 0px, rgba(0, 0, 0, 0.06) 0px 0px 0px 1px;
  }


  .search-bar button:hover{

    background-color: rgba(217, 189, 195, 0.07);


  }
  
  .spinner{width:14px;height:14px;border:2px solid #ffffff33;border-top:2px solid #fff;border-radius:50%;animation:spin 1s linear infinite}
  @keyframes spin{to{transform:rotate(360deg)}}
  
  /* ---------- Layout ----------- */
  .content{display:grid;grid-template-columns:240px 1fr;gap:1.75rem;max-width:1400px;margin:0 auto;padding:1.5rem 3rem;}
  .sidebar{
    position:sticky;height:fit-content;margin-top:3rem;
  }
  .results{min-width:0}
  
  /* ---------- Summary inside sidebar ----------- */
  .summary{ 
    display:grid;gap:.75rem;grid-template-columns:repeat(auto-fill,minmax(90px,1fr));text-align:center;font-size:.8rem;z-index:1;position:relative;}
  
    .sidebar .card{


      box-shadow: rgba(50, 50, 105, 0.15) 0px 2px 5px 0px, rgba(0, 0, 0, 0.05) 0px 1px 1px 0px;
   
    }
  
  
    .sidebar .card:first-child{position:relative;z-index:10; padding:2rem}
  .summary span{display:block;font-size:1.1rem;font-weight:700;color:var(--clr-accent);}
  
  /* ---------- Alerts ----------- */
  .alert{
    background:var(--clr-surface-alt);
    border:1px solid var(--clr-surface-alt);
    padding:.9rem 1rem;
    border-radius:8px;
    font-size:.85rem;
    color:var(--clr-text-muted);
    margin-bottom:1rem;
  }
  .alert.error{border-color:var(--clr-error);color:var(--clr-error);}
  
  /* ---------- Pagination ----------- */
  .pager{display:flex;justify-content:center;align-items:center;gap:1rem;font-size:.8rem;}
  .pager button{
    background:var(--clr-surface);
    border:1px solid var(--clr-surface-alt);
    padding:.45rem .9rem;
    border-radius:6px;
    color:var(--clr-text-muted);
    cursor:pointer;
  }
  .pager button:disabled{opacity:.35;cursor:not-allowed;}
  
  /* ---------- Results ----------- */
  .results-list{list-style:none;display:flex;flex-direction:column;gap:2rem;margin-top:1rem;}
  .result-card{
    background:var(--clr-surface);
    border:1px solid var(--clr-surface-alt);
    border-bottom:1px solid var(--clr-accent);
    padding:1rem 2rem;
    font-size:1.05rem;
    font-family: "dinosaur", sans-serif;
font-weight: 400;
font-style: normal;
  }
  .result-card header{display:flex;justify-content:space-between;align-items:center;margin-bottom:.45rem;}
  .result-card h3{
    font-size:1.2rem;
    font-weight:600;
    color:var(--clr-text);
    flex:1;
    margin-right:.5rem;
    line-height:1.35;
    font-family: "finalsix", sans-serif;
font-weight: 500;
font-style: normal;
  }
  .result-card time{font-size:1rem;color:var(--clr-text-muted);white-space:nowrap;font-family: "finalsix", sans-serif;
font-weight: 300;
font-style: normal;}
  .excerpt{color:var(--clr-text-muted);line-height:1.45;margin-bottom:.55rem;margin-top:1rem;}
  .excerpt :global(mark){background:var(--clr-accent-hover);color:var(--clr-surface);padding:0 .3em;border-radius:3px;}
  .result-card footer{display:flex;flex-wrap:wrap;gap:.75rem;font-size:.75rem;color:var(--clr-text-muted);align-items:center}
  .result-card footer a{color:var(--clr-accent);text-decoration:none}
  .location{
    font-weight:600;
    color:var(--clr-text-muted);
    font-size:1rem;
    padding: 0.2rem 1rem;
    font-family: "finalsix", sans-serif;
font-weight: 500;
font-style: normal;
    font-weight:400;
    background: var(--clr-surface-glass);
    border-radius: 7px;
    margin-right: 2rem;

    box-shadow: rgba(0, 0, 0, 0.05) 0px 6px 24px 0px, rgba(0, 0, 0, 0.08) 0px 0px 0px 1px;

  }
  
  /* ---------- Media queries ----------- */
  @media(max-width:900px){.content{grid-template-columns:1fr}.sidebar{position:static;display:flex;gap:1rem;overflow-x:auto}.card{min-width:200px}}
  @media(max-width:600px){.result-card{font-size:.78rem;padding:.8rem}.excerpt{-webkit-box-orient:vertical;-webkit-line-clamp:4;display:-webkit-box;overflow:hidden}}
  </style>
  
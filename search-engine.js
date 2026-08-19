// search-engine.js
// -----------------
// The book-finder's entire matching/ranking logic, in one place.
// Loaded by index.html via <script src="search-engine.js"></script> for
// real student use, AND loaded by search_tests.js via require() to run
// the regression test suite. Same exact code runs in both — no more
// copy-pasting logic into throwaway test scripts that can drift from
// what's actually live.
//
// Every function here is pure (no DOM access, no fetch) so it's testable
// in plain Node with nothing but a catalog.json file.

(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();   // Node / require()
  } else {
    root.BookFinder = factory();  // Browser <script> tag
  }
}(typeof self !== 'undefined' ? self : this, function () {

  // ---------- Synonym / tag expansion dictionary ----------
  // Maps things a student might actually type to the structured tags in catalog.json.
  const SYN = {
    genres: {
      "scary":"horror","horror":"horror","creepy":"horror","spooky":"horror",
      "mystery":"mystery","whodunit":"mystery","detective":"mystery",
      "thriller":"thriller","suspense":"thriller",
      "fantasy":"fantasy","magic":"fantasy","dragons":"fantasy",
      "sci-fi":"sci-fi","scifi":"sci-fi","science fiction":"sci-fi","space":"sci-fi","robot":"sci-fi","robots":"sci-fi","ai":"sci-fi","artificial intelligence":"sci-fi","cyborg":"sci-fi","android":"sci-fi",
      "romance":"romance","love story":"romance",
      "dystopian":"dystopian","dystopia":"dystopian",
      "historical":"historical fiction","history":"historical fiction",
      "realistic":"realistic fiction","contemporary":"contemporary",
      "nonfiction":"nonfiction","true story":"nonfiction","real story":"nonfiction","memoir":"memoir","biography":"memoir",
      "fiction":"fiction","made up story":"fiction","novel":"fiction",
      "graphic novel":"graphic novel","comic":"graphic novel",
      "adventure":"adventure","war":"war","verse":"verse novel","poetry":"verse novel",
      "how to draw":"how-to","how to":"how-to","instructional":"how-to","step by step":"how-to","tutorial":"how-to","diy":"how-to"
    },
    moods: {
      "scary":"scary","creepy":"creepy","spooky":"scary","dark":"dark","terrifying":"scary",
      "funny":"funny","hilarious":"funny","humor":"funny",
      "sad":"emotional","cry":"heartbreaking","emotional":"emotional","tearjerker":"heartbreaking","heavy":"heavy",
      "fast":"fast-paced","quick":"quick read","short":"quick read","fast read":"fast-paced",
      "epic":"epic","action":"fast-paced","suspenseful":"suspenseful","twisty":"twisty","twist":"twisty",
      "sweet":"sweet","wholesome":"sweet","cute":"sweet",
      "hopeful":"hopeful","uplifting":"hopeful","inspiring":"hopeful",
      "brutal":"brutal","intense":"intense","gritty":"gritty","honest":"honest","thought-provoking":"thought-provoking",
      "clever":"clever","witty":"witty","fun":"fun"
    },
    themes: {
      "friendship":"friendship","family":"family","revenge":"revenge","grief":"grief",
      "survival":"survival","identity":"identity","justice":"justice","social justice":"social justice",
      "trauma":"trauma","healing":"healing","first love":"first love","betrayal":"betrayal",
      "power":"power","war":"war","magic":"magic","found family":"found family","love":"love",
      "myth":"myth","mythology":"myth","ethics":"ethics","secret":"secret societies",
      "draw":"drawing","drawing":"drawing","how to draw":"drawing","cartooning":"drawing","sketching":"drawing","illustration":"drawing",
      "classic":"classic","classics":"classic","old book":"classic","timeless":"classic",
      "award":"award-winning","award winning":"award-winning","award-winning":"award-winning","newbery":"award-winning","caldecott":"award-winning",
      "happy ending":"ending-happy","sad ending":"ending-sad","bittersweet ending":"ending-bittersweet"
    },
    protagonist: {
      "girl":"female","female":"female","woman":"female","she":"female","her":"female",
      "boy":"male","male":"male","he":"male","him":"male",
      "lgbtq":"queer","queer":"queer","gay":"queer",
      "black":"Black","latina":"Latina","latino":"Latina",
      "group":"ensemble","team":"ensemble","crew":"ensemble"
    }
  };

  function extractPageFilter(qRaw){
    const q = qRaw.toLowerCase();
    let m;
    if((m = q.match(/(?:between\s+)?(\d+)\s*(?:-|to|and)\s*(\d+)\s*pages?/))){
      return {min: parseInt(m[1]), max: parseInt(m[2])};
    }
    if((m = q.match(/(?:under|less than|fewer than|shorter than|below)\s+(\d+)\s*pages?/))){
      return {min: 0, max: parseInt(m[1])};
    }
    if((m = q.match(/(?:over|more than|longer than|above)\s+(\d+)\s*pages?/))){
      return {min: parseInt(m[1]), max: Infinity};
    }
    if((m = q.match(/(?:about|around|approximately|roughly)\s+(\d+)\s*pages?/))){
      const n = parseInt(m[1]);
      return {min: Math.max(0, n-30), max: n+30};
    }
    return null;
  }

  function normalizeAuthor(a){
    return (a || '').toLowerCase().replace(/[.,]+$/,'').trim();
  }

  function isSameSeriesOrWork(refTitle, candidateTitle){
    const stop = new Set(['the','and','of','a','an','in','to','for','graphic','novel','edition']);
    const words = t => t.toLowerCase().replace(/[^a-z0-9 ]/g,' ').split(/\s+/).filter(w=>w.length>3 && !stop.has(w));
    const refWords = words(refTitle);
    const candWords = words(candidateTitle);
    if(refWords.length === 0) return false;
    const overlap = refWords.filter(w=>candWords.includes(w));
    return overlap.length >= Math.min(2, refWords.length);
  }

  function findReferenceBook(qRaw, catalog){
    const m = qRaw.match(/(?:similar\s+(?:books?|novels?|titles?)?\s*to|comparable\s+to|in the (?:style|vein) of|along the lines of|reminds?\s+me\s+of|something\s+like|read-?alikes?\s+for|readalikes?\s+for|in the same vein as|if i (?:liked|loved|enjoyed)|what should i read (?:if|after) i (?:liked|loved|enjoyed|read)|like)\s+(.+?)(?:[.?!]|$)/i);
    if(!m) return null;
    const ref = m[1].trim().toLowerCase();
    if(ref.length < 3) return null;

    function pickBest(candidates){
      const nonGN = candidates.filter(c => !(c.book.genres||[]).includes('graphic novel'));
      const pool = (nonGN.length ? nonGN : candidates).slice().sort((a,b)=>b.score-a.score);
      return pool[0].book;
    }

    const substrCandidates = [];
    catalog.forEach(b=>{
      const t = b.title.toLowerCase();
      if(t.includes(ref) || ref.includes(t)){
        substrCandidates.push({book:b, score: Math.min(t.length, ref.length)});
      }
    });
    if(substrCandidates.length) return pickBest(substrCandidates);

    const refWords = ref.split(/\s+/).filter(w=>w.length>3);
    const wordCandidates = [];
    catalog.forEach(b=>{
      const t = b.title.toLowerCase();
      const matches = refWords.filter(w=>t.includes(w)).length;
      if(matches > 0) wordCandidates.push({book:b, score: matches});
    });
    if(wordCandidates.length) return pickBest(wordCandidates);

    return null;
  }

  function expandQuery(qRaw){
    const q = qRaw.toLowerCase();
    const found = {genres:new Set(), moods:new Set(), themes:new Set(), protagonist:new Set()};
    for(const cat of Object.keys(SYN)){
      for(const key in SYN[cat]){
        const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const re = new RegExp('\\b' + escaped + '\\b', 'i');
        if(re.test(q)){
          found[cat].add(SYN[cat][key]);
        }
      }
    }
    return found;
  }

  const STOPWORDS = new Set(['book','books','story','stories','about','with','that','this','have','from','some','please','want','looking','find','something','read','reading']);

  function scoreBook(book, found, rawQuery){
    let score = 0;
    const g = new Set((book.genres||[]).map(s=>s.toLowerCase()));
    const m = new Set((book.moods||[]).map(s=>s.toLowerCase()));
    const t = new Set((book.themes||[]).map(s=>s.toLowerCase()));
    const p = new Set((book.protagonist||[]).map(s=>s.toLowerCase()));

    found.genres.forEach(v=>{ if(g.has(v.toLowerCase())) score += 3; });
    found.moods.forEach(v=>{ if(m.has(v.toLowerCase())) score += 2; });
    found.themes.forEach(v=>{ if(t.has(v.toLowerCase())) score += 2; });
    found.protagonist.forEach(v=>{ if(p.has(v.toLowerCase())) score += 3; });

    const haystack = (book.title+" "+book.author+" "+book.summary+" "+(book.subjects_text||"")+" "+(book.genres||[]).join(" ")+" "+(book.moods||[]).join(" ")+" "+(book.themes||[]).join(" ")).toLowerCase();
    const queryWords = rawQuery.toLowerCase().split(/[^a-z]+/).filter(w=>w.length>3 && !STOPWORDS.has(w));
    queryWords.forEach(w=>{
      if(haystack.includes(w)) score += 0.5;
    });

    const allWords = rawQuery.toLowerCase().split(/[^a-z]+/).filter(w=>w.length>0);
    const significantWords = allWords.filter(w=>w.length>2 && !STOPWORDS.has(w));
    for(let len = significantWords.length; len >= 2; len--){
      for(let start = 0; start + len <= significantWords.length; start++){
        const phrase = significantWords.slice(start, start+len).join(' ');
        if(haystack.includes(phrase)){
          score += len * 4;
        }
      }
    }

    const wantsGraphicNovel = /manga|graphic novel|comic/i.test(rawQuery);
    if(g.has('graphic novel') && !wantsGraphicNovel && !g.has('how-to')){
      score *= 0.15;
    }

    return score;
  }

  function whyLine(book, found){
    const reasons = [];
    found.genres.forEach(v=>{ if((book.genres||[]).map(s=>s.toLowerCase()).includes(v.toLowerCase())) reasons.push(v); });
    found.moods.forEach(v=>{ if((book.moods||[]).map(s=>s.toLowerCase()).includes(v.toLowerCase())) reasons.push(v); });
    found.themes.forEach(v=>{ if((book.themes||[]).map(s=>s.toLowerCase()).includes(v.toLowerCase())) reasons.push(v); });
    if(reasons.length===0) return book.summary;
    const uniq = [...new Set(reasons)].slice(0,3);
    return "Matches on " + uniq.join(", ") + ". " + book.summary;
  }

  function keepOnlyIfFirstVolumeAvailable(pool, fullCatalog){
    const trueFirstNumBySeries = new Map();
    fullCatalog.forEach(b=>{
      if(!b.series_name) return;
      const key = b.series_name.toLowerCase();
      const num = (b.series_number === null || b.series_number === undefined) ? Infinity : b.series_number;
      const current = trueFirstNumBySeries.get(key);
      if(current === undefined || num < current){
        trueFirstNumBySeries.set(key, num);
      }
    });
    return pool.filter(b=>{
      if(!b.series_name) return true;
      const trueFirst = trueFirstNumBySeries.get(b.series_name.toLowerCase());
      return b.series_number === trueFirst;
    });
  }

  // The full pipeline, exactly as runSearch() in index.html uses it —
  // exposed as one function so tests (and index.html) call the SAME path.
  function search(rawQuery, CATALOG){
    const found = expandQuery(rawQuery);

    const refBook = findReferenceBook(rawQuery, CATALOG);
    let excludeIds = new Set();
    if(refBook){
      const refAuthor = normalizeAuthor(refBook.author);
      excludeIds = new Set(
        CATALOG.filter(b =>
          isSameSeriesOrWork(refBook.title, b.title) ||
          (refAuthor && normalizeAuthor(b.author) === refAuthor)
        ).map(b=>b.id)
      );
      (refBook.genres||[]).forEach(g=>found.genres.add(g));
      (refBook.moods||[]).forEach(m=>found.moods.add(m));
      (refBook.themes||[]).forEach(t=>found.themes.add(t));
      (refBook.protagonist||[]).forEach(p=>found.protagonist.add(p));
    }

    const pageFilter = extractPageFilter(rawQuery);

    let pool = CATALOG.filter(b=>b.available && (b.copies_available||0) > 0 && !excludeIds.has(b.id));
    if(pageFilter){
      pool = pool.filter(b=>b.page_count && b.page_count >= pageFilter.min && b.page_count <= pageFilter.max);
    }
    pool = keepOnlyIfFirstVolumeAvailable(pool, CATALOG);

    const scored = pool
      .map(b=>({book:b, score: refBook ? scoreBook(b, found, rawQuery) + 0.01 : scoreBook(b, found, rawQuery)}))
      .filter(x=>x.score > 0 || refBook)
      .sort((a,b)=>b.score - a.score);

    const outOfStockMatches = CATALOG
      .filter(b=>!(b.available && (b.copies_available||0) > 0) && !excludeIds.has(b.id))
      .map(b=>({book:b, score:scoreBook(b, found, rawQuery)}))
      .filter(x=>x.score > 0).length;

    return { scored, found, refBook, pageFilter, outOfStockMatches };
  }

  return {
    SYN, extractPageFilter, normalizeAuthor, isSameSeriesOrWork,
    findReferenceBook, expandQuery, scoreBook, whyLine,
    keepOnlyIfFirstVolumeAvailable, search
  };

}));

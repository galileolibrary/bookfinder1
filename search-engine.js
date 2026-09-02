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
      "fiction":"fiction","made up story":"fiction",
      "graphic novel":"graphic novel","comic":"graphic novel",
      "adventure":"adventure","war":"war","verse":"verse novel","poetry":"verse novel",
      "spy":"spy","spies":"spy","espionage":"spy","secret agent":"spy","undercover":"spy",
      "heist":"heist","heists":"heist","robbery":"heist","burglary":"heist",
      "how to draw":"how-to","how to":"how-to","instructional":"how-to","step by step":"how-to","tutorial":"how-to","diy":"how-to",
      "superhero":"superhero","superheroes":"superhero","paranormal":"paranormal"
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
      "class conflict":"class conflict","social class":"class conflict","rich and poor":"class conflict","class differences":"class conflict",
      "myth":"myth","mythology":"myth","ethics":"ethics","secret":"secret societies",
      "draw":"drawing","drawing":"drawing","how to draw":"drawing","cartooning":"drawing","sketching":"drawing","illustration":"drawing",
      "classic":"classic","classics":"classic","old book":"classic","timeless":"classic",
      "coming of age":"coming-of-age","coming-of-age":"coming-of-age","orphan":"orphan","orphans":"orphan",
      "missing person":"missing person","missing persons":"missing person","good vs evil":"good vs evil","good versus evil":"good vs evil",
      "award":"award-winning","award winning":"award-winning","award-winning":"award-winning","newbery":"award-winning","caldecott":"award-winning",
      "happy ending":"ending-happy","sad ending":"ending-sad","bittersweet ending":"ending-bittersweet"
    },
    protagonist: {
      "girl":"female","female":"female","woman":"female","she":"female","her":"female",
      "teen":"teen","teenager":"teen","teenage":"teen","teens":"teen","high schooler":"teen","high school student":"teen",
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

  function extractConfidenceFilter(qRaw){
    // Translates a self-rated 1-10 reading confidence into a Lexile range —
    // students generally don't know their own Lexile number, but can rate
    // how confident they feel picking up a book. Low confidence maps to a
    // lower, more accessible range; this is intentionally generous (still
    // real, worthwhile YA content) rather than pointing toward children's
    // books — the goal is an accessible read, not a babyish one.
    const q = qRaw.toLowerCase();
    let m = q.match(/(\d{1,2})\s*\/\s*10/) || q.match(/(\d{1,2})\s*out of\s*10/) || q.match(/confidence[^\d]{0,10}(\d{1,2})/);
    if(!m) return null;
    let n = parseInt(m[1]);
    if(n < 1 || n > 10) return null;
    const base = 250 + (n - 1) * 90; // 1 -> 250L, 10 -> 1060L+ (open-ended)
    if(n >= 10) return {min: base, max: Infinity, confidence: n};
    return {min: base, max: base + 220, confidence: n};
  }

  function extractLexileFilter(qRaw){
    const q = qRaw.toLowerCase();
    let m;
    if(/lexile/.test(q) && (m = q.match(/(\d+)\s*(?:-|to|and)\s*(\d+)/))){
      return {min: parseInt(m[1]), max: parseInt(m[2])};
    }
    if((m = q.match(/lexile\s+(?:under|below|less than)\s+(\d+)/))){
      return {min: 0, max: parseInt(m[1])};
    }
    if((m = q.match(/lexile\s+(\d+)/))){
      const n = parseInt(m[1]);
      return {min: Math.max(0, n-100), max: n+100};
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

  function extractReferencePhrase(qRaw){
    const m = qRaw.match(/(?:similar\s+(?:books?|novels?|titles?)?\s*to|comparable\s+to|in the (?:style|vein) of|along the lines of|reminds?\s+me\s+of|something\s+like|read-?alikes?\s+for|readalikes?\s+for|in the same vein as|if i (?:liked|loved|enjoyed)|what should i read (?:if|after) i (?:liked|loved|enjoyed|read)|like)\s+(.+?)(?:[.?!]|$)/i);
    if(!m) return null;
    const ref = m[1].trim().toLowerCase();
    if(ref.length < 3) return null;
    return ref;
  }

  function stripArticle(s){
    return s.replace(/^(a|an|the)\s+/i, '');
  }

  // Returns {book, score} for the best candidate, or null. Exposing the
  // match score (not just the winning book) matters — it's what lets the
  // book-vs-media comparison below be a fair, quality-based decision
  // instead of "book always wins ties." Real bug found via testing: "The
  // Stranger" (a short, unrelated novel) used to beat a full, correct
  // "Stranger Things" media match purely by being checked first, even
  // though it only covers half the reference phrase.
  function pickBestBook(candidates){
    const nonGN = candidates.filter(c => !(c.book.genres||[]).includes('graphic novel'));
    const pool = (nonGN.length ? nonGN : candidates).slice().sort((a,b)=>b.score-a.score);
    return pool[0];
  }

  // Confident tier: the reference text and a real catalog title substring-
  // match each other (leading-article-tolerant).
  function findReferenceBookStrict(ref, catalog){
    const substrCandidates = [];
    catalog.forEach(b=>{
      const t = b.title.toLowerCase();
      const tStripped = stripArticle(t);
      if(t.includes(ref) || ref.includes(t) || tStripped.includes(ref) || ref.includes(tStripped)){
        const bestLen = Math.max(
          Math.min(t.length, ref.length),
          Math.min(tStripped.length, ref.length)
        );
        substrCandidates.push({book:b, score: bestLen});
      }
    });
    return substrCandidates.length ? pickBestBook(substrCandidates) : null;
  }

  // Loose tier: only shared individual words, no real substring match —
  // low confidence, since two unrelated titles can share a common word by
  // coincidence. Used only as a last resort, after media has a chance.
  function findReferenceBookLoose(ref, catalog){
    const refWords = ref.split(/\s+/).filter(w=>w.length>3);
    const wordCandidates = [];
    catalog.forEach(b=>{
      const t = b.title.toLowerCase();
      const matches = refWords.filter(w=>t.includes(w)).length;
      if(matches > 0) wordCandidates.push({book:b, score: matches});
    });
    return wordCandidates.length ? pickBestBook(wordCandidates) : null;
  }

  function findReferenceBook(qRaw, catalog){
    const ref = extractReferencePhrase(qRaw);
    if(!ref) return null;
    const strict = findReferenceBookStrict(ref, catalog);
    if(strict) return strict.book;
    const loose = findReferenceBookLoose(ref, catalog);
    return loose ? loose.book : null;
  }

  // Curated movie/TV -> tag mapping (media_overrides.json), for students
  // who know a show/movie but not a book. Matched by substring containment
  // against the curated key, either direction. Returns {media, score} so
  // its match quality can be compared fairly against a book match.
  //
  // Entries flagged "risky": true (common English words used as titles —
  // "You", "It", "Wednesday") only match when the FULL query also contains
  // an explicit media signal word. Without this, "a mystery like you would
  // enjoy" or "something like you described" would silently, incorrectly
  // match the show "You" every time — confirmed as a real false positive
  // during testing, not a hypothetical one.
  const MEDIA_SIGNAL_WORDS = /\b(show|series|movie|film|netflix|tv|television|watch|watched|watching|season|episode)\b/i;

  function findReferenceMedia(ref, mediaOverrides, fullQuery){
    let best = null, bestLen = 0;
    for(const key in (mediaOverrides||{})){
      if(key === '_comment') continue;
      const entry = mediaOverrides[key];
      if(entry.risky && !MEDIA_SIGNAL_WORDS.test(fullQuery || '')){
        continue;
      }
      if(ref.includes(key) || key.includes(ref)){
        const len = Math.min(key.length, ref.length);
        if(len > bestLen){ bestLen = len; best = entry; }
      }
    }
    return best ? {media: best, score: bestLen} : null;
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

  const STOPWORDS = new Set(['book','books','story','stories','about','with','that','this','have','from','some','please','want','looking','find','something','read','reading','like','the','and','was','were','are','for']);

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

    // Phrase matching: build candidates from the FULL ordered word sequence
    // (including short connector words like "to"/"of"), not the stopword-
    // filtered list — stripping "to" would make "enemies to lovers" or
    // "coming of age" impossible to ever reconstruct as a contiguous phrase,
    // since the real text needs that connector word to match at all. Still
    // require at least 2 SUBSTANTIAL words per phrase so we don't waste time
    // scoring meaningless connector-only fragments like "to the."
    const allWords = rawQuery.toLowerCase().split(/[^a-z]+/).filter(w=>w.length>0);
    for(let len = allWords.length; len >= 2; len--){
      for(let start = 0; start + len <= allWords.length; start++){
        const phraseWords = allWords.slice(start, start+len);
        const substantialCount = phraseWords.filter(w=>w.length>2 && !STOPWORDS.has(w)).length;
        if(substantialCount < 2) continue;
        const phrase = phraseWords.join(' ');
        if(haystack.includes(phrase)){
          score += len * 2.5;
        }
      }
    }

    // A small, always-on quality nudge for real literary recognition among
    // already-relevant results — previously this data only mattered if a
    // student explicitly typed "award-winning." Gated on score > 0 so it
    // never makes an otherwise-irrelevant award-winning book show up.
    if(score > 0 && t.has('award-winning')) score += 1.5;

    const wantsGraphicNovel = /manga|graphic novel|comic/i.test(rawQuery);
    if(g.has('graphic novel') && !wantsGraphicNovel && !g.has('how-to')){
      score *= 0.15;
    }

    return score;
  }

  function whyLine(book, found){
    return book.summary;
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
  function search(rawQuery, CATALOG, MEDIA_OVERRIDES){
    const found = expandQuery(rawQuery);

    const ref = extractReferencePhrase(rawQuery);
    let refBook = null;
    let refMedia = null;
    if(ref){
      const strictBookMatch = findReferenceBookStrict(ref, CATALOG);
      const mediaMatch = findReferenceMedia(ref, MEDIA_OVERRIDES, rawQuery);

      if(strictBookMatch && mediaMatch){
        // Compare match QUALITY (how much of the reference phrase each one
        // actually covers), not just tier — a short, generic book title
        // shouldn't beat a full, specific media match just by being
        // checked first. Ties favor the book, since real catalog data is
        // more precise than a curated approximation when equally strong.
        if(strictBookMatch.score >= mediaMatch.score){
          refBook = strictBookMatch.book;
        } else {
          refMedia = mediaMatch.media;
        }
      } else if(strictBookMatch){
        refBook = strictBookMatch.book;
      } else if(mediaMatch){
        refMedia = mediaMatch.media;
      } else {
        const loose = findReferenceBookLoose(ref, CATALOG);
        if(loose) refBook = loose.book;
      }
    }

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
    } else if(refMedia){
      (refMedia.genres||[]).forEach(g=>found.genres.add(g));
      (refMedia.moods||[]).forEach(m=>found.moods.add(m));
      (refMedia.themes||[]).forEach(t=>found.themes.add(t));
      (refMedia.protagonist||[]).forEach(p=>found.protagonist.add(p));
    }

    const pageFilter = extractPageFilter(rawQuery);
    const lexileFilter = extractLexileFilter(rawQuery);
    const confidenceFilter = extractConfidenceFilter(rawQuery);

    let pool = CATALOG.filter(b=>b.available && (b.copies_available||0) > 0 && !excludeIds.has(b.id));
    if(pageFilter){
      pool = pool.filter(b=>b.page_count && b.page_count >= pageFilter.min && b.page_count <= pageFilter.max);
    }
    if(lexileFilter){
      pool = pool.filter(b=>b.lexile_score && b.lexile_score >= lexileFilter.min && b.lexile_score <= lexileFilter.max);
    }
    if(confidenceFilter){
      pool = pool.filter(b=>b.lexile_score && b.lexile_score >= confidenceFilter.min && b.lexile_score <= confidenceFilter.max);
    }
    pool = keepOnlyIfFirstVolumeAvailable(pool, CATALOG);

    const hasHardFilter = !!(refBook || refMedia || pageFilter || lexileFilter || confidenceFilter);
    const scored = pool
      .map(b=>({book:b, score: (refBook || refMedia) ? scoreBook(b, found, rawQuery) + 0.01 : scoreBook(b, found, rawQuery)}))
      .filter(x=>x.score > 0 || hasHardFilter)
      .sort((a,b)=>b.score - a.score);

    const outOfStockMatches = CATALOG
      .filter(b=>!(b.available && (b.copies_available||0) > 0) && !excludeIds.has(b.id))
      .map(b=>({book:b, score:scoreBook(b, found, rawQuery)}))
      .filter(x=>x.score > 0).length;

    return { scored, found, refBook, refMedia, pageFilter, lexileFilter, confidenceFilter, outOfStockMatches };
  }

  return {
    SYN, extractPageFilter, extractLexileFilter, extractConfidenceFilter, normalizeAuthor, isSameSeriesOrWork,
    findReferenceBook, findReferenceBookStrict, findReferenceBookLoose, findReferenceMedia, extractReferencePhrase,
    expandQuery, scoreBook, whyLine,
    keepOnlyIfFirstVolumeAvailable, search
  };

}));

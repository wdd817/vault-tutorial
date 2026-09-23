(function(){
  'use strict';
  var html = document.documentElement;
  var pageSlug = html.dataset.page;
  var SIDEBAR_KEY = 'vt-sidebar';

  function qs(s, r){ return (r||document).querySelector(s); }
  function qsa(s, r){ return Array.prototype.slice.call((r||document).querySelectorAll(s)); }

  /* ---------- 主题 ---------- */
  var themeBtn = qs('#themeToggle');
  if (themeBtn) themeBtn.addEventListener('click', function(){
    var next = html.dataset.theme === 'dark' ? 'light' : 'dark';
    html.dataset.theme = next;
    try { localStorage.setItem('vt-theme', next); } catch(e){}
  });

  /* ---------- 侧边栏 ---------- */
  var sidebar = qs('#sidebar'), scrim = qs('#scrim'), navToggle = qs('#navToggle');
  function setNav(open){
    if(!sidebar) return;
    sidebar.classList.toggle('open', open);
    if(scrim) scrim.hidden = !open;
    if(navToggle) navToggle.setAttribute('aria-expanded', String(open));
    try { sessionStorage.setItem(SIDEBAR_KEY, open ? '1' : '0'); } catch(e){}
  }
  if(navToggle) navToggle.addEventListener('click', function(){ setNav(!sidebar.classList.contains('open')); });
  if(scrim) scrim.addEventListener('click', function(){ setNav(false); });

  /* 当前页高亮：正常由服务端渲染好 class="active"，这里只做兜底 */
  var current = qs('.sidebar a.active') || qs('.sidebar a[href="' + pageSlug + '.html"]');
  if(current){
    current.classList.add('active');
    if(window.innerWidth <= 980){
      var saved = null;
      try { saved = sessionStorage.getItem(SIDEBAR_KEY); } catch(e){}
      if(saved === '1') setNav(true);
    }
    var box = qs('.sidebar');
    if(box && current.offsetTop > box.clientHeight * 0.7){
      box.scrollTop = Math.max(0, current.offsetTop - box.clientHeight * 0.35);
    }
  }

  /* ---------- 复制代码 ---------- */
  qsa('[data-copy]').forEach(function(btn){
    btn.addEventListener('click', function(){
      var wrap = btn.closest('.code-block');
      var code = wrap && wrap.querySelector('code');
      if(!code) return;
      var text = code.innerText;
      var done = function(){
        btn.textContent = '已复制'; btn.classList.add('ok');
        setTimeout(function(){ btn.textContent = '复制'; btn.classList.remove('ok'); }, 1600);
      };
      if(navigator.clipboard && navigator.clipboard.writeText){
        navigator.clipboard.writeText(text).then(done, function(){ fallback(text, done); });
      } else { fallback(text, done); }
    });
  });
  function fallback(text, done){
    var ta = document.createElement('textarea');
    ta.value = text; ta.setAttribute('readonly',''); ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.select();
    try { document.execCommand('copy'); done(); } catch(e){}
    document.body.removeChild(ta);
  }

  /* ---------- 页内 TOC 高亮 ---------- */
  var tocLinks = qsa('.toc a');
  if(tocLinks.length && 'IntersectionObserver' in window){
    var map = {};
    tocLinks.forEach(function(a){ map[decodeURIComponent(a.getAttribute('href').slice(1))] = a; });
    var targets = Object.keys(map).map(function(id){ return document.getElementById(id); }).filter(Boolean);
    var seen = new Set();
    var io = new IntersectionObserver(function(entries){
      entries.forEach(function(en){
        if(en.isIntersecting){ seen.add(en.target.id); }
        else { seen.delete(en.target.id); }
      });
      var firstId = null;
      for(var i=0;i<targets.length;i++){ if(seen.has(targets[i].id)){ firstId = targets[i].id; break; } }
      tocLinks.forEach(function(a){ a.classList.remove('active'); });
      if(firstId && map[firstId]) map[firstId].classList.add('active');
    }, { rootMargin: '-72px 0px -72% 0px', threshold: 0 });
    targets.forEach(function(t){ io.observe(t); });
  }

  /* ---------- 站内搜索 ---------- */
  var modal = qs('#searchModal'), input = qs('#searchInput'), results = qs('#searchResults'),
      openBtn = qs('#searchOpen'), closeBtn = qs('#searchClose');
  var INDEX = null, loading = null, selected = -1, currentItems = [];

  function loadIndex(){
    if(INDEX) return Promise.resolve(INDEX);
    if(loading) return loading;
    loading = fetch('assets/search-index.json', { cache: 'force-cache' })
      .then(function(r){ if(!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(function(j){ INDEX = j; return j; })
      .catch(function(err){ loading = null; throw err; });
    return loading;
  }

  function openSearch(){
    if(!modal) return;
    modal.hidden = false;
    input.value = ''; renderHint('正在加载索引…');
    setTimeout(function(){ input.focus(); }, 20);
    loadIndex().then(function(){
      renderHint('输入关键词开始搜索，例如：动态密钥 / AppRole / sealed / check-and-set');
    }).catch(function(err){
      renderHint('无法加载搜索索引（' + err.message + '）。如果你是通过 file:// 直接打开页面，浏览器会拦截本地 fetch —— 请用任意静态服务器预览，例如：npx serve 或 python -m http.server。');
    });
  }
  function closeSearch(){ if(modal){ modal.hidden = true; } }
  function renderHint(text){ results.innerHTML = '<p class="search-hint"></p>'; qs('.search-hint', results).textContent = text; }

  if(openBtn) openBtn.addEventListener('click', openSearch);
  if(closeBtn) closeBtn.addEventListener('click', closeSearch);
  if(modal) modal.addEventListener('click', function(e){ if(e.target === modal) closeSearch(); });

  document.addEventListener('keydown', function(e){
    var typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName);
    if(e.key === '/' && !typing){ e.preventDefault(); openSearch(); return; }
    if(e.key === 'Escape' && modal && !modal.hidden){ closeSearch(); return; }
    if((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k'){ e.preventDefault(); openSearch(); return; }
    if(!modal || modal.hidden) return;
    if(e.key === 'ArrowDown' || e.key === 'ArrowUp'){
      if(!currentItems.length) return;
      e.preventDefault();
      selected = e.key === 'ArrowDown'
        ? Math.min(selected + 1, currentItems.length - 1)
        : Math.max(selected - 1, 0);
      currentItems.forEach(function(el, i){ el.classList.toggle('sel', i === selected); });
      currentItems[selected].scrollIntoView({ block: 'nearest' });
    } else if(e.key === 'Enter' && currentItems[selected]) {
      e.preventDefault(); window.location.href = currentItems[selected].getAttribute('href');
    }
  });

  function tokenize(q){
    return q.toLowerCase().split(/\s+/).map(function(t){ return t.trim(); }).filter(function(t){ return t.length > 0; });
  }
  function highlight(text, terms){
    var out = text;
    terms.forEach(function(t){
      if(t.length < 2) return;
      try {
        out = out.replace(new RegExp('(' + t.replace(/[.*+?^$()|[\]\\]/g, '\\$&') + ')', 'gi'), '<mark>$1</mark>');
      } catch(e){}
    });
    return out;
  }

  var timer = null;
  if(input) input.addEventListener('input', function(){
    clearTimeout(timer);
    var q = input.value;
    timer = setTimeout(function(){ runSearch(q); }, 90);
  });

  function runSearch(q){
    var terms = tokenize(q);
    if(!terms.length){ renderHint('输入关键词开始搜索'); currentItems = []; selected = -1; return; }
    loadIndex().then(function(docs){
      var hits = [];
      docs.forEach(function(doc){
        var titleL = doc.title.toLowerCase();
        var headL = (doc.headings || []).join(' ').toLowerCase();
        doc.chunks.forEach(function(chunk, ci){
          var low = chunk.toLowerCase();
          var score = 0, matched = true;
          terms.forEach(function(t){
            var inChunk = low.indexOf(t) > -1;
            if(inChunk) score += 3;
            if(titleL.indexOf(t) > -1) score += 6;
            if(headL.indexOf(t) > -1) score += 2;
            if(!inChunk && titleL.indexOf(t) < 0 && headL.indexOf(t) < 0) matched = false;
          });
          if(matched) hits.push({ doc: doc, chunk: chunk, score: score, ci: ci });
        });
      });
      hits.sort(function(a, b){ return b.score - a.score; });
      hits = hits.slice(0, 40);
      if(!hits.length){ renderHint('没有匹配结果，试试更短的关键词。'); currentItems = []; selected = -1; return; }
      results.innerHTML = hits.map(function(h){
        return '<a class="search-item" href="' + h.doc.file + '">' +
          '<div class="si-title">' + escHtml(h.doc.title) + '</div>' +
          '<div class="si-text">' + highlight(escHtml(h.chunk), terms) + '</div></a>';
      }).join('');
      currentItems = qsa('.search-item', results);
      selected = -1;
    }).catch(function(){ /* 打开时已经提示过 */ });
  }
  function escHtml(s){
    return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  /* ---------- 局部锚点滚动偏移（顶部栏遮挡） ---------- */
  function scrollToHash(){
    if(!location.hash) return;
    var id = decodeURIComponent(location.hash.slice(1));
    var el = document.getElementById(id);
    if(!el) return;
    var y = el.getBoundingClientRect().top + window.pageYOffset - 72;
    window.scrollTo({ top: y, behavior: 'auto' });
  }
  window.addEventListener('hashchange', scrollToHash);
  if(location.hash) setTimeout(scrollToHash, 60);
})();

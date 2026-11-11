// Floating, auto-hiding scrollbars: native bars are hidden (see style.css) and a thin
// overlay thumb is drawn on top of the content. It appears while scrolling or when
// the pointer nears the edge, and fades out after a moment.
(function () {
  const HIDE_MS = 900;
  const EDGE = 26; // px from the edge that wakes the bar

  function attach(el) {
    el.classList.add('fscroll');
    const mk = (axis) => {
      const t = document.createElement('div');
      t.className = 'fthumb ' + axis;
      t.style.display = 'none';
      document.body.append(t);
      return t;
    };
    const bars = { y: mk('y'), x: mk('x') };
    let hideT, dragging = false, hovering = false;

    const set = (on) => Object.values(bars).forEach((b) => b.classList.toggle('show', on));
    const wake = () => { update(); set(true); clearTimeout(hideT); hideT = setTimeout(() => { if (!dragging && !hovering) set(false); }, HIDE_MS); };

    function update() {
      const r = el.getBoundingClientRect();
      const { clientHeight: ch, scrollHeight: sh, clientWidth: cw, scrollWidth: sw } = el;
      const y = bars.y, x = bars.x;
      if (sh > ch + 1) {
        const len = Math.max(32, (ch * ch) / sh);
        y.style.display = 'block';
        y.style.height = len + 'px';
        y.style.top = r.top + (el.scrollTop / (sh - ch)) * (ch - len) + 'px';
        y.style.left = r.left + cw - 9 + 'px';
      } else y.style.display = 'none';
      if (sw > cw + 1) {
        const len = Math.max(32, (cw * cw) / sw);
        x.style.display = 'block';
        x.style.width = len + 'px';
        x.style.left = r.left + (el.scrollLeft / (sw - cw)) * (cw - len) + 'px';
        x.style.top = r.top + ch - 9 + 'px';
      } else x.style.display = 'none';
    }

    function drag(bar, axis) {
      bar.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        bar.setPointerCapture(e.pointerId);
        dragging = true;
        bar.classList.add('drag');
        let last = axis === 'y' ? e.clientY : e.clientX;
        const move = (m) => {
          const cur = axis === 'y' ? m.clientY : m.clientX;
          const d = cur - last;
          last = cur;
          if (axis === 'y') {
            const len = bar.offsetHeight;
            el.scrollTop += (d * (el.scrollHeight - el.clientHeight)) / Math.max(1, el.clientHeight - len);
          } else {
            const len = bar.offsetWidth;
            el.scrollLeft += (d * (el.scrollWidth - el.clientWidth)) / Math.max(1, el.clientWidth - len);
          }
        };
        const up = () => {
          dragging = false;
          bar.classList.remove('drag');
          bar.removeEventListener('pointermove', move);
          bar.removeEventListener('pointerup', up);
          wake();
        };
        bar.addEventListener('pointermove', move);
        bar.addEventListener('pointerup', up);
      });
      bar.addEventListener('pointerenter', () => { hovering = true; wake(); });
      bar.addEventListener('pointerleave', () => { hovering = false; wake(); });
    }
    drag(bars.y, 'y');
    drag(bars.x, 'x');

    el.addEventListener('scroll', wake, { passive: true });
    el.addEventListener('pointermove', (e) => {
      const r = el.getBoundingClientRect();
      if (e.clientX > r.right - EDGE || e.clientY > r.bottom - EDGE) wake();
    });
    window.addEventListener('resize', update);
    new ResizeObserver(update).observe(el);
    new MutationObserver(update).observe(el, { childList: true, subtree: true });
    update();
  }

  document.querySelectorAll('.wrap, .pbody, .outsel, .board').forEach(attach);
})();

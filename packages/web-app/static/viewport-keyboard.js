// iOS Safari keyboard fixes. Android Chrome is handled by
// interactive-widget=resizes-content in the viewport meta, which Safari
// doesn't support (and iOS auto-zooms sub-16px inputs on focus on top).
;(function () {
  var isIOS =
    /iPhone|iPad|iPod/.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
  if (!isIOS || !window.visualViewport) return

  // maximum-scale only suppresses the automatic focus zoom on iOS >= 10,
  // pinch zoom still works; set here (not in the meta tag) because on
  // Android it would disable pinch zoom entirely.
  var meta = document.querySelector('meta[name="viewport"]')
  if (meta) meta.content += ', maximum-scale=1'

  // The keyboard overlays the page instead of resizing it; pin the layout
  // to the visible area while it's up so the height:100% chain shrinks.
  var vv = window.visualViewport
  function fit() {
    document.documentElement.style.height =
      vv.height < window.innerHeight - 1 ? vv.height + 'px' : ''
    window.scrollTo(0, 0)
  }
  vv.addEventListener('resize', fit)
  vv.addEventListener('scroll', fit)
})()

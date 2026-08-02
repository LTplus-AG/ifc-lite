/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Initialize Mermaid diagrams for MkDocs Material with instant loading support
(function() {
  // Wait for mermaid to load
  if (typeof mermaid === 'undefined') {
    return;
  }

  // Detect color scheme
  function getTheme() {
    const scheme = document.body.getAttribute('data-md-color-scheme');
    return scheme === 'slate' ? 'dark' : 'default';
  }

  // Initialize mermaid configuration
  mermaid.initialize({
    startOnLoad: false,
    theme: getTheme(),
    flowchart: {
      useMaxWidth: true,
      htmlLabels: true
    },
    securityLevel: 'loose'
  });

  // Render mermaid diagrams. Stash each diagram's source text before running,
  // because mermaid replaces the node's content with SVG — the stash lets us
  // re-render on a palette toggle.
  function renderMermaid() {
    const elements = document.querySelectorAll('.mermaid:not([data-processed])');
    if (elements.length > 0) {
      elements.forEach(function(el) {
        if (!el.getAttribute('data-mermaid-source')) {
          el.setAttribute('data-mermaid-source', el.textContent.trim());
        }
      });
      mermaid.run({ nodes: elements });
    }
  }

  // Re-render when the palette is toggled: diagrams carry PLANKOPF red on
  // carbon, so a stale theme is visible. Reset the processed flag + saved
  // source, re-initialize with the new theme, and run again.
  var lastScheme = getTheme();
  var schemeObserver = new MutationObserver(function() {
    var next = getTheme();
    if (next === lastScheme) return;
    lastScheme = next;
    mermaid.initialize({
      startOnLoad: false,
      theme: next,
      flowchart: { useMaxWidth: true, htmlLabels: true },
      securityLevel: 'loose'
    });
    document.querySelectorAll('.mermaid[data-processed]').forEach(function(el) {
      var src = el.getAttribute('data-mermaid-source');
      if (src) {
        // Restore as TEXT, not markup — the source must never be reparsed as
        // DOM (it would let diagram content execute before mermaid rerenders).
        el.textContent = src;
      }
      el.removeAttribute('data-processed');
    });
    renderMermaid();
  });
  schemeObserver.observe(document.body, { attributes: true, attributeFilter: ['data-md-color-scheme'] });

  // Initial render
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', renderMermaid);
  } else {
    renderMermaid();
  }

  // Re-render on instant navigation (MkDocs Material)
  if (typeof document$ !== 'undefined') {
    document$.subscribe(function() {
      renderMermaid();
    });
  }

  // Fallback: MutationObserver for dynamic content
  var observer = new MutationObserver(function(mutations) {
    var shouldRender = mutations.some(function(mutation) {
      return Array.from(mutation.addedNodes).some(function(node) {
        return node.nodeType === 1 && (
          node.classList && node.classList.contains('mermaid') ||
          node.querySelector && node.querySelector('.mermaid')
        );
      });
    });
    if (shouldRender) {
      renderMermaid();
    }
  });

  observer.observe(document.body, { childList: true, subtree: true });
})();

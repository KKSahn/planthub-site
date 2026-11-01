/*
  theme.js — PlantHub's colours and fonts, shared by every page.

  Each page loads Tailwind from its CDN and then this file, which hands
  Tailwind the palette below. One file, so every page matches.

  It also decides light or dark, before the page is drawn (see the end of
  this file).
*/

/*
  PlantHub's colours, with one rule behind them:

    GREEN MEANS FRESH. Nothing else.

  Green ("signal") is spent only where the page is telling you how recently
  a nursery confirmed a listing. Everything else is built from ink (a
  near-black green), cream, sand and clay. If green were also the buttons,
  the links and the tags, it would stop meaning anything, and freshness is
  the one thing this site has that the competition doesn't.
*/
tailwind.config = {
  // Dark mode follows the class "dark" on <html>, which the end of this
  // file sets, rather than only the device's own setting.
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        // Near-black greens: surfaces and text.
        ink: {
          50:  '#eef2f0',
          100: '#d6e0db',
          200: '#bccdc4',
          // Outlines that must be seen on the off-white page: search boxes,
          // the round door on the front page.
          300: '#94a89d',
          400: '#4a6b5a',
          600: '#24402f',
          700: '#1b3328',
          800: '#122117',
          900: '#0b1710',
          950: '#060f0a',
        },
        // Reserved for freshness. Do not use for decoration.
        signal: {
          50:  '#eafaf0',
          400: '#4ade80',
          500: '#22c55e',
          600: '#16a34a',
          700: '#15803d',
        },
        // The warm accent: links, focus rings, highlights.
        clay: {
          50:  '#fbf1e9',
          100: '#f4ddcb',
          300: '#e0a877',
          500: '#c2703c',
          600: '#a95c2d',
          700: '#8a4a22',
        },
        cream: '#f8f8f5',
        sand:  '#f2e9dc',
      },
      fontFamily: {
        display: ['Fraunces', 'ui-serif', 'Georgia', 'serif'],
        sans:    ['Inter', 'ui-sans-serif', 'system-ui', 'sans-serif'],
      },
    },
  },
};

/*
  Light or dark.

  The site starts in whichever the device is set to. The round sun-or-moon
  button in the top corner of every page (drawn by store.js) switches it,
  and that choice is remembered on this device until it is switched again.

  This is the one thing kept in the browser's storage outside store.js. It
  has to be read before the page is drawn, or the page would flash light
  before turning dark, and store.js only loads at the end of the page.
*/
(function () {
  const KEY = "planthub.theme";
  const deviceDark = window.matchMedia("(prefers-color-scheme: dark)");
  let remembered = null;   // used when the browser won't keep anything

  function chosen() {
    try { return localStorage.getItem(KEY) || remembered; } catch (error) { return remembered; }
  }

  function apply() {
    const choice = chosen();
    const dark = choice ? choice === "dark" : deviceDark.matches;
    document.documentElement.classList.toggle("dark", dark);
    // Form controls and scroll bars follow too.
    document.documentElement.style.colorScheme = dark ? "dark" : "light";
    // A phone's browser bar takes the page's own colour, so it doesn't sit
    // white above the page.
    let bar = document.querySelector('meta[name="theme-color"]');
    if (!bar) {
      bar = document.createElement("meta");
      bar.name = "theme-color";
      document.head.appendChild(bar);
    }
    bar.content = dark ? "#060f0a" : "#f8f8f5";
    document.dispatchEvent(new Event("planthub:theme-changed"));
  }

  window.PlantHubTheme = {
    isDark: function () { return document.documentElement.classList.contains("dark"); },
    toggle: function () {
      remembered = this.isDark() ? "light" : "dark";
      try { localStorage.setItem(KEY, remembered); } catch (error) { /* kept for this page only */ }
      apply();
    },
  };

  apply();
  // With nothing chosen yet, follow the device if its setting changes.
  deviceDark.addEventListener("change", apply);
})();

// Splice website client script. No dependencies, no tracking, no cookies.
// Reads only the public, read-only registry API (CORS) named in <meta name="splice:registry">
// and the site's own search index.
(() => {
  "use strict";
  const root = document.documentElement;
  root.classList.add("js");
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const ready = (fn) => (document.readyState === "loading" ? document.addEventListener("DOMContentLoaded", fn) : fn());
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  ready(() => {
    const body = document.body;

    // --- Header: border once scrolled; mobile menu.
    const header = document.querySelector(".site-header");
    const onScroll = () => header && header.classList.toggle("is-scrolled", window.scrollY > 8);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    const menuToggle = document.querySelector("[data-menu-toggle]");
    const setMenu = (open) => {
      body.classList.toggle("menu-open", open);
      if (menuToggle) {
        menuToggle.setAttribute("aria-expanded", String(open));
        menuToggle.setAttribute("aria-label", open ? "Close menu" : "Open menu");
      }
    };
    menuToggle?.addEventListener("click", () => setMenu(!body.classList.contains("menu-open")));
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && body.classList.contains("menu-open")) setMenu(false);
    });
    window.matchMedia("(min-width: 981px)").addEventListener("change", (event) => event.matches && setMenu(false));
    document.querySelectorAll("#main-nav a").forEach((a) => a.addEventListener("click", () => setMenu(false)));

    // --- Sections without "#" in the URL: links carry data-section; the target is scrolled to and the
    // address bar keeps the clean page URL. data-local: scroll here when this page has that section.
    const SECTION_KEY = "splice:section";
    const cleanPath = (path) => path.replace(/\.html$/, "").replace(/\/index$/, "/");
    const scrollToSection = (id, focus) => {
      const target = document.getElementById(id);
      if (!target) return false;
      target.scrollIntoView({ behavior: reduceMotion || focus ? "auto" : "smooth", block: "start" });
      if (focus) {
        if (!target.hasAttribute("tabindex")) target.setAttribute("tabindex", "-1");
        target.focus({ preventScroll: true });
      }
      return true;
    };
    document.addEventListener("click", (event) => {
      const link = event.target instanceof Element ? event.target.closest("a[data-section]") : null;
      if (!link || event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const id = link.getAttribute("data-section");
      const url = new URL(link.href, window.location.href);
      const here = url.origin === window.location.origin && cleanPath(url.pathname) === cleanPath(window.location.pathname);
      if ((here || link.hasAttribute("data-local")) && document.getElementById(id)) {
        event.preventDefault();
        scrollToSection(id, id === "main");
      } else if (!link.hasAttribute("data-local")) {
        try {
          sessionStorage.setItem(SECTION_KEY, id);
        } catch {}
      }
    });
    let arriving = null;
    try {
      arriving = sessionStorage.getItem(SECTION_KEY);
      sessionStorage.removeItem(SECTION_KEY);
    } catch {}
    if (window.location.hash) {
      // Old or external links with a #fragment: go to the section, then drop the fragment.
      arriving = decodeURIComponent(window.location.hash.slice(1));
      history.replaceState(null, "", window.location.pathname + window.location.search);
    }
    if (arriving) requestAnimationFrame(() => scrollToSection(arriving, false));

    // --- Hero video: loaded after the page, never under reduced motion or Save-Data (the poster stays);
    // the smaller file on narrow screens; paused while off screen or in a background tab.
    const video = document.querySelector("[data-hero-video]");
    const saveData = Boolean(navigator.connection && navigator.connection.saveData);
    if (video instanceof HTMLVideoElement && !reduceMotion && !saveData) {
      let visible = true;
      const play = () => {
        if (visible && !document.hidden) video.play().catch(() => {});
      };
      const start = () => {
        const small = window.matchMedia("(max-width: 820px)").matches;
        video.muted = true;
        video.src = video.getAttribute(small ? "data-video-sm" : "data-video-lg") ?? "";
        video.addEventListener("playing", () => video.classList.add("is-playing"), { once: true });
        play();
      };
      if (document.readyState === "complete") start();
      else window.addEventListener("load", start, { once: true });
      if ("IntersectionObserver" in window) {
        new IntersectionObserver((entries) => {
          visible = entries.some((entry) => entry.isIntersecting);
          if (visible) play();
          else video.pause();
        }).observe(video);
      }
      document.addEventListener("visibilitychange", () => (document.hidden ? video.pause() : play()));
    }

    // --- Copy buttons on code blocks.
    for (const pre of document.querySelectorAll("pre.code")) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "copy-button";
      button.textContent = "Copy";
      button.setAttribute("aria-label", "Copy code");
      button.addEventListener("click", async () => {
        const text = (pre.querySelector("code")?.textContent ?? "").replace(/^\$ /gm, "");
        try {
          await navigator.clipboard.writeText(text);
          button.textContent = "Copied";
        } catch {
          button.textContent = "Select and copy";
        }
        setTimeout(() => (button.textContent = "Copy"), 1600);
      });
      pre.appendChild(button);
    }

    // --- Reveal on scroll.
    const reveals = document.querySelectorAll(".reveal");
    if ("IntersectionObserver" in window && !reduceMotion && !window.matchMedia("(max-width: 820px)").matches) {
      const observer = new IntersectionObserver(
        (entries) => {
          for (const entry of entries) {
            if (entry.isIntersecting) {
              entry.target.classList.add("visible");
              observer.unobserve(entry.target);
            }
          }
        },
        { rootMargin: "0px 0px -8% 0px" },
      );
      reveals.forEach((el) => observer.observe(el));
    } else {
      reveals.forEach((el) => el.classList.add("visible"));
    }

    // --- Terminal: scenes of real CLI output, typed one after another (tabs jump to a scene).
    const terminal = document.querySelector("[data-terminal]");
    if (terminal) {
      const scenes = [...terminal.querySelectorAll(".t-scene")];
      const tabs = [...terminal.querySelectorAll("[data-scene-tab]")];
      const caret = document.createElement("span");
      caret.className = "caret";
      caret.setAttribute("aria-hidden", "true");
      const original = new Map();
      for (const cmd of terminal.querySelectorAll(".t-cmd")) original.set(cmd, cmd.textContent ?? "");
      let current = 0;
      let run = 0;
      let inView = false;
      let playing = false;
      const show = (index) => {
        current = (index + scenes.length) % scenes.length;
        scenes.forEach((s, i) => s.classList.toggle("is-active", i === current));
        tabs.forEach((t, i) => {
          t.classList.toggle("is-active", i === current);
          t.setAttribute("aria-selected", String(i === current));
        });
      };
      const outputDelay = (line) => {
        const text = line.textContent ?? "";
        if (line.getAttribute("data-kind") === "live") return 700; // a live provider request
        if (/^(Downloading|Verifying|Resolving)/.test(text)) return 520;
        if (/^(Installed|@splice\/\S+\s+VERIFIED)/.test(text)) return 380;
        return 70;
      };
      // Fixed-height body (phones): keep the newest line in view by scrolling the terminal itself,
      // never the page.
      const screen = terminal.querySelector(".terminal-body");
      const follow = () => {
        if (screen && screen.scrollHeight > screen.clientHeight) screen.scrollTop = screen.scrollHeight;
      };
      const playScene = async (id) => {
        const lines = [...scenes[current].querySelectorAll(".t-line")];
        terminal.setAttribute("data-ready", "");
        lines.forEach((line) => line.classList.add("is-hidden"));
        if (screen) {
          screen.scrollTop = 0;
          screen.scrollLeft = 0;
        }
        await sleep(300);
        for (let i = 0; i < lines.length; i++) {
          if (id !== run) return false;
          const line = lines[i];
          const cmd = line.querySelector(".t-cmd");
          line.classList.remove("is-hidden");
          follow();
          if (cmd) {
            const text = original.get(cmd) ?? "";
            cmd.textContent = "";
            cmd.after(caret);
            await sleep(i === 0 ? 250 : 600);
            for (let c = 0; c < text.length; c++) {
              if (id !== run) return false;
              cmd.textContent = text.slice(0, c + 1);
              // Deterministic rhythm: slightly slower after spaces and punctuation.
              await sleep(/[\s/@.-]/.test(text[c]) ? 60 : 24 + (c % 4) * 6);
            }
            await sleep(380);
            caret.remove();
          } else {
            await sleep(outputDelay(line));
          }
        }
        lines[lines.length - 1]?.appendChild(caret);
        return true;
      };
      const play = async () => {
        const id = ++run;
        playing = true;
        for (;;) {
          const done = await playScene(id);
          if (!done || id !== run) return;
          await sleep(5200);
          if (id !== run) return;
          if (!inView) {
            playing = false;
            caret.remove();
            return;
          }
          show(current + 1);
        }
      };
      const restoreAll = () => {
        for (const [cmd, text] of original) cmd.textContent = text;
        terminal.querySelectorAll(".t-line.is-hidden").forEach((l) => l.classList.remove("is-hidden"));
      };
      tabs.forEach((tab, i) =>
        tab.addEventListener("click", () => {
          show(i);
          if (reduceMotion) return;
          restoreAll();
          void play();
        }),
      );
      terminal.querySelector("[data-terminal-replay]")?.addEventListener("click", () => {
        if (reduceMotion) return;
        restoreAll();
        void play();
      });
      if (!reduceMotion && "IntersectionObserver" in window) {
        const io = new IntersectionObserver(
          (entries) => {
            inView = entries.some((entry) => entry.isIntersecting);
            if (inView && !playing) void play();
          },
          { threshold: 0.35 },
        );
        io.observe(terminal);
      }
    }
    // --- Docs: mobile sidebar drawer.
    const sidebarToggle = document.querySelector("[data-sidebar-toggle]");
    const setSidebar = (open) => {
      body.classList.toggle("sidebar-open", open);
      sidebarToggle?.setAttribute("aria-expanded", String(open));
    };
    sidebarToggle?.addEventListener("click", (event) => {
      event.stopPropagation();
      setSidebar(!body.classList.contains("sidebar-open"));
    });
    document.addEventListener("click", (event) => {
      if (!body.classList.contains("sidebar-open")) return;
      const sidebar = document.getElementById("doc-sidebar");
      if (sidebar && event.target instanceof Node && !sidebar.contains(event.target)) setSidebar(false);
    });

    // --- Docs: highlight the current section in "On this page".
    const tocLinks = [...document.querySelectorAll(".doc-toc a")];
    if (tocLinks.length && "IntersectionObserver" in window) {
      const byId = new Map(tocLinks.map((a) => [decodeURIComponent(a.getAttribute("href").slice(1)), a]));
      const io = new IntersectionObserver(
        (entries) => {
          for (const entry of entries) {
            if (!entry.isIntersecting) continue;
            tocLinks.forEach((a) => a.classList.remove("active"));
            byId.get(entry.target.id)?.classList.add("active");
          }
        },
        { rootMargin: "0px 0px -70% 0px" },
      );
      for (const id of byId.keys()) {
        const target = document.getElementById(id);
        if (target) io.observe(target);
      }
    }

    // --- Docs: search (index built with the site: titles, sections, text).
    const dialog = document.querySelector("[data-search-dialog]");
    const indexPath = body.getAttribute("data-search-index");
    if (dialog && indexPath) {
      const input = dialog.querySelector("[data-search-input]");
      const list = dialog.querySelector("[data-search-results]");
      const indexUrl = new URL(indexPath, window.location.href);
      const siteRoot = new URL("../", indexUrl);
      let index = null;
      let selected = 0;
      let lastFocus = null;
      const load = async () => {
        if (index) return index;
        const res = await fetch(indexUrl, { credentials: "omit" });
        index = res.ok ? await res.json() : [];
        return index;
      };
      const escapeHtml = (s) => s.replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[ch]);
      const render = (items, query) => {
        selected = 0;
        if (!query) {
          list.innerHTML = "";
          return;
        }
        if (items.length === 0) {
          list.innerHTML = `<li class="r-empty">No results for “${escapeHtml(query)}”.</li>`;
          return;
        }
        list.innerHTML = items
          .map((r, i) => `<li><a href="${escapeHtml(r.href)}"${r.section ? ` data-section="${escapeHtml(r.section)}"` : ""} role="option" aria-selected="${i === 0}"><span class="r-title">${escapeHtml(r.title)}</span><span class="r-meta">${escapeHtml(r.meta)}</span></a></li>`)
          .join("");
      };
      const search = (query) => {
        const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
        if (!tokens.length || !index) return [];
        const results = [];
        for (const page of index) {
          const title = page.t.toLowerCase();
          const text = page.x.toLowerCase();
          const headings = page.h.map((h) => {
            const at = h.lastIndexOf("#");
            return { text: h.slice(0, at), id: h.slice(at + 1) };
          });
          let score = 0;
          let heading = null;
          let all = true;
          for (const token of tokens) {
            const inTitle = title.includes(token);
            const hit = headings.find((h) => h.text.toLowerCase().includes(token));
            const inText = text.includes(token);
            if (!inTitle && !hit && !inText) {
              all = false;
              break;
            }
            score += inTitle ? 10 : 0;
            if (hit) {
              score += 4;
              heading ??= hit;
            }
            score += inText ? 1 : 0;
          }
          if (!all) continue;
          const url = new URL(page.u, siteRoot);
          const section = heading && !title.includes(tokens[0]) ? heading.id : null;
          results.push({ score, title: page.t, meta: `${page.g}${heading ? ` › ${heading.text}` : ""}`, href: url.href, section });
        }
        return results.sort((a, b) => b.score - a.score).slice(0, 12);
      };
      const open = async () => {
        lastFocus = document.activeElement;
        dialog.hidden = false;
        input.value = "";
        list.innerHTML = "";
        input.focus();
        await load().catch(() => (index = []));
      };
      const close = () => {
        dialog.hidden = true;
        if (lastFocus instanceof HTMLElement) lastFocus.focus();
      };
      const move = (delta) => {
        const options = [...list.querySelectorAll("a")];
        if (!options.length) return;
        selected = (selected + delta + options.length) % options.length;
        options.forEach((a, i) => a.setAttribute("aria-selected", String(i === selected)));
        options[selected].scrollIntoView({ block: "nearest" });
      };
      document.querySelectorAll("[data-search-open]").forEach((b) => b.addEventListener("click", () => void open()));
      input.addEventListener("input", () => render(search(input.value.trim()), input.value.trim()));
      input.addEventListener("keydown", (event) => {
        if (event.key === "ArrowDown") {
          event.preventDefault();
          move(1);
        } else if (event.key === "ArrowUp") {
          event.preventDefault();
          move(-1);
        } else if (event.key === "Enter") {
          const target = list.querySelectorAll("a")[selected];
          if (target) {
            event.preventDefault();
            close();
            target.click();
          }
        }
      });
      list.addEventListener("click", (event) => {
        if (event.target instanceof Element && event.target.closest("a")) close();
      });
      dialog.addEventListener("click", (event) => {
        if (event.target === dialog) close();
      });
      document.addEventListener("keydown", (event) => {
        const typing = event.target instanceof HTMLElement && (event.target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(event.target.tagName));
        if (event.key === "Escape") {
          if (!dialog.hidden) close();
          setSidebar(false);
          setMenu(false);
        } else if ((event.key === "/" && !typing) || ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k")) {
          event.preventDefault();
          void open();
        }
      });
    } else {
      document.addEventListener("keydown", (event) => {
        if (event.key === "Escape") setMenu(false);
      });
    }

    // --- Live registry data (versions newer than this page's snapshot).
    const registry = document.querySelector('meta[name="splice:registry"]')?.getAttribute("content");
    if (!registry) return;
    const base = registry.replace(/\/$/, "");
    const api = async (path) => {
      const res = await fetch(`${base}${path}`, { headers: { accept: "application/json" }, credentials: "omit" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    };
    const pkgPath = (id) => {
      const [namespace, name] = id.slice(1).split("/");
      return `/packages/${encodeURIComponent(namespace)}/${encodeURIComponent(name)}`;
    };
    const status = document.querySelector("[data-registry-status]");
    const cards = [...document.querySelectorAll("[data-skill]")];
    if (cards.length > 0) {
      Promise.all(
        cards.map(async (card) => {
          const id = card.getAttribute("data-skill");
          const pkg = await api(pkgPath(id));
          if (pkg.latest && pkg.latest !== card.getAttribute("data-version")) {
            const version = await api(`${pkgPath(id)}/${encodeURIComponent(pkg.latest)}`);
            card.setAttribute("data-version", version.version);
            card.setAttribute("data-integrity", version.integrity);
            card.setAttribute("data-size", String(version.size));
            const field = card.querySelector('[data-field="version"]');
            if (field) {
              field.textContent = `v${version.version}`;
              field.classList.add("updated");
              field.title = "Newer than this page's snapshot (live from the registry)";
            }
          }
          const desc = card.querySelector('[data-field="description"]');
          if (desc && pkg.description) desc.textContent = pkg.description;
        }),
      ).then(
        () => {
          if (status) status.textContent = `Live from the registry (${new URL(base).host}).`;
        },
        () => {
          if (status) status.textContent = `${status.textContent} The registry could not be reached just now; showing the build snapshot.`;
        },
      );
    }

    // --- Verify an artifact's SHA-256 in the browser (Web Crypto), against the registry metadata.
    const hex = (buffer) => [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, "0")).join("");
    document.addEventListener("click", async (event) => {
      const button = event.target instanceof Element ? event.target.closest("[data-verify-browser]") : null;
      if (!button) return;
      const card = button.closest("[data-skill]");
      const out = card?.querySelector("[data-verify-result]");
      if (!card || !out) return;
      const id = card.getAttribute("data-skill");
      const version = card.getAttribute("data-version");
      button.disabled = true;
      out.className = "verify-result";
      out.textContent = `Downloading ${id}@${version}…`;
      try {
        const meta = await api(`${pkgPath(id)}/${encodeURIComponent(version)}`);
        const res = await fetch(`${base}${pkgPath(id)}/${encodeURIComponent(version)}/download`, { credentials: "omit" });
        if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`);
        const bytes = await res.arrayBuffer();
        const actual = `sha256-${hex(await crypto.subtle.digest("SHA-256", bytes))}`;
        const sizeOk = bytes.byteLength === meta.size;
        const hashOk = actual === meta.integrity;
        const headerOk = !res.headers.get("x-splice-integrity") || res.headers.get("x-splice-integrity") === meta.integrity;
        if (hashOk && sizeOk && headerOk) {
          out.className = "verify-result ok";
          out.textContent = `✓ ${bytes.byteLength} bytes, ${actual.slice(0, 23)}… matches the registry metadata. (Integrity only: packages are not signed.)`;
        } else {
          out.className = "verify-result fail";
          out.textContent = `✗ Mismatch: got ${actual} (${bytes.byteLength} bytes), registry says ${meta.integrity} (${meta.size} bytes).`;
        }
      } catch (error) {
        out.className = "verify-result fail";
        out.textContent = `Could not verify: ${error instanceof Error ? error.message : String(error)}`;
      } finally {
        button.disabled = false;
      }
    });
  });
})();

// Registry catalogue search, copy buttons and the live registry status in the footer.
(() => {
  "use strict";
  const run = () => {
    // search the skills registry page
    const filter = document.querySelector("[data-registry-filter]");
    if (filter) {
      const items = [...document.querySelectorAll("[data-filter-text]")];
      const empty = document.querySelector("[data-registry-empty]");
      filter.addEventListener("input", () => {
        const q = filter.value.trim().toLowerCase();
        let shown = 0;
        for (const item of items) {
          const match = !q || q.split(/\s+/).every((w) => item.getAttribute("data-filter-text").includes(w));
          item.hidden = !match;
          if (match) shown++;
        }
        if (empty) empty.hidden = shown > 0;
      });
    }
    // copy install commands
    for (const button of document.querySelectorAll("[data-copy]")) {
      button.addEventListener("click", async () => {
        try {
          await navigator.clipboard.writeText(button.getAttribute("data-copy"));
          button.textContent = "Copied";
        } catch {
          button.textContent = "Select and copy";
        }
        setTimeout(() => (button.textContent = "Copy"), 1600);
      });
    }
    // registry status: one GET /health per page view (no cookies, no tracking)
    const health = document.querySelector("[data-registry-health]");
    const registry = document.querySelector('meta[name="splice:registry"]')?.getAttribute("content");
    if (health && registry) {
      const label = health.querySelector("span");
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 6000);
      fetch(`${registry.replace(/\/$/, "")}/health`, { credentials: "omit", cache: "no-store", signal: ctrl.signal })
        .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
        .then((body) => {
          const up = body && body.status === "ok";
          health.classList.add(up ? "is-up" : "is-down");
          label.textContent = up ? "Registry operational" : "Registry degraded";
        })
        .catch(() => {
          health.classList.add("is-down");
          label.textContent = "Registry unreachable";
        })
        .finally(() => clearTimeout(timer));
    }
  };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", run);
  else run();
})();

// Live pages (/token, /live, /ask): data from the public API, every panel labelled with its source.
(() => {
  "use strict";
  const root = document.querySelector("[data-live]");
  if (!root) return;
  const api = (root.getAttribute("data-api") || "").replace(/\/$/, "");
  const kind = root.getAttribute("data-live");
  const SVG = "http://www.w3.org/2000/svg";

  const num = (v) => (v === null || v === undefined || v === "" ? NaN : Number(v));
  const SUB = "₀₁₂₃₄₅₆₇₈₉";
  /** Tiny prices the way trading terminals show them: $0.0₅9846 = $0.000009846. */
  const tiny = (n) => {
    let zeros = Math.ceil(-Math.log10(n)) - 1;
    let scaled = Math.round(n * 10 ** (zeros + 4));
    if (scaled >= 10000) scaled = Math.round(n * 10 ** (--zeros + 4));
    const digits = String(scaled).slice(0, 4);
    return `$0.0${String(zeros).split("").map((d) => SUB[Number(d)]).join("")}${digits}`;
  };
  const usd = (v) => {
    const n = num(v);
    if (!Number.isFinite(n)) return "—";
    if (n > 0 && n < 0.0001) return tiny(n);
    if (Math.abs(n) >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
    if (Math.abs(n) >= 1e6) return `$${(n / 1e6).toFixed(2)}M`;
    if (Math.abs(n) >= 1e3) return `$${(n / 1e3).toFixed(1)}K`;
    if (Math.abs(n) >= 1) return `$${n.toFixed(2)}`;
    if (n === 0) return "$0";
    return `$${n.toPrecision(4)}`;
  };
  const amount = (v) => {
    const n = num(v);
    return Number.isFinite(n) ? n.toLocaleString("en-US", { maximumFractionDigits: 0 }) : "—";
  };
  const pct = (v) => {
    const n = num(v);
    return Number.isFinite(n) ? `${n > 0 ? "+" : ""}${n.toFixed(2)}%` : "—";
  };
  const tone = (el, v) => {
    const n = num(v);
    if (Number.isFinite(n) && n !== 0) el.classList.add(n > 0 ? "up" : "down");
  };
  const ago = (iso) => {
    const t = Date.parse(iso);
    if (!Number.isFinite(t)) return "";
    const s = Math.max(0, Math.round((Date.now() - t) / 1000));
    return s < 90 ? `${s}s ago` : s < 5400 ? `${Math.round(s / 60)}m ago` : `${Math.round(s / 3600)}h ago`;
  };
  const sourceText = (s) => (!s ? "" : s.status === "LIVE" || s.status === "CACHED" ? `${s.status} · ${s.source || "?"} · ${ago(s.fetchedAt)}` : `${s.status}${s.reason ? ` · ${s.reason}` : ""}`);
  const el = (tag, text, cls) => {
    const n = document.createElement(tag);
    if (text !== undefined) n.textContent = text;
    if (cls) n.className = cls;
    return n;
  };
  const getJson = async (path) => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 30000);
    try {
      const r = await fetch(`${api}${path}`, { credentials: "omit", signal: ctrl.signal });
      if (!r.ok) throw new Error(String(r.status));
      return await r.json();
    } finally {
      clearTimeout(timer);
    }
  };

  // ------------------------------------------------------------------ /token
  const short = (a) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : "—");
  const LIVE_MS = 5000;
  /** Groups 5-minute candles [t, o, h, l, c, v] into `tf`-second candles. */
  const aggregate = (base, tf) => {
    const out = [];
    for (const k of base) {
      const time = Math.floor(k.time / tf) * tf;
      const last = out[out.length - 1];
      if (last && last.time === time) {
        last.high = Math.max(last.high, k.high);
        last.low = Math.min(last.low, k.low);
        last.close = k.close;
        last.value += k.value;
      } else out.push({ time, open: k.open, high: k.high, low: k.low, close: k.close, value: k.value });
    }
    return out;
  };
  const UP = "#2ebd85";
  const DOWN = "#f6465d";
  const createTokenChart = (host) => {
    const L = window.LightweightCharts;
    if (!L) return null;
    const chart = L.createChart(host, {
      autoSize: true,
      layout: { background: { type: "solid", color: "transparent" }, textColor: "#8b9096", fontFamily: "Geist Mono, ui-monospace, monospace", fontSize: 11, attributionLogo: true },
      grid: { vertLines: { color: "rgba(255,255,255,0.035)" }, horzLines: { color: "rgba(255,255,255,0.035)" } },
      rightPriceScale: { borderColor: "rgba(255,255,255,0.08)", scaleMargins: { top: 0.08, bottom: 0.24 } },
      timeScale: { borderColor: "rgba(255,255,255,0.08)", timeVisible: true, secondsVisible: false, rightOffset: 6, barSpacing: 7, minBarSpacing: 2 },
      crosshair: {
        mode: L.CrosshairMode ? L.CrosshairMode.Normal : 0,
        vertLine: { color: "rgba(255,255,255,0.25)", width: 1, style: 3, labelBackgroundColor: "#1c1f23" },
        horzLine: { color: "rgba(255,255,255,0.25)", width: 1, style: 3, labelBackgroundColor: "#1c1f23" },
      },
    });
    const candles = chart.addSeries(L.CandlestickSeries, {
      upColor: UP, downColor: DOWN, borderUpColor: UP, borderDownColor: DOWN, wickUpColor: UP, wickDownColor: DOWN,
      priceLineStyle: 2,
      priceFormat: { type: "custom", formatter: (p) => usd(p), minMove: 0.01 },
    });
    const volume = chart.addSeries(L.HistogramSeries, { priceScaleId: "vol", priceFormat: { type: "volume" }, lastValueVisible: false, priceLineVisible: false });
    chart.priceScale("vol").applyOptions({ scaleMargins: { top: 0.82, bottom: 0 }, visible: false });
    if (L.createTextWatermark) {
      try {
        L.createTextWatermark(chart.panes()[0], { horzAlign: "center", vertAlign: "center", lines: [{ text: "SPLICE", color: "rgba(255,255,255,0.035)", fontSize: 96, fontStyle: "600" }] });
      } catch {
        /* watermark is decoration only */
      }
    }
    return { chart, candles, volume };
  };
  const compact = (v) => {
    const n = num(v);
    if (!Number.isFinite(n)) return "—";
    if (Math.abs(n) >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
    if (Math.abs(n) >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
    if (Math.abs(n) >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
    return n.toFixed(n < 10 ? 2 : 0);
  };
  const agoShort = (iso) => {
    const t = Date.parse(iso);
    if (!Number.isFinite(t)) return "now";
    const s = Math.max(0, Math.round((Date.now() - t) / 1000));
    return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m` : s < 86400 ? `${Math.floor(s / 3600)}h` : `${Math.floor(s / 86400)}d`;
  };
  const token = async () => {
    let d;
    try {
      d = await getJson("/v1/token");
    } catch {
      root.querySelector("[data-sources]").replaceChildren(el("li", "Live data is unavailable right now. Try again in a minute.", "muted"));
      root.querySelector("[data-live-dot]").textContent = "unavailable";
      return;
    }
    const m = d.market || {};
    const st = m.stats || {};
    const supply = num(d.totalSupply) || 1e9;
    const codexNote = `codex · ${ago(m.updatedAt)}`;
    const kv = (key, text) => {
      const n = root.querySelector(`[data-kv="${key}"] [data-value]`);
      if (n) n.textContent = text;
    };
    const side = (key, text, note) => {
      const card = root.querySelector(`[data-stat="${key}"]`);
      if (!card) return;
      card.querySelector("[data-value]").textContent = text;
      card.querySelector("[data-note]").textContent = note || "";
    };
    const mcEl = root.querySelector("[data-mc]");
    let lastPrice = d.priceUsd ?? num(st.priceUsd);
    const showPrice = (p) => {
      if (!Number.isFinite(num(p))) return;
      const prev = lastPrice;
      lastPrice = num(p);
      mcEl.textContent = usd(lastPrice * supply);
      kv("price", usd(lastPrice));
      side("fdvUsd", usd(lastPrice * supply), "price × total supply");
      if (Number.isFinite(prev) && prev !== lastPrice) {
        mcEl.classList.remove("tick-up", "tick-down");
        void mcEl.offsetWidth;
        mcEl.classList.add(lastPrice > prev ? "tick-up" : "tick-down");
      }
    };
    showPrice(lastPrice);
    kv("liq", usd(d.pool ? d.pool.liquidityUsd : st.liquidityUsd));
    kv("vol", usd(st.volumeUsd ? st.volumeUsd.h24 : null));
    kv("holders", amount(d.holders ?? st.holders));
    side("liquidityUsd", usd(d.pool ? d.pool.liquidityUsd : st.liquidityUsd), d.pool ? "pool reserves × Chainlink ETH/USD" : codexNote);
    side("txns24", amount(st.txns24), codexNote);
    side("uniqueBuyers24", amount(st.uniqueBuyers24), st.uniqueSellers24 !== null && st.uniqueSellers24 !== undefined ? `${amount(st.uniqueSellers24)} unique sellers` : codexNote);
    side("burned", d.burned && d.burned.pctOfSupply !== null ? `${num(d.burned.pctOfSupply).toFixed(2)}%` : "—", d.burned && d.burned.total !== null ? `${compact(d.burned.total)} SPLICE` : "");
    side("totalSupply", compact(d.totalSupply), sourceText(d.sources.totalSupply));

    // ---- candles: Codex 1-minute (≤ 8 h) and 1-hour history, live pool price for the current candle
    const toK = (k) => ({ time: k[0], open: k[1], high: k[2], low: k[3], close: k[4], value: k[5] });
    const base1m = (m.chart || []).filter((k) => Array.isArray(k) && k.length >= 6).map(toK);
    const base1h = (m.chartHourly || []).filter((k) => Array.isArray(k) && k.length >= 6).map(toK);
    const host = root.querySelector("[data-tv-chart]");
    const empty = root.querySelector("[data-chart-empty]");
    const ohlc = root.querySelector("[data-chart-ohlc]");
    const tv = createTokenChart(host);
    let tf = 60;
    let mode = "mc";
    const TF_LABEL = { 60: "1m", 300: "5m", 900: "15m", 3600: "1H", 14400: "4H", 86400: "1D" };
    const scale = () => (mode === "mc" ? supply : 1);
    const fmt = (v) => (mode === "mc" ? usd(v) : usd(v));
    const series = () => {
      const src = tf >= 3600 ? base1h : base1m;
      const s = scale();
      return aggregate(src, tf).map((k) => ({ ...k, open: k.open * s, high: k.high * s, low: k.low * s, close: k.close * s }));
    };
    const volColor = (k) => (k.close >= k.open ? "rgba(46,189,133,0.45)" : "rgba(246,70,93,0.45)");
    /** GMGN-style legend: symbol, interval, OHLC and change of the hovered (or latest) candle. */
    const legend = (bar, prev) => {
      if (!bar) return;
      const chg = prev ? bar.close - prev.close : bar.close - bar.open;
      const chgPct = prev ? (chg / prev.close) * 100 : ((bar.close - bar.open) / bar.open) * 100;
      const cls = chg >= 0 ? "up" : "down";
      ohlc.replaceChildren(el("strong", `SPLICE · ${TF_LABEL[tf]} · ${mode === "mc" ? "MC" : "Price"}`), el("span", " O "), el("b", fmt(bar.open), cls), el("span", " H "), el("b", fmt(bar.high), cls), el("span", " L "), el("b", fmt(bar.low), cls), el("span", " C "), el("b", fmt(bar.close), cls), el("b", ` ${chg >= 0 ? "+" : ""}${pct(chgPct).replace(/^\+/, "")}`, cls));
    };
    let current = [];
    const legendLatest = () => legend(current[current.length - 1], current[current.length - 2]);
    const render = (fit) => {
      if (!tv) return;
      const agg = series();
      current = agg;
      if (mode === "mc") tv.candles.applyOptions({ priceFormat: { type: "custom", formatter: (p) => usd(p), minMove: 0.01 } });
      else tv.candles.applyOptions({ priceFormat: { type: "custom", formatter: (p) => (p > 0 && p < 0.0001 ? `$${p.toFixed(Math.ceil(-Math.log10(p)) + 3)}` : usd(p)), minMove: 1e-12 } });
      tv.candles.setData(agg.map(({ time, open, high, low, close }) => ({ time, open, high, low, close })));
      tv.volume.setData(agg.map((k) => ({ time: k.time, value: k.value, color: volColor(k) })));
      empty.hidden = agg.length > 0;
      legendLatest();
      if (!agg.length) empty.textContent = "No candles for this interval yet.";
      if (fit) {
        const n = agg.length;
        if (n > 150) tv.chart.timeScale().setVisibleLogicalRange({ from: n - 150, to: n + 6 });
        else tv.chart.timeScale().fitContent();
      }
    };
    if (tv && (base1m.length || base1h.length)) {
      render(true);
      tv.chart.subscribeCrosshairMove((param) => {
        const bar = param && param.seriesData ? param.seriesData.get(tv.candles) : null;
        if (!bar) return legendLatest();
        const i = current.findIndex((k) => k.time === bar.time);
        legend(bar, i > 0 ? current[i - 1] : null);
      });
      const logButton = root.querySelector("[data-log]");
      logButton.addEventListener("click", () => {
        const on = logButton.getAttribute("aria-pressed") !== "true";
        logButton.setAttribute("aria-pressed", String(on));
        tv.chart.priceScale("right").applyOptions({ mode: on ? 1 : 0 });
      });
    } else empty.textContent = !tv ? "Chart library failed to load." : "Not enough trading history yet.";
    for (const button of root.querySelectorAll("[data-tf]")) {
      button.addEventListener("click", () => {
        tf = Number(button.getAttribute("data-tf"));
        for (const b of root.querySelectorAll("[data-tf]")) b.setAttribute("aria-pressed", String(b === button));
        render(true);
      });
    }
    for (const button of root.querySelectorAll("[data-mode]")) {
      button.addEventListener("click", () => {
        mode = button.getAttribute("data-mode");
        for (const b of root.querySelectorAll("[data-mode]")) b.setAttribute("aria-pressed", String(b === button));
        render(false);
      });
    }
    const chartSource = root.querySelector("[data-chart-source]");
    chartSource.textContent = `history: codex candles (1m ${ago(m.updatedAt)}, 1h ${ago(m.hourlyUpdatedAt)})`;
    const bump = (arr, size, time, price, vol) => {
      const bucket = Math.floor(time / size) * size;
      const last = arr[arr.length - 1];
      if (last && bucket < last.time) return;
      if (last && last.time === bucket) {
        last.high = Math.max(last.high, price);
        last.low = Math.min(last.low, price);
        last.close = price;
        last.value += vol;
      } else {
        const open = last ? last.close : price;
        arr.push({ time: bucket, open, high: Math.max(open, price), low: Math.min(open, price), close: price, value: vol });
      }
    };
    const tick = (time, price, vol = 0) => {
      if (!Number.isFinite(price) || !Number.isFinite(time)) return;
      bump(base1m, 60, time, price, vol);
      bump(base1h, 3600, time, price, vol);
      if (!tv) return;
      if (!empty.hidden) return render(true);
      const src = tf >= 3600 ? base1h : base1m;
      const unit = tf >= 3600 ? 3600 : 60;
      const agg = aggregate(src.slice(-Math.ceil(tf / unit) - 1), tf);
      const k = agg[agg.length - 1];
      const s = scale();
      const bar = { time: k.time, open: k.open * s, high: k.high * s, low: k.low * s, close: k.close * s };
      tv.candles.update(bar);
      tv.volume.update({ time: k.time, value: k.value, color: volColor(k) });
      if (current.length && current[current.length - 1].time === bar.time) current[current.length - 1] = { ...bar, value: k.value };
      else current.push({ ...bar, value: k.value });
      legendLatest();
    };

    // ---- trades (Codex history + live on-chain swaps)
    const trades = new Map();
    for (const t of m.trades || []) if (t.txHash) trades.set(t.txHash, { type: t.type, valueUsd: num(t.valueUsd), priceUsd: num(t.priceUsd), splice: num(t.priceUsd) > 0 ? num(t.valueUsd) / num(t.priceUsd) : NaN, wallet: t.maker, txHash: t.txHash, time: t.time, fresh: false });
    const body = root.querySelector("[data-trades]");
    const drawTrades = () => {
      const list = [...trades.values()].sort((a, b) => Date.parse(b.time || 0) - Date.parse(a.time || 0)).slice(0, 25);
      body.replaceChildren(...list.map((t) => {
        const buy = /buy/i.test(t.type);
        const tr = row([{ text: agoShort(t.time), cls: "muted" }, { text: buy ? "Buy" : "Sell", cls: buy ? "up strong" : "down strong" }, { text: usd(t.priceUsd) }, { text: compact(t.splice) }, { text: usd(t.valueUsd), cls: buy ? "up" : "down" }, { text: short(t.wallet), title: t.wallet || "" }]);
        if (t.fresh) {
          tr.classList.add(buy ? "flash-up" : "flash-down");
          t.fresh = false;
        }
        return tr;
      }));
      if (!list.length) body.replaceChildren(row([{ text: "No trades available right now.", cls: "muted" }]));
    };
    drawTrades();
    root.querySelector("[data-trades-source]").textContent = `history: ${codexNote} · new trades: on-chain swap events`;

    // ---- windows: 5m from candles and trades; 1h / 4h / 24h from Codex
    let win = "h24";
    const windowStats = () => {
      const seconds = { m5: 300, h1: 3600, h4: 14400, h24: 86400 }[win];
      const since = Date.now() / 1000 - seconds;
      let change = null, vol = null, buys = null, sells = null;
      if (win === "m5") {
        const ref = [...base1m].reverse().find((k) => k.time <= since);
        if (ref && Number.isFinite(lastPrice)) change = ((lastPrice - ref.close) / ref.close) * 100;
        vol = base1m.filter((k) => k.time >= since).reduce((s, k) => s + (k.value || 0), 0);
      } else {
        change = st.changePct ? st.changePct[win] : null;
        vol = st.volumeUsd ? num(st.volumeUsd[win]) : null;
      }
      if (win === "h24") {
        buys = num(st.buys24);
        sells = num(st.sells24);
      } else {
        // Counted from the trade list only when it reaches back to the start of the window.
        const list = [...trades.values()];
        const oldest = Math.min(...list.map((t) => Date.parse(t.time) / 1000).filter(Number.isFinite));
        if (list.length && oldest <= since) {
          const inWin = list.filter((t) => Date.parse(t.time) / 1000 >= since);
          buys = inWin.filter((t) => /buy/i.test(t.type)).length;
          sells = inWin.length - buys;
        }
      }
      return { change, vol, buys, sells };
    };
    const drawWindows = () => {
      if (Number.isFinite(lastPrice)) {
        const ref = [...base1m].reverse().find((k) => k.time <= Date.now() / 1000 - 300);
        const c5 = ref ? ((lastPrice - ref.close) / ref.close) * 100 : null;
        const el5 = root.querySelector('[data-change="m5"]');
        el5.textContent = pct(c5);
        el5.className = "";
        tone(el5, c5);
      }
      for (const w of ["h1", "h4", "h24"]) {
        const n = root.querySelector(`[data-change="${w}"]`);
        const v = st.changePct ? st.changePct[w] : null;
        n.textContent = pct(v);
        n.className = "";
        tone(n, v);
      }
      const s = windowStats();
      root.querySelector("[data-win-vol]").textContent = usd(s.vol);
      root.querySelector("[data-win-buys]").textContent = Number.isFinite(s.buys) && s.buys !== null ? amount(s.buys) : "—";
      root.querySelector("[data-win-sells]").textContent = Number.isFinite(s.sells) && s.sells !== null ? amount(s.sells) : "—";
      const net = s.buys !== null && s.sells !== null && Number.isFinite(s.buys) ? s.buys - s.sells : null;
      const netEl = root.querySelector("[data-win-net]");
      netEl.textContent = net === null ? "—" : `${net > 0 ? "+" : ""}${amount(net)}`;
      netEl.className = "";
      tone(netEl, net);
      const total = (s.buys || 0) + (s.sells || 0);
      root.querySelector("[data-flow-buy]").setAttribute("width", String(total > 0 ? (s.buys / total) * 1000 : 0));
      root.querySelector("[data-win-source]").textContent = win === "m5" ? "candles + trades · live" : win === "h24" ? codexNote : `change and volume: ${codexNote} · buys/sells: latest trades`;
    };
    for (const b of root.querySelectorAll("[data-win]")) {
      b.addEventListener("click", () => {
        win = b.getAttribute("data-win");
        for (const x of root.querySelectorAll("[data-win]")) x.setAttribute("aria-selected", String(x === b));
        drawWindows();
      });
    }
    drawWindows();

    // ---- tabs
    for (const b of root.querySelectorAll("[data-tab]")) {
      b.addEventListener("click", () => {
        for (const x of root.querySelectorAll("[data-tab]")) x.setAttribute("aria-selected", String(x === b));
        for (const p of root.querySelectorAll("[data-panel]")) p.hidden = p.getAttribute("data-panel") !== b.getAttribute("data-tab");
      });
    }

    // ---- transparency (deployer, launch curve, burned, holders) from the token contract
    const tp = d.transparency || {};
    const devEl = root.querySelector("[data-tp-dev]");
    if (tp.deployer) {
      const bal = num(tp.deployer.balance);
      devEl.textContent = Number.isFinite(bal) ? (bal === 0 ? "0 SPLICE (0%)" : `${compact(bal)} SPLICE (${num(tp.deployer.pctOfSupply).toFixed(2)}%)`) : "unavailable";
      devEl.className = bal === 0 ? "up" : "";
      root.querySelector("[data-tp-dev-addr]").textContent = tp.deployer.address;
    } else devEl.textContent = "unavailable";
    const shares = [["curve", tp.curve ? tp.curve.pctOfSupply : null], ["holders", tp.holdersPct], ["burn", tp.burnedPct]];
    let x = 0;
    for (const [k, v] of shares) {
      const n = num(v);
      root.querySelector(`[data-tp-${k}]`).textContent = Number.isFinite(n) ? `${n.toFixed(2)}%` : "—";
      const rect = root.querySelector(`[data-tp-bar-${k}]`);
      if (Number.isFinite(n)) {
        rect.setAttribute("x", String(x));
        rect.setAttribute("width", String(n * 10));
        x += n * 10;
      }
    }

    // ---- holders
    const holderList = root.querySelector("[data-holders]");
    const top = d.topHolders || [];
    root.querySelector("[data-holders-count]").textContent = d.holders ? amount(d.holders) : "";
    holderList.replaceChildren(...top.map((h, i) => {
      const li = el("li");
      const head = el("div", undefined, "holder-row");
      head.append(el("span", `${i + 1}`, "mono rank"), el("code", short(h.address)), el("span", h.label || "", "holder-label"), el("strong", h.pctOfSupply !== null ? `${num(h.pctOfSupply).toFixed(2)}%` : "—"));
      const bar = document.createElementNS(SVG, "svg");
      bar.setAttribute("viewBox", "0 0 100 4");
      bar.setAttribute("preserveAspectRatio", "none");
      bar.setAttribute("class", "holder-bar");
      const track = document.createElementNS(SVG, "rect");
      track.setAttribute("width", "100");
      track.setAttribute("height", "4");
      track.setAttribute("class", "track");
      const fill = document.createElementNS(SVG, "rect");
      fill.setAttribute("width", String(Math.min(100, Math.max(0.4, num(h.pctOfSupply) || 0))));
      fill.setAttribute("height", "4");
      fill.setAttribute("class", h.label ? "fill fill-label" : "fill");
      bar.append(track, fill);
      li.append(head, bar);
      li.title = h.address;
      return li;
    }));
    if (!top.length) holderList.replaceChildren(el("li", "Holder list unavailable right now.", "muted"));
    root.querySelector("[data-holders-source]").textContent = sourceText(d.sources.holders);

    // ---- burns
    const b = d.burned || {};
    root.querySelector("[data-burn-total]").textContent = b.total !== null ? `${amount(b.total)} SPLICE` : "unavailable";
    root.querySelector("[data-burn-pct]").textContent = b.pctOfSupply !== null ? `${num(b.pctOfSupply).toFixed(2)}%` : "—";
    if (b.pctOfSupply !== null) root.querySelector("[data-burn-fill]").setAttribute("width", String(Math.min(1000, Math.max(0, num(b.pctOfSupply) * 10))));
    root.querySelector("[data-burn-addresses]").replaceChildren(...(b.addresses || []).map((a) => {
      const li = el("li");
      li.append(el("code", a.address), el("span", a.amount !== null ? `${amount(a.amount)} SPLICE` : "unavailable"), el("small", sourceText(a), "mono"));
      return li;
    }));

    const labels = { metadata: "Name, symbol, decimals", totalSupply: "Total supply", holders: "Holders and top holders", burned: "Burned balances", pool: "Pool reserves (live price, liquidity)", ethUsd: "ETH/USD (Chainlink)", stats: "24h activity", chart: "1-minute candles", chartHourly: "1-hour candles", trades: "Trade history" };
    root.querySelector("[data-sources]").replaceChildren(...Object.entries(d.sources).map(([k, s]) => {
      const li = el("li");
      li.append(el("span", labels[k] || k), el("span", sourceText(s), `mono status-${(s.status || "").toLowerCase()}`));
      return li;
    }));

    // ---- live loop: every few seconds, price + new swaps straight from the chain
    const dot = root.querySelector("[data-live-dot]");
    const tradesDot = root.querySelector("[data-trades-live]");
    const seen = new Set();
    const poll = async () => {
      if (document.hidden) return;
      try {
        const live = await getJson("/v1/token/live");
        if (live.status !== "LIVE") throw new Error(live.reason || "unavailable");
        let changed = false;
        for (const s of [...(live.swaps || [])].reverse()) {
          const key = `${s.txHash}:${s.logIndex}`;
          if (seen.has(key)) continue;
          seen.add(key);
          const known = trades.has(s.txHash);
          trades.set(s.txHash, { type: s.type, valueUsd: s.valueUsd, priceUsd: s.priceUsd, splice: s.splice, wallet: s.wallet, txHash: s.txHash, time: s.time, fresh: !known });
          if (!known && s.time) tick(Date.parse(s.time) / 1000, s.priceUsd, num(s.valueUsd) || 0);
          changed = true;
        }
        if (changed) drawTrades();
        tick(Date.parse(live.time) / 1000, live.priceUsd);
        showPrice(live.priceUsd);
        if (Number.isFinite(num(live.liquidityUsd))) {
          kv("liq", usd(live.liquidityUsd));
          side("liquidityUsd", usd(live.liquidityUsd), "pool reserves × Chainlink ETH/USD · live");
        }
        drawWindows();
        dot.textContent = `LIVE · block ${amount(live.block)}`;
        dot.classList.add("on");
        tradesDot.textContent = "LIVE";
        tradesDot.classList.add("on");
      } catch {
        dot.textContent = "reconnecting…";
        dot.classList.remove("on");
      }
    };
    poll();
    setInterval(poll, LIVE_MS);
    setInterval(drawTrades, 15000);
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden) poll();
    });
  };
  // ------------------------------------------------------------------ /live
  const fillTable = (key, rows, source, emptyText = "No data right now.") => {
    const card = root.querySelector(`[data-table="${key}"]`);
    if (!card) return;
    const body = card.querySelector("tbody");
    const cols = card.querySelectorAll("th").length;
    if (!rows.length) {
      const tr = el("tr");
      const td = el("td", source && source.status !== "LIVE" && source.status !== "CACHED" ? `Unavailable${source.reason ? `: ${source.reason}` : ""}` : emptyText, "muted");
      td.colSpan = cols;
      tr.append(td);
      body.replaceChildren(tr);
    } else body.replaceChildren(...rows);
    card.querySelector("[data-source]").textContent = sourceText(source);
  };
  const row = (cells) => {
    const tr = el("tr");
    for (const c of cells) {
      const td = el("td", c.text, c.cls);
      if (c.tone !== undefined) tone(td, c.tone);
      if (c.title) td.title = c.title;
      tr.append(td);
    }
    return tr;
  };
  const chart = (svg, history) => {
    const v = history.map((h) => h[1]);
    if (v.length < 2) return;
    const lo = Math.min(...v), hi = Math.max(...v), span = hi - lo || 1;
    const pts = v.map((y, i) => [(i * 1000) / (v.length - 1), 205 - ((y - lo) / span) * 185]);
    const d = pts.map((p, i) => `${i ? "L" : "M"}${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join(" ");
    const area = document.createElementNS(SVG, "path");
    area.setAttribute("d", `${d} L1000 220 L0 220Z`);
    area.setAttribute("class", "area");
    const line = document.createElementNS(SVG, "path");
    line.setAttribute("d", d);
    line.setAttribute("class", "line");
    line.setAttribute("vector-effect", "non-scaling-stroke");
    const title = document.createElementNS(SVG, "title");
    title.textContent = `${history[0][0]} ${usd(v[0])} → ${history[history.length - 1][0]} ${usd(v[v.length - 1])}`;
    svg.replaceChildren(title, area, line);
  };
  const live = async () => {
    let d;
    try {
      d = await getJson("/v1/chain");
    } catch {
      for (const card of root.querySelectorAll("[data-table] tbody td")) card.textContent = "Live data is unavailable right now.";
      return;
    }
    const tvlCard = root.querySelector('[data-panel="tvl"]');
    if (d.tvl) {
      tvlCard.querySelector("[data-tvl]").textContent = usd(d.tvl.tvlUsd);
      for (const [k, v] of [["1d", d.tvl.change1dPct], ["7d", d.tvl.change7dPct], ["30d", d.tvl.change30dPct]]) {
        const span = tvlCard.querySelector(`[data-change="${k}"]`);
        span.textContent = `${k} ${pct(v)}`;
        tone(span, v);
      }
      chart(tvlCard.querySelector("[data-tvl-chart]"), d.tvl.history || []);
    } else tvlCard.querySelector("[data-tvl]").textContent = "unavailable";
    tvlCard.querySelector("[data-source]").textContent = sourceText(d.sources.tvl);
    const stockRows = (list) => list.map((s) => row([{ text: s.symbol || "?", cls: "strong", title: s.name }, { text: usd(s.priceUsd) }, { text: pct(s.change24hPct), tone: s.change24hPct }, { text: usd(s.volume24hUsd) }]));
    fillTable("gainers", stockRows(d.stocks.gainers), d.sources.stocks, "No stock token is up over the last 24 hours.");
    fillTable("losers", stockRows(d.stocks.losers), d.sources.stocks, "No stock token is down over the last 24 hours.");
    fillTable("perps", d.perps.map((p) => row([{ text: p.symbol, cls: "strong" }, { text: usd(p.markPrice) }, { text: pct(p.change24hPct), tone: p.change24hPct }, { text: usd(p.openInterestUsd) }])), d.sources.perps);
    fillTable("protocols", d.protocols.map((p) => row([{ text: p.name, cls: "strong" }, { text: p.category || "—" }, { text: usd(p.tvlUsd) }, { text: pct(p.change7dPct), tone: p.change7dPct }])), d.sources.protocols);
    fillTable("newPools", d.newPools.map((p) => row([{ text: p.name, cls: "strong" }, { text: p.dex || "—" }, { text: usd(p.liquidityUsd) }, { text: ago(p.createdAt) }])), d.sources.newPools);
  };

  // ------------------------------------------------------------------ /ask
  // Minimal, safe Markdown for answers: text is escaped first; only headings, lists, tables, bold and code.
  const esc = (s) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const inline = (s) => esc(s.replace(/\[([^\]]+)\]\((?:[^)]+)\)/g, "$1")).replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>").replace(/`([^`]+)`/g, "<code>$1</code>");
  const markdown = (text) => {
    const out = [];
    const lines = text.replace(/\r/g, "").split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (/^\s*\|/.test(line)) {
        const rows = [];
        while (i < lines.length && /^\s*\|/.test(lines[i])) rows.push(lines[i++]);
        i--;
        const cells = (r) => r.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
        const body = rows.filter((r) => !/^\s*\|[\s:|-]+\|\s*$/.test(r));
        const [first, ...rest] = body;
        if (first) out.push(`<table><thead><tr>${cells(first).map((c) => `<th>${inline(c)}</th>`).join("")}</tr></thead><tbody>${rest.map((r) => `<tr>${cells(r).map((c) => `<td>${inline(c)}</td>`).join("")}</tr>`).join("")}</tbody></table>`);
      } else if (/^\s*[-*] /.test(line)) {
        const items = [];
        while (i < lines.length && /^\s*[-*] /.test(lines[i])) items.push(lines[i++].replace(/^\s*[-*] /, ""));
        i--;
        out.push(`<ul>${items.map((x) => `<li>${inline(x)}</li>`).join("")}</ul>`);
      } else if (/^\s*\d+\. /.test(line)) {
        const items = [];
        while (i < lines.length && /^\s*\d+\. /.test(lines[i])) items.push(lines[i++].replace(/^\s*\d+\. /, ""));
        i--;
        out.push(`<ol>${items.map((x) => `<li>${inline(x)}</li>`).join("")}</ol>`);
      } else if (/^#{1,6} /.test(line)) out.push(`<h3>${inline(line.replace(/^#+ /, ""))}</h3>`);
      else if (line.trim()) out.push(`<p>${inline(line)}</p>`);
    }
    return out.join("");
  };
  const ask = () => {
    const form = root.querySelector("[data-ask-form]");
    const input = form.querySelector("textarea");
    const button = form.querySelector("button");
    const count = root.querySelector("[data-ask-count]");
    const result = root.querySelector("[data-ask-result]");
    const calls = root.querySelector("[data-ask-calls]");
    const answer = root.querySelector("[data-ask-answer]");
    const meta = root.querySelector("[data-ask-meta]");
    input.addEventListener("input", () => (count.textContent = `${input.value.length} / 300`));
    for (const chip of root.querySelectorAll("[data-ask-example]")) {
      chip.addEventListener("click", () => {
        input.value = chip.getAttribute("data-ask-example");
        count.textContent = `${input.value.length} / 300`;
        form.requestSubmit();
      });
    }
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const question = input.value.trim();
      if (!question || button.disabled) return;
      button.disabled = true;
      button.textContent = "Working…";
      result.hidden = false;
      calls.replaceChildren(el("li", "Calling Splice tools on live data…", "muted"));
      answer.replaceChildren();
      meta.textContent = "";
      try {
        const r = await fetch(`${api}/v1/ask`, { method: "POST", credentials: "omit", headers: { "content-type": "application/json" }, body: JSON.stringify({ question, pass: (window.spliceHolder && window.spliceHolder.pass()) || undefined }) });
        const body = await r.json().catch(() => ({}));
        if (!r.ok) {
          calls.replaceChildren();
          answer.replaceChildren(el("p", body.message || "Ask is unavailable right now. Try again shortly.", "muted"));
          return;
        }
        calls.replaceChildren(...body.calls.map((c) => {
          const ok = c.status === "LIVE" || c.status === "CACHED";
          const li = el("li");
          const args = Object.entries(c.args || {}).filter(([k]) => k !== "fresh").map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`).join(" ");
          li.append(el("span", ok ? "✓" : "–", ok ? "ok" : "warn"), el("span", ` ${c.name} ${args} → ${c.status}${c.source ? ` ${c.source}` : ""}`));
          return li;
        }));
        answer.innerHTML = markdown(body.answer || "(no answer)");
        const sources = [...new Set(body.calls.flatMap((c) => (c.source ? c.source.split(",") : [])))];
        meta.textContent = `${body.calls.length} tool call${body.calls.length === 1 ? "" : "s"}${sources.length ? ` · sources: ${sources.join(", ")}` : ""} · model ${body.model || "?"} · not financial advice`;
      } catch {
        calls.replaceChildren();
        answer.replaceChildren(el("p", "Ask is unavailable right now. Try again shortly.", "muted"));
      } finally {
        button.disabled = false;
        button.textContent = "Ask";
      }
    });
  };

  const run = () => {
    if (!api) return;
    if (kind === "token") token();
    else if (kind === "chain") live();
    else if (kind === "ask") ask();
  };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", run);
  else run();
})();
// Tool pages (/stocks, /screener, /wallet, /explain), the embeddable card and holder access.
(() => {
  "use strict";
  const root = document.querySelector("[data-live]");
  const api = root ? (root.getAttribute("data-api") || "").replace(/\/$/, "") : "";
  const kind = root ? root.getAttribute("data-live") : "";
  const num = (v) => (v === null || v === undefined || v === "" ? NaN : Number(v));
  const usd = (v) => {
    const n = num(v);
    if (!Number.isFinite(n)) return "—";
    if (Math.abs(n) >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
    if (Math.abs(n) >= 1e6) return `$${(n / 1e6).toFixed(2)}M`;
    if (Math.abs(n) >= 1e4) return `$${(n / 1e3).toFixed(1)}K`;
    if (Math.abs(n) >= 1) return `$${n.toFixed(2)}`;
    if (n === 0) return "$0";
    return `$${n.toPrecision(4)}`;
  };
  const compact = (v) => {
    const n = num(v);
    if (!Number.isFinite(n)) return "—";
    if (Math.abs(n) >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
    if (Math.abs(n) >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
    if (Math.abs(n) >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
    if (n !== 0 && Math.abs(n) < 0.001) return n.toPrecision(2);
    return n.toFixed(n < 10 ? 3 : 0);
  };
  const pct = (v, digits = 2) => {
    const n = num(v);
    return Number.isFinite(n) ? `${n > 0 ? "+" : ""}${n.toFixed(digits)}%` : "—";
  };
  const ago = (iso) => {
    const t = Date.parse(iso);
    if (!Number.isFinite(t)) return "";
    const s = Math.max(0, Math.round((Date.now() - t) / 1000));
    return s < 90 ? `${s}s ago` : s < 5400 ? `${Math.round(s / 60)}m ago` : s < 172800 ? `${Math.round(s / 3600)}h ago` : `${Math.round(s / 86400)}d ago`;
  };
  const short = (a) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : "—");
  const src = (s) => (!s ? "" : s.status === "LIVE" || s.status === "CACHED" ? `${s.status} · ${s.source || "?"}${s.fetchedAt ? ` · ${ago(s.fetchedAt)}` : ""}` : `${s.status}${s.reason ? ` · ${s.reason}` : ""}`);
  const el = (tag, text, cls) => {
    const n = document.createElement(tag);
    if (text !== undefined) n.textContent = text;
    if (cls) n.className = cls;
    return n;
  };
  const row = (cells) => {
    const tr = el("tr");
    for (const c of cells) {
      const td = el("td", c.text, c.cls);
      if (c.node) td.replaceChildren(c.node);
      if (c.title) td.title = c.title;
      if (c.tone !== undefined && Number.isFinite(num(c.tone)) && num(c.tone) !== 0) td.classList.add(num(c.tone) > 0 ? "up" : "down");
      tr.append(td);
    }
    return tr;
  };
  const message = (card, text) => {
    const body = card.querySelector("tbody");
    const tr = el("tr");
    const td = el("td", text, "muted");
    td.colSpan = card.querySelectorAll("th").length;
    tr.append(td);
    body.replaceChildren(tr);
  };
  const getJson = async (path, init) => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 45000);
    try {
      const r = await fetch(`${api}${path}`, { credentials: "omit", signal: ctrl.signal, ...init });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) throw Object.assign(new Error(body.message || String(r.status)), { body });
      return body;
    } finally {
      clearTimeout(timer);
    }
  };
  const flagChips = (flags) => {
    const wrap = el("span", undefined, "chips");
    if (!flags) wrap.append(el("span", "security n/a", "chip"));
    else for (const f of flags) wrap.append(el("span", f.text, `chip ${f.level === "ok" ? "chip-ok" : f.level === "danger" ? "chip-danger" : "chip-warn"}`));
    return wrap;
  };

  // ------------------------------------------------------------------ holder access (used by /ask and /explain)
  const KEY = "splice.holder";
  const read = () => {
    try {
      const v = JSON.parse(localStorage.getItem(KEY) || "null");
      return v && Date.parse(v.expiresAt) > Date.now() ? v : null;
    } catch {
      return null;
    }
  };
  window.spliceHolder = { pass: () => (read() ? read().pass : null) };
  const holderBox = document.querySelector("[data-holder]");
  if (holderBox && api) {
    const button = holderBox.querySelector("[data-holder-connect]");
    const status = holderBox.querySelector("[data-holder-status]");
    const show = () => {
      const h = read();
      if (h) {
        status.textContent = `Holder access active for ${short(h.address)} · ${h.dailyQuestions} questions a day · until ${new Date(h.expiresAt).toLocaleString()}`;
        status.classList.add("up");
        button.textContent = "Disconnect";
      } else button.textContent = "Connect wallet";
    };
    show();
    button.addEventListener("click", async () => {
      if (read()) {
        try {
          localStorage.removeItem(KEY);
        } catch {
          /* storage unavailable */
        }
        status.classList.remove("up");
        status.textContent = "Disconnected.";
        return show();
      }
      if (!window.ethereum) {
        status.textContent = "No wallet found in this browser. Open this page in a browser with a wallet (for example MetaMask or Robinhood Wallet).";
        return;
      }
      button.disabled = true;
      try {
        const [address] = await window.ethereum.request({ method: "eth_requestAccounts" });
        const m = await getJson(`/v1/holder/message?address=${address}`);
        status.textContent = "Sign the message in your wallet (no transaction, no gas)…";
        const signature = await window.ethereum.request({ method: "personal_sign", params: [m.message, address] });
        const r = await getJson("/v1/holder/verify", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ address: m.address, issuedAt: m.issuedAt, signature }) });
        if (r.holder) {
          try {
            localStorage.setItem(KEY, JSON.stringify({ pass: r.pass, address: r.address, expiresAt: r.expiresAt, dailyQuestions: r.dailyQuestions }));
          } catch {
            /* storage unavailable: the pass lasts for this page only */
          }
          window.spliceHolder = { pass: () => r.pass };
          show();
          if (!read()) status.textContent = `Holder access active for ${short(r.address)} on this page.`;
        } else status.textContent = r.message || "This wallet does not hold enough $SPLICE.";
      } catch (error) {
        status.textContent = error && error.code === 4001 ? "Signature cancelled." : (error && error.message) || "Could not verify the wallet. Try again.";
      } finally {
        button.disabled = false;
      }
    });
  }
  if (!root || !api) return;

  // ------------------------------------------------------------------ /stocks
  const stocks = async () => {
    const card = root.querySelector('[data-table="premiums"]');
    let d;
    try {
      d = await getJson("/v1/stocks");
    } catch {
      return message(card, "Live data is unavailable right now. Try again in a minute.");
    }
    const rows = [...d.tokens].sort((a, b) => Math.abs(num(b.premiumPct) || 0) - Math.abs(num(a.premiumPct) || 0));
    if (!rows.length) return message(card, "No stock token pools right now.");
    card.querySelector("tbody").replaceChildren(...rows.map((t) => row([
      { text: t.symbol, cls: "strong", title: t.name || "" },
      { text: usd(t.dexPriceUsd) },
      { text: t.referencePriceUsd !== null ? `${usd(t.referencePriceUsd)} · ${t.referenceSource === "last-close" ? "last close" : "quote"}` : "unavailable", title: t.referenceSource === "last-close" ? `Stock's last close (Finnhub) at ${t.referenceTime || "?"}; Robinhood's quote spread is ${num(t.quoteSpreadPct).toFixed(1)}%` : `Robinhood quote at ${t.quotedAt || "?"}` },
      { text: pct(t.premiumPct), tone: t.premiumPct, cls: "strong" },
      { text: pct(t.change24hPct), tone: t.change24hPct },
      { text: usd(t.volume24hUsd) },
      { text: usd(t.liquidityUsd) },
    ])));
    card.querySelector("[data-source]").textContent = `DEX: ${src(d.sources.dex)} · reference: ${src(d.sources.reference)} · updated ${ago(d.updatedAt)}${d.session === "closed" ? " · US market closed: reference = last close" : ""}`;
  };

  // ------------------------------------------------------------------ /screener
  const screener = async () => {
    const card = root.querySelector('[data-table="screener"]');
    const liq = root.querySelector("[data-screener-liq]");
    const clean = root.querySelector("[data-screener-clean]");
    let d;
    try {
      d = await getJson("/v1/screener");
    } catch {
      return message(card, "Live data is unavailable right now. Try again in a minute.");
    }
    const draw = () => {
      const min = num(liq.value) || 0;
      const list = d.tokens.filter((t) => (num(t.liquidityUsd) || 0) >= min && !(clean.checked && (t.flags || []).some((f) => f.level === "danger")));
      if (!list.length) return message(card, "No token matches these filters.");
      card.querySelector("tbody").replaceChildren(...list.map((t) => {
        const link = el("a", `${t.symbol || "?"}`, "text-link");
        link.href = `explain?address=${t.address}`;
        link.title = `${t.name || ""} ${t.address || ""}`.trim();
        return row([
          { node: link, cls: "strong" },
          { text: t.createdAt ? ago(t.createdAt).replace(" ago", "") : "—" },
          { text: usd(t.liquidityUsd) },
          { text: usd(t.volume24hUsd) },
          { text: Number.isFinite(num(t.buys24h)) ? `${t.buys24h} / ${t.sells24h}` : "—" },
          { node: flagChips(t.flags) },
        ]);
      }));
    };
    draw();
    liq.addEventListener("input", draw);
    clean.addEventListener("change", draw);
    card.querySelector("[data-source]").textContent = `pools: ${src(d.sources.pools)} · security: ${src(d.sources.security)} · updated ${ago(d.updatedAt)}`;
  };

  // ------------------------------------------------------------------ /wallet
  const wallet = () => {
    const form = root.querySelector("[data-lookup-form]");
    const input = form.querySelector("input");
    const result = root.querySelector("[data-wallet-result]");
    const note = root.querySelector("[data-wallet-note]");
    const baseNote = note.textContent;
    const stat = (key, text, sub) => {
      const card = root.querySelector(`[data-stat="${key}"]`);
      card.querySelector("[data-value]").textContent = text;
      card.querySelector("[data-note]").textContent = sub || "";
    };
    const lookup = async (address) => {
      const button = form.querySelector("button");
      button.disabled = true;
      button.textContent = "Loading…";
      try {
        const d = await getJson(`/v1/wallet/${address}`);
        result.hidden = false;
        stat("value", usd(d.pricedValueUsd), d.unpricedTokens ? `${d.unpricedTokens} tokens without a price source` : "all tokens priced");
        stat("eth", d.native.amount !== null ? num(d.native.amount).toFixed(5) : "—", d.native.valueUsd !== null ? usd(d.native.valueUsd) : "");
        stat("tokens", String(d.tokenCount), src(d.sources.tokens));
        stat("risk", d.riskFlags === null ? "n/a" : d.riskFlags.length ? d.riskFlags.join(", ") : "none", src(d.sources.risk));
        const holdings = root.querySelector('[data-table="holdings"]');
        if (d.holdings.length) holdings.querySelector("tbody").replaceChildren(...d.holdings.map((h) => row([{ text: h.symbol || short(h.address), cls: "strong", title: `${h.name || ""} ${h.address}`.trim() }, { text: compact(h.amount) }, { text: h.priceUsd !== null ? usd(h.priceUsd) : "no price source", cls: h.priceUsd !== null ? "" : "muted" }, { text: h.valueUsd !== null ? usd(h.valueUsd) : "—" }])));
        else message(holdings, d.sources.tokens.status === "LIVE" ? "No ERC-20 tokens in this wallet." : "Token balances are unavailable right now.");
        holdings.querySelector("[data-source]").textContent = `balances: ${src(d.sources.tokens)} · prices: ${src(d.sources.prices)}`;
        const transfers = root.querySelector('[data-table="transfers"]');
        if (d.transfers.length) transfers.querySelector("tbody").replaceChildren(...d.transfers.map((t) => row([{ text: ago(t.time).replace(" ago", "") }, { text: t.direction, cls: t.direction === "in" ? "up strong" : "down strong" }, { text: t.symbol || "?" }, { text: compact(t.amount) }, { text: short(t.counterparty), title: t.counterparty || "" }])));
        else message(transfers, "No recent token transfers.");
        transfers.querySelector("[data-source]").textContent = src(d.sources.transfers);
        note.textContent = baseNote;
      } catch {
        result.hidden = true;
        note.textContent = "Could not load this wallet right now. Check the address and try again.";
      } finally {
        button.disabled = false;
        button.textContent = "Look up";
      }
    };
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      const address = input.value.trim();
      if (!/^0x[0-9a-fA-F]{40}$/.test(address)) return;
      history.replaceState(null, "", `?address=${address}`);
      lookup(address);
    });
    const preset = new URLSearchParams(location.search).get("address");
    if (preset && /^0x[0-9a-fA-F]{40}$/.test(preset)) {
      input.value = preset;
      lookup(preset);
    }
  };

  // ------------------------------------------------------------------ /explain
  const esc = (s) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const paragraphs = (text) => {
    const fmt = (s) => esc(s).replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>").replace(/`([^`]+)`/g, "<code>$1</code>");
    const out = [];
    const lines = text.replace(/\r/g, "").split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (/^\s*[-*] /.test(line)) {
        const items = [];
        while (i < lines.length && /^\s*[-*] /.test(lines[i])) items.push(lines[i++].replace(/^\s*[-*] /, ""));
        i--;
        out.push(`<ul>${items.map((x) => `<li>${fmt(x)}</li>`).join("")}</ul>`);
      } else if (/^#{1,6} /.test(line)) out.push(`<h3>${fmt(line.replace(/^#+ /, "").replace(/:$/, ""))}</h3>`);
      else if (line.trim()) out.push(`<p>${fmt(line)}</p>`);
    }
    return out.join("");
  };  const explain = () => {
    const form = root.querySelector("[data-lookup-form]");
    const input = form.querySelector("input");
    const box = root.querySelector("[data-explain-result]");
    const text = root.querySelector("[data-explain-text]");
    const run = async (address) => {
      const button = form.querySelector("button");
      button.disabled = true;
      button.textContent = "Reading…";
      box.hidden = false;
      text.replaceChildren(el("p", "Reading the contract from Blockscout and GoPlus…", "muted"));
      try {
        const r = await getJson(`/v1/contract/${address}/explain`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ pass: window.spliceHolder.pass() || undefined }) });
        const f = r.facts;
        root.querySelector("[data-explain-name]").textContent = f.name || short(f.address);
        const badges = root.querySelector("[data-explain-badges]");
        badges.replaceChildren(el("span", f.verified ? "source verified" : f.verified === false ? "not verified" : "verification unknown", `chip ${f.verified ? "chip-ok" : "chip-warn"}`));
        if (f.proxy) badges.append(el("span", "proxy", "chip chip-warn"));
        root.querySelector("[data-explain-flags]").replaceChildren(flagChips(f.flags));
        if (r.explanation) text.innerHTML = paragraphs(r.explanation.text);
        else text.replaceChildren(el("p", r.message || "No explanation available.", "muted"));
        root.querySelector("[data-explain-count]").textContent = `(${f.functions.length})`;
        root.querySelector("[data-explain-fns]").replaceChildren(...f.functions.map((fn) => el("li", fn)));
        root.querySelector("[data-explain-meta]").textContent = `interface: ${src(f.sources.verified)} · flags: ${src(f.sources.security)}${r.explanation ? ` · model ${r.explanation.model || "?"}` : ""} · not an audit`;
      } catch (error) {
        text.replaceChildren(el("p", (error && error.message && !/^\d+$/.test(error.message) ? error.message : "Could not explain this contract right now. Try again shortly."), "muted"));
      } finally {
        button.disabled = false;
        button.textContent = "Explain";
      }
    };
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      const address = input.value.trim();
      if (!/^0x[0-9a-fA-F]{40}$/.test(address)) return;
      history.replaceState(null, "", `?address=${address}`);
      run(address);
    });
    for (const chip of root.querySelectorAll("[data-explain-example]")) {
      chip.addEventListener("click", () => {
        input.value = chip.getAttribute("data-explain-example");
        form.requestSubmit();
      });
    }
    const preset = new URLSearchParams(location.search).get("address");
    if (preset && /^0x[0-9a-fA-F]{40}$/.test(preset)) {
      input.value = preset;
      run(preset);
    }
  };

  // ------------------------------------------------------------------ /embed/splice
  const embed = async () => {
    const SVGNS = "http://www.w3.org/2000/svg";
    const tinyUsd = (n) => {
      if (!(n > 0 && n < 0.0001)) return usd(n);
      const zeros = Math.ceil(-Math.log10(n)) - 1;
      return `$${n.toFixed(zeros + 4)}`;
    };
    const set = (key, value) => (root.querySelector(`[data-embed-${key}]`).textContent = value);
    let supply = 1e9;
    try {
      const d = await getJson("/v1/token");
      const st = (d.market && d.market.stats) || {};
      supply = num(d.totalSupply) || supply;
      set("price", tinyUsd(d.priceUsd ?? num(st.priceUsd)));
      const change = root.querySelector("[data-embed-change]");
      const ch = st.changePct ? st.changePct.h24 : null;
      change.textContent = `24h ${pct(ch)}`;
      if (Number.isFinite(num(ch)) && num(ch) !== 0) change.classList.add(num(ch) > 0 ? "up" : "down");
      set("mc", usd(d.fdvUsd));
      set("liq", usd(d.pool ? d.pool.liquidityUsd : st.liquidityUsd));
      set("holders", d.holders || "—");
      const closes = ((d.market && d.market.chart) || []).slice(-180).map((k) => k[4]).filter(Number.isFinite);
      if (closes.length > 1) {
        const lo = Math.min(...closes), hi = Math.max(...closes), span = hi - lo || 1;
        const path = document.createElementNS(SVGNS, "path");
        path.setAttribute("d", closes.map((y, i) => `${i ? "L" : "M"}${((i * 300) / (closes.length - 1)).toFixed(1)} ${(56 - ((y - lo) / span) * 52).toFixed(1)}`).join(" "));
        path.setAttribute("class", closes[closes.length - 1] >= closes[0] ? "spark up" : "spark down");
        path.setAttribute("vector-effect", "non-scaling-stroke");
        root.querySelector("[data-embed-spark]").replaceChildren(path);
      }
    } catch {
      set("price", "unavailable");
    }
    const tick = async () => {
      if (document.hidden) return;
      try {
        const live = await getJson("/v1/token/live");
        if (live.status !== "LIVE") return;
        set("price", tinyUsd(live.priceUsd));
        set("mc", usd(live.priceUsd * supply));
        set("liq", usd(live.liquidityUsd));
        root.querySelector("[data-embed-live]").classList.add("on");
      } catch {
        root.querySelector("[data-embed-live]").classList.remove("on");
      }
    };
    tick();
    setInterval(tick, 15000);
  };

  const start = () => {
    if (kind === "stocks") stocks();
    else if (kind === "screener") screener();
    else if (kind === "wallet") wallet();
    else if (kind === "explain") explain();
    else if (kind === "embed") embed();
  };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
  else start();
})();
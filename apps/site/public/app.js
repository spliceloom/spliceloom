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
  const createTokenChart = (host) => {
    const L = window.LightweightCharts;
    if (!L) return null;
    const chart = L.createChart(host, {
      autoSize: true,
      layout: { background: { type: "solid", color: "transparent" }, textColor: "#a4a8ad", fontFamily: "Geist Mono, ui-monospace, monospace", fontSize: 11 },
      grid: { vertLines: { color: "rgba(255,255,255,0.04)" }, horzLines: { color: "rgba(255,255,255,0.04)" } },
      rightPriceScale: { borderColor: "rgba(255,255,255,0.08)" },
      timeScale: { borderColor: "rgba(255,255,255,0.08)", timeVisible: true, secondsVisible: false, rightOffset: 4 },
      crosshair: { mode: 0 },
    });
    const candles = chart.addSeries(L.CandlestickSeries, {
      upColor: "#8fcfae", downColor: "#e48d8d", borderUpColor: "#8fcfae", borderDownColor: "#e48d8d", wickUpColor: "#8fcfae", wickDownColor: "#e48d8d",
      // Plain decimals on the canvas axis (subscript digits are not in every canvas font).
      priceFormat: { type: "custom", formatter: (p) => (p > 0 && p < 0.0001 ? `$${p.toFixed(Math.ceil(-Math.log10(p)) + 3)}` : usd(p)), minMove: 1e-12 },
    });
    const volume = chart.addSeries(L.HistogramSeries, { priceScaleId: "", priceFormat: { type: "volume" }, lastValueVisible: false, priceLineVisible: false });
    volume.priceScale().applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
    return { chart, candles, volume };
  };
  const token = async () => {
    const sources = root.querySelector("[data-sources]");
    let d;
    try {
      d = await getJson("/v1/token");
    } catch {
      sources.replaceChildren(el("li", "Live data is unavailable right now. Try again in a minute.", "muted"));
      root.querySelector("[data-price-note]").textContent = "Live data unavailable";
      return;
    }
    const m = d.market || {};
    const st = m.stats || {};
    const set = (key, text, note) => {
      const card = root.querySelector(`[data-stat="${key}"]`);
      if (!card) return;
      card.querySelector("[data-value]").textContent = text;
      card.querySelector("[data-note]").textContent = note || "";
    };
    const priceEl = root.querySelector("[data-price]");
    const showPrice = (p, note) => {
      if (!Number.isFinite(num(p))) return;
      const prev = num(priceEl.dataset.v);
      priceEl.textContent = usd(p);
      priceEl.dataset.v = String(p);
      if (Number.isFinite(prev) && prev !== num(p)) {
        priceEl.classList.remove("tick-up", "tick-down");
        void priceEl.offsetWidth;
        priceEl.classList.add(num(p) > prev ? "tick-up" : "tick-down");
      }
      if (note) root.querySelector("[data-price-note]").textContent = note;
    };
    showPrice(d.priceUsd ?? num(st.priceUsd), d.priceUsd !== null ? `live from the pool · ${sourceText(d.sources.pool)}` : `codex · ${ago(m.updatedAt)}`);
    const change = root.querySelector("[data-change]");
    const ch = st.changePct ? st.changePct.h24 : null;
    change.textContent = `24h ${pct(ch)}`;
    tone(change, ch);

    const codexNote = `codex · ${ago(m.updatedAt)}`;
    set("fdvUsd", usd(d.fdvUsd ?? st.marketCapUsd), d.fdvUsd !== null ? "price × total supply" : codexNote);
    set("liquidityUsd", usd(d.pool ? d.pool.liquidityUsd : st.liquidityUsd), d.pool ? "pool reserves × Chainlink ETH/USD" : codexNote);
    set("volume24hUsd", usd(st.volumeUsd ? st.volumeUsd.h24 : null), codexNote);
    set("holders", amount(d.holders ?? st.holders), sourceText(d.sources.holders));
    set("txns24", amount(st.txns24), codexNote);
    set("uniqueBuyers24", amount(st.uniqueBuyers24), st.uniqueSellers24 !== undefined && st.uniqueSellers24 !== null ? `${amount(st.uniqueSellers24)} unique sellers` : codexNote);
    set("burned", d.burned && d.burned.pctOfSupply !== null ? `${num(d.burned.pctOfSupply).toFixed(2)}%` : "—", d.burned && d.burned.total !== null ? `${amount(d.burned.total)} SPLICE` : "");
    set("totalSupply", amount(d.totalSupply), sourceText(d.sources.totalSupply));

    // ---- candlestick chart: Codex 5-minute history + live pool price for the current candle
    const base = (m.chart || []).filter((k) => Array.isArray(k) && k.length >= 6).map((k) => ({ time: k[0], open: k[1], high: k[2], low: k[3], close: k[4], value: k[5] }));
    const host = root.querySelector("[data-tv-chart]");
    const empty = root.querySelector("[data-chart-empty]");
    const ohlc = root.querySelector("[data-chart-ohlc]");
    const tv = createTokenChart(host);
    let tf = 300;
    const render = () => {
      if (!tv) return;
      const agg = aggregate(base, tf);
      tv.candles.setData(agg.map(({ time, open, high, low, close }) => ({ time, open, high, low, close })));
      tv.volume.setData(agg.map((k) => ({ time: k.time, value: k.value, color: k.close >= k.open ? "rgba(143,207,174,0.35)" : "rgba(228,141,141,0.35)" })));
    };
    if (tv && base.length) {
      empty.hidden = true;
      render();
      tv.chart.timeScale().fitContent();
      tv.chart.subscribeCrosshairMove((param) => {
        const bar = param && param.seriesData ? param.seriesData.get(tv.candles) : null;
        ohlc.textContent = bar ? `O ${usd(bar.open)}  H ${usd(bar.high)}  L ${usd(bar.low)}  C ${usd(bar.close)}` : "";
      });
    } else empty.textContent = !tv ? "Chart library failed to load." : d.sources.chart && d.sources.chart.status !== "LIVE" ? `Chart unavailable: ${d.sources.chart.reason || d.sources.chart.status}` : "Not enough trading history yet.";
    for (const button of root.querySelectorAll("[data-tf]")) {
      button.addEventListener("click", () => {
        tf = Number(button.getAttribute("data-tf"));
        for (const b of root.querySelectorAll("[data-tf]")) b.setAttribute("aria-pressed", String(b === button));
        render();
        if (tv) tv.chart.timeScale().fitContent();
      });
    }
    const chartSource = root.querySelector("[data-chart-source]");
    chartSource.textContent = `history: codex 5-minute candles · updated ${ago(m.updatedAt)}`;
    /** Applies one live price (unix seconds) to the current 5-minute candle. */
    const tick = (time, price, addVolume = 0) => {
      if (!Number.isFinite(price) || !Number.isFinite(time)) return;
      const bucket = Math.floor(time / 300) * 300;
      const last = base[base.length - 1];
      if (last && bucket < last.time) return;
      if (last && last.time === bucket) {
        last.high = Math.max(last.high, price);
        last.low = Math.min(last.low, price);
        last.close = price;
        last.value += addVolume;
      } else base.push({ time: bucket, open: last ? last.close : price, high: Math.max(price, last ? last.close : price), low: Math.min(price, last ? last.close : price), close: price, value: addVolume });
      if (!tv) return;
      if (empty.hidden === false && base.length) {
        empty.hidden = true;
        render();
        return;
      }
      const agg = aggregate(base.slice(-Math.ceil(tf / 300) - 1), tf);
      const k = agg[agg.length - 1];
      tv.candles.update({ time: k.time, open: k.open, high: k.high, low: k.low, close: k.close });
      tv.volume.update({ time: k.time, value: k.value, color: k.close >= k.open ? "rgba(143,207,174,0.35)" : "rgba(228,141,141,0.35)" });
    };

    // ---- buy / sell pressure
    const buys = num(st.buys24), sells = num(st.sells24);
    if (Number.isFinite(buys) && Number.isFinite(sells) && buys + sells > 0) {
      root.querySelector("[data-flow-buy]").setAttribute("width", String((buys / (buys + sells)) * 1000));
      root.querySelector("[data-flow-buys]").textContent = `${amount(buys)} buys`;
      root.querySelector("[data-flow-sells]").textContent = `${amount(sells)} sells`;
      root.querySelector("[data-flow-note]").textContent = codexNote;
    }

    // ---- holders
    const holderList = root.querySelector("[data-holders]");
    const top = d.topHolders || [];
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

    // ---- trades: Codex history merged with live on-chain swaps
    const trades = new Map();
    for (const t of m.trades || []) if (t.txHash) trades.set(t.txHash, { type: t.type, valueUsd: num(t.valueUsd), splice: Number.isFinite(num(t.valueUsd)) && num(t.priceUsd) > 0 ? num(t.valueUsd) / num(t.priceUsd) : NaN, wallet: t.maker, txHash: t.txHash, time: t.time, fresh: false });
    const body = root.querySelector("[data-trades]");
    const drawTrades = () => {
      const list = [...trades.values()].sort((a, b) => Date.parse(b.time || 0) - Date.parse(a.time || 0)).slice(0, 14);
      body.replaceChildren(...list.map((t) => {
        const buy = /buy/i.test(t.type);
        const tr = row([{ text: buy ? "Buy" : "Sell", cls: buy ? "up strong" : "down strong" }, { text: usd(t.valueUsd) }, { text: amount(t.splice) }, { text: short(t.wallet), title: t.wallet || "" }, { text: t.time ? ago(t.time) : "just now" }]);
        if (t.fresh) {
          tr.classList.add(buy ? "flash-up" : "flash-down");
          t.fresh = false;
        }
        return tr;
      }));
      if (!list.length) body.replaceChildren(row([{ text: "No trades available right now.", cls: "muted" }]));
    };
    drawTrades();
    const tradesSource = root.querySelector("[data-trades-source]");
    tradesSource.textContent = `history: ${codexNote} · new trades: on-chain swap events`;

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

    const labels = { metadata: "Name, symbol, decimals", totalSupply: "Total supply", holders: "Holders and top holders", burned: "Burned balances", pool: "Pool reserves (live price, liquidity)", ethUsd: "ETH/USD (Chainlink)", stats: "24h activity", chart: "Candle history", trades: "Trade history" };
    sources.replaceChildren(...Object.entries(d.sources).map(([k, s]) => {
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
        const ts = Date.parse(live.time) / 1000;
        for (const s of [...(live.swaps || [])].reverse()) {
          const key = `${s.txHash}:${s.logIndex}`;
          if (seen.has(key)) continue;
          seen.add(key);
          const known = trades.has(s.txHash);
          trades.set(s.txHash, { type: s.type, valueUsd: s.valueUsd, splice: s.splice, wallet: s.wallet, txHash: s.txHash, time: s.time, fresh: !known });
          if (!known && s.time) tick(Date.parse(s.time) / 1000, s.priceUsd, num(s.valueUsd) || 0);
        }
        drawTrades();
        tick(ts, live.priceUsd);
        showPrice(live.priceUsd, `live · block ${amount(live.block)} · ${new Date(live.time).toLocaleTimeString("en-US", { hour12: false })}`);
        if (Number.isFinite(num(live.liquidityUsd))) set("liquidityUsd", usd(live.liquidityUsd), "pool reserves × Chainlink ETH/USD · live");
        if (Number.isFinite(num(live.priceUsd)) && d.totalSupply) set("fdvUsd", usd(num(live.priceUsd) * num(d.totalSupply)), "price × total supply · live");
        dot.textContent = "LIVE";
        dot.classList.add("on");
        tradesDot.textContent = "LIVE";
        tradesDot.classList.add("on");
        chartSource.textContent = `history: codex 5-minute candles · updated ${ago(m.updatedAt)} · current candle: live pool price (block ${amount(live.block)})`;
      } catch {
        dot.textContent = "reconnecting…";
        dot.classList.remove("on");
      }
    };
    poll();
    setInterval(poll, LIVE_MS);
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden) poll();
    });
  };
  // ------------------------------------------------------------------ /live
  const fillTable = (key, rows, source) => {
    const card = root.querySelector(`[data-table="${key}"]`);
    if (!card) return;
    const body = card.querySelector("tbody");
    const cols = card.querySelectorAll("th").length;
    if (!rows.length) {
      const tr = el("tr");
      const td = el("td", source && source.status !== "LIVE" && source.status !== "CACHED" ? `Unavailable${source.reason ? `: ${source.reason}` : ""}` : "No data right now.", "muted");
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
    fillTable("gainers", stockRows(d.stocks.gainers), d.sources.stocks);
    fillTable("losers", stockRows(d.stocks.losers), d.sources.stocks);
    fillTable("perps", d.perps.map((p) => row([{ text: p.symbol, cls: "strong" }, { text: usd(p.markPrice) }, { text: pct(p.change24hPct), tone: p.change24hPct }, { text: usd(p.openInterestUsd) }])), d.sources.perps);
    fillTable("protocols", d.protocols.map((p) => row([{ text: p.name, cls: "strong" }, { text: p.category || "—" }, { text: usd(p.tvlUsd) }, { text: pct(p.change7dPct), tone: p.change7dPct }])), d.sources.protocols);
    fillTable("newPools", d.newPools.map((p) => row([{ text: p.name, cls: "strong" }, { text: p.dex || "—" }, { text: usd(p.liquidityUsd) }, { text: ago(p.createdAt) }])), d.sources.newPools);
  };

  // ------------------------------------------------------------------ /ask
  // Minimal, safe Markdown for answers: text is escaped first; only headings, lists, tables, bold and code.
  const esc = (s) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const inline = (s) => esc(s).replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>").replace(/`([^`]+)`/g, "<code>$1</code>");
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
        const r = await fetch(`${api}/v1/ask`, { method: "POST", credentials: "omit", headers: { "content-type": "application/json" }, body: JSON.stringify({ question }) });
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
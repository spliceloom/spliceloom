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

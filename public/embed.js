(function () {
  if (window.__libarChatEmbedInitialized) {
    return;
  }

  window.__libarChatEmbedInitialized = true;

  const EMBED_SOURCE = "LIBAR_CHAT_EMBED";
  const config = window.LibarChatConfig || {};
  const baseUrl = typeof config.baseUrl === "string" ? config.baseUrl.trim().replace(/\/+$/, "") : "";

  if (!baseUrl) {
    console.error("[LibarChat] Missing window.LibarChatConfig.baseUrl");
    return;
  }

  let parsedBaseUrl;

  try {
    parsedBaseUrl = new URL(baseUrl);
  } catch (error) {
    console.error("[LibarChat] Invalid baseUrl:", baseUrl);
    return;
  }

  const side = config.position === "left" ? "left" : "right";
  const offsetX = Number.isFinite(Number(config.offsetX)) ? Number(config.offsetX) : 24;
  const offsetY = Number.isFinite(Number(config.offsetY)) ? Number(config.offsetY) : 24;
  const zIndex = Number.isFinite(Number(config.zIndex)) ? Number(config.zIndex) : 999999;
  const launcherLabel = typeof config.launcherLabel === "string" && config.launcherLabel.trim()
    ? config.launcherLabel.trim()
    : "Chat podrška";
  const iframeUrl = `${parsedBaseUrl.origin}/embed/chat?embed=1`;

  const root = document.createElement("div");
  root.id = "libar-chat-embed-root";
  root.setAttribute("data-side", side);
  root.setAttribute("data-theme", config.theme || "default");
  root.style.setProperty("--libar-chat-offset-x", `${offsetX}px`);
  root.style.setProperty("--libar-chat-offset-y", `${offsetY}px`);
  root.style.setProperty("--libar-chat-z-index", String(zIndex));

  const style = document.createElement("style");
  style.textContent = `
    #libar-chat-embed-root {
      --launcher-size: 60px;
      --panel-width: min(416px, calc(100vw - 32px));
      --panel-height: min(664px, calc(100vh - 112px));
      --panel-radius: 28px;
      position: fixed;
      inset: 0;
      pointer-events: none;
      z-index: var(--libar-chat-z-index);
      font-family: Inter, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }

    #libar-chat-embed-root * {
      box-sizing: border-box;
    }

    #libar-chat-embed-root[data-side="right"] .libar-chat-embed__launcher,
    #libar-chat-embed-root[data-side="right"] .libar-chat-embed__panel {
      right: var(--libar-chat-offset-x);
    }

    #libar-chat-embed-root[data-side="left"] .libar-chat-embed__launcher,
    #libar-chat-embed-root[data-side="left"] .libar-chat-embed__panel {
      left: var(--libar-chat-offset-x);
    }

    .libar-chat-embed__backdrop {
      position: fixed;
      inset: 0;
      background: rgba(20, 14, 11, 0.24);
      opacity: 0;
      pointer-events: none;
      transition: opacity 180ms ease;
    }

    .libar-chat-embed__launcher {
      position: fixed;
      bottom: var(--libar-chat-offset-y);
      width: var(--launcher-size);
      height: var(--launcher-size);
      display: inline-flex;
      align-items: center;
      justify-content: center;
      border: none;
      border-radius: 999px;
      cursor: pointer;
      pointer-events: auto;
      background: linear-gradient(135deg, #f06431 0%, #df5623 100%);
      color: #fff;
      box-shadow: 0 14px 30px rgba(240, 100, 49, 0.24);
      transition: transform 160ms ease, box-shadow 160ms ease, opacity 160ms ease;
    }

    .libar-chat-embed__launcher:hover {
      transform: translateY(-1px);
      box-shadow: 0 18px 36px rgba(240, 100, 49, 0.26);
    }

    .libar-chat-embed__launcher:focus-visible {
      outline: none;
      box-shadow: 0 0 0 4px rgba(240, 100, 49, 0.16);
    }

    .libar-chat-embed__launcher-label {
      position: absolute;
      opacity: 0;
      pointer-events: none;
      white-space: nowrap;
      padding: 8px 12px;
      border-radius: 999px;
      background: rgba(33, 25, 21, 0.9);
      color: #fff;
      font-size: 12px;
      font-weight: 600;
      line-height: 1;
      transition: opacity 160ms ease, transform 160ms ease;
      transform: translateY(4px);
    }

    #libar-chat-embed-root[data-side="right"] .libar-chat-embed__launcher-label {
      right: calc(var(--launcher-size) + 12px);
    }

    #libar-chat-embed-root[data-side="left"] .libar-chat-embed__launcher-label {
      left: calc(var(--launcher-size) + 12px);
    }

    .libar-chat-embed__launcher:hover .libar-chat-embed__launcher-label,
    .libar-chat-embed__launcher:focus-visible .libar-chat-embed__launcher-label {
      opacity: 1;
      transform: translateY(0);
    }

    .libar-chat-embed__panel {
      position: fixed;
      bottom: calc(var(--libar-chat-offset-y) + 64px);
      width: var(--panel-width);
      height: var(--panel-height);
      overflow: hidden;
      opacity: 0;
      pointer-events: none;
      transform: translateY(8px) scale(0.985);
      transform-origin: bottom right;
      transition: opacity 180ms ease, transform 180ms ease;
      border-radius: var(--panel-radius);
      box-shadow: 0 30px 80px rgba(33, 25, 21, 0.18);
      background: rgba(255, 255, 255, 0.98);
    }

    #libar-chat-embed-root[data-side="left"] .libar-chat-embed__panel {
      transform-origin: bottom left;
    }

    .libar-chat-embed__panel iframe {
      width: 100%;
      height: 100%;
      display: block;
      border: none;
      background: transparent;
    }

    #libar-chat-embed-root[data-open="true"] .libar-chat-embed__backdrop {
      opacity: 1;
      pointer-events: auto;
    }

    #libar-chat-embed-root[data-open="true"] .libar-chat-embed__panel {
      opacity: 1;
      pointer-events: auto;
      transform: translateY(0) scale(1);
    }

    @media (max-width: 767px) {
      #libar-chat-embed-root {
        --launcher-size: 58px;
        --panel-width: calc(100vw - 12px);
        --panel-height: calc(100vh - 12px);
        --panel-radius: 24px;
      }

      .libar-chat-embed__panel {
        left: 6px !important;
        right: 6px !important;
        bottom: 6px;
        width: auto;
        height: var(--panel-height);
        transform-origin: bottom center;
      }

      .libar-chat-embed__launcher-label {
        display: none;
      }
    }
  `;

  const backdrop = document.createElement("div");
  backdrop.className = "libar-chat-embed__backdrop";

  const launcher = document.createElement("button");
  launcher.type = "button";
  launcher.className = "libar-chat-embed__launcher";
  launcher.setAttribute("aria-label", launcherLabel);
  launcher.setAttribute("aria-expanded", "false");
  launcher.innerHTML = `
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path>
    </svg>
    <span class="libar-chat-embed__launcher-label">${launcherLabel}</span>
  `;

  const panel = document.createElement("div");
  panel.className = "libar-chat-embed__panel";

  const iframe = document.createElement("iframe");
  iframe.src = iframeUrl;
  iframe.title = launcherLabel;
  iframe.loading = "lazy";
  iframe.referrerPolicy = "strict-origin-when-cross-origin";
  iframe.allow = "clipboard-write";
  panel.appendChild(iframe);

  root.appendChild(style);
  root.appendChild(backdrop);
  root.appendChild(panel);
  root.appendChild(launcher);
  document.body.appendChild(root);

  function setOpen(nextOpen) {
    root.setAttribute("data-open", nextOpen ? "true" : "false");
    launcher.setAttribute("aria-expanded", nextOpen ? "true" : "false");

    if (nextOpen) {
      iframe.contentWindow?.postMessage({ source: EMBED_SOURCE, action: "open" }, "*");
    }
  }

  function toggle() {
    const nextOpen = root.getAttribute("data-open") !== "true";
    setOpen(nextOpen);
  }

  launcher.addEventListener("click", toggle);
  backdrop.addEventListener("click", function () {
    setOpen(false);
  });

  window.addEventListener("keydown", function (event) {
    if (event.key === "Escape" && root.getAttribute("data-open") === "true") {
      setOpen(false);
    }
  });

  window.addEventListener("message", function (event) {
    const data = event?.data;

    if (!data || data.source !== EMBED_SOURCE) {
      return;
    }

    if (data.action === "request-close") {
      setOpen(false);
    }
  });

  window.LibarChatEmbed = {
    open: function () {
      setOpen(true);
    },
    close: function () {
      setOpen(false);
    },
    toggle
  };
})();

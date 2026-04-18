const storageKey = "libar-chat-session-id";
const sessionSnapshotKey = "libar-chat-session-snapshot";
const onboardingKey = "libar-chat-onboarding";
const embedParams = new URLSearchParams(window.location.search);
const isEmbedMode = embedParams.get("embed") === "1" || window.self !== window.top;
const embedMessageType = "LIBAR_CHAT_EMBED";

const launcher = document.getElementById("chat-launcher");
const launcherBadge = document.getElementById("chat-launcher-badge");
const widget = document.getElementById("chat-widget");
const closeButton = document.getElementById("chat-close");
const chatStatusText = document.getElementById("chat-status-text");
const welcomeTitle = document.getElementById("chat-welcome-title");
const welcomeSubtitle = document.getElementById("chat-welcome-subtitle");
const closedConversationPanel = document.getElementById("closed-conversation-panel");
const closedConversationTitle = document.getElementById("closed-conversation-title");
const closedConversationText = document.getElementById("closed-conversation-text");
const reviewConversationButton = document.getElementById("review-conversation-button");
const newConversationButton = document.getElementById("new-conversation-button");
const entryFlowPanel = document.getElementById("entry-flow-panel");
const entryFlowTitle = document.getElementById("entry-flow-title");
const entryFlowSubtitle = document.getElementById("entry-flow-subtitle");
const entryFlowChoices = document.getElementById("entry-flow-choices");
const entryFlowPromptForm = document.getElementById("entry-flow-prompt-form");
const entryPromptLabel = document.getElementById("entry-prompt-label");
const entryPromptInput = document.getElementById("entry-prompt-input");
const entryFlowBackButton = document.getElementById("entry-flow-back");
const entryFlowSummary = document.getElementById("entry-flow-summary");
const entryFlowSummaryText = document.getElementById("entry-flow-summary-text");
const entryFlowChangeButton = document.getElementById("entry-flow-change");
const entryFlowSkipButton = document.getElementById("entry-flow-skip");
const messageForm = document.getElementById("message-form");
const messagesEl = document.getElementById("messages");
const errorBox = document.getElementById("error-box");
const messageInput = document.getElementById("message-input");
const fileInput = document.getElementById("file-input");
const imageInput = document.getElementById("image-input");
const filesIndicator = document.getElementById("pending-files-indicator");
const pendingFilesList = document.getElementById("pending-files-list");
const chatInputArea = document.querySelector(".chat-input-area");
const ENTRY_FLOW_VERSION = "v1";
const ENTRY_FLOW_INTENTS = [
  {
    id: "narudzba",
    label: "Narudžba",
    description: "Pitanja o statusu, izmjeni ili detaljima narudžbe.",
    promptLabel: "Ako imate broj narudžbe, upišite ga ovdje.",
    promptPlaceholder: "Primjer: #12458"
  },
  {
    id: "dostava",
    label: "Dostava",
    description: "Rok, cijena ili način isporuke.",
    promptLabel: "Što vas zanima oko dostave?",
    promptPlaceholder: "Primjer: Rok dostave za Split"
  },
  {
    id: "otkup_knjiga",
    label: "Otkup knjiga",
    description: "Želite prodati knjige ili zatražiti procjenu.",
    promptLabel: "Koje knjige nudite za otkup?",
    promptPlaceholder: "Primjer: 20 stručnih knjiga iz ekonomije"
  },
  {
    id: "reklamacija_problem",
    label: "Reklamacija ili problem",
    description: "Oštećenje, pogrešna pošiljka ili drugi problem.",
    promptLabel: "Opišite problem u jednoj rečenici.",
    promptPlaceholder: "Primjer: Stigla je kriva knjiga"
  },
  {
    id: "opci_upit",
    label: "Opći upit",
    description: "Treba vam pomoć oko nečeg drugog.",
    promptLabel: "",
    promptPlaceholder: ""
  }
];
let pollTimer = null;
let streamSource = null;
let lastRenderedSignature = "";
let pendingFiles = [];
let unreadCount = 0;
let typingIndicatorEl = null;
let closedConversationState = null;
let currentResolutionPrompt = null;
let currentConversationTone = "ai-active";
let canonicalMessages = [];
let optimisticMessages = [];

function postEmbedMessage(payload) {
  if (!isEmbedMode || window.parent === window) {
    return;
  }

  window.parent.postMessage(
    {
      source: embedMessageType,
      ...payload
    },
    "*"
  );
}

const onboarding = {
  stage: "initial",
  draft: {
    firstMessage: "",
    name: "",
    email: ""
  },
  messages: [],
  entryFlow: {
    stage: "choices",
    selectedEntryIntent: "",
    entryPromptAnswer: "",
    entryFlowSkipped: false,
    entryFlowVersion: ENTRY_FLOW_VERSION
  }
};
let composerEnabled = true;

function showWidget() {
  widget.classList.remove("hidden");
  widget.setAttribute("aria-hidden", "false");
  launcher.setAttribute("aria-expanded", "true");
  setUnreadCount(0);

  if (!messageInput.disabled && !chatInputArea?.classList.contains("hidden")) {
    messageInput.focus();
  } else if (entryFlowPanel && !entryFlowPanel.classList.contains("hidden")) {
    const focusableTarget =
      entryFlowPromptForm && !entryFlowPromptForm.classList.contains("hidden")
        ? entryPromptInput
        : entryFlowChoices?.querySelector("button");

    focusableTarget?.focus();
  }
}

function hideWidget() {
  if (isEmbedMode) {
    postEmbedMessage({ action: "request-close" });
    return;
  }

  widget.classList.add("hidden");
  widget.setAttribute("aria-hidden", "true");
  launcher.setAttribute("aria-expanded", "false");
}

function showError(message) {
  errorBox.textContent = message;
  errorBox.classList.remove("hidden");
}

function clearError() {
  errorBox.textContent = "";
  errorBox.classList.add("hidden");
}

function formatTime(dateIso) {
  return new Date(dateIso).toLocaleTimeString("hr-HR", {
    hour: "2-digit",
    minute: "2-digit"
  });
}

function createMessage(role, content, createdAt = new Date().toISOString(), products = []) {
  return {
    id: crypto.randomUUID(),
    role,
    content,
    createdAt,
    attachments: [],
    products
  };
}

function normalizeMessageContent(content) {
  return String(content || "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function applySessionMessages(sessionMessages) {
  const incomingMessages = Array.isArray(sessionMessages) ? sessionMessages : [];
  canonicalMessages = mergeProductDataIntoMessages(incomingMessages, canonicalMessages, onboarding.messages);
  optimisticMessages = [];
  updateMessages(canonicalMessages);
}

function mergeProductDataIntoMessages(nextMessages = [], ...messageSources) {
  const productsByMessageId = new Map();

  for (const source of messageSources) {
    for (const message of Array.isArray(source) ? source : []) {
      if (message?.id && Array.isArray(message.products) && message.products.length > 0) {
        productsByMessageId.set(String(message.id), message.products);
      }
    }
  }

  return nextMessages.map((message) => {
    if (Array.isArray(message.products) && message.products.length > 0) {
      return message;
    }

    const preservedProducts = productsByMessageId.get(String(message.id));

    if (!preservedProducts || preservedProducts.length === 0) {
      return message;
    }

    return {
      ...message,
      products: preservedProducts
    };
  });
}

function formatFileSize(size) {
  if (size < 1024) {
    return `${size} B`;
  }

  if (size < 1024 * 1024) {
    return `${(size / 1024).toFixed(1)} KB`;
  }

  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

function saveOnboardingState() {
  localStorage.setItem(onboardingKey, JSON.stringify(onboarding));
}

function clearOnboardingState() {
  localStorage.removeItem(onboardingKey);
}

function saveSessionSnapshot(snapshot) {
  localStorage.setItem(sessionSnapshotKey, JSON.stringify(snapshot));
}

function getSessionSnapshot() {
  const raw = localStorage.getItem(sessionSnapshotKey);

  if (!raw) {
    return null;
  }

  try {
    return JSON.parse(raw);
  } catch (error) {
    localStorage.removeItem(sessionSnapshotKey);
    return null;
  }
}

function clearSessionSnapshot() {
  localStorage.removeItem(sessionSnapshotKey);
}

function resetOnboardingState() {
  onboarding.stage = "initial";
  onboarding.draft = {
    firstMessage: "",
    name: "",
    email: ""
  };
  onboarding.messages = [];
  onboarding.entryFlow = {
    stage: "choices",
    selectedEntryIntent: "",
    entryPromptAnswer: "",
    entryFlowSkipped: false,
    entryFlowVersion: ENTRY_FLOW_VERSION
  };
  canonicalMessages = [];
  optimisticMessages = [];
}

function setUnreadCount(count) {
  unreadCount = Math.max(0, count);

  if (!launcherBadge) {
    return;
  }

  if (unreadCount === 0) {
    launcherBadge.classList.add("hidden");
    launcherBadge.textContent = "0";
    return;
  }

  launcherBadge.classList.remove("hidden");
  launcherBadge.textContent = unreadCount > 9 ? "9+" : String(unreadCount);
}

function closeStream() {
  if (!streamSource) {
    return;
  }

  streamSource.close();
  streamSource = null;
}

function setComposerEnabled(enabled) {
  composerEnabled = enabled;
  syncComposerVisibility();
}

function getEntryIntentConfig(intentId) {
  return ENTRY_FLOW_INTENTS.find((intent) => intent.id === intentId) || null;
}

function normalizeEntryFlow(savedEntryFlow = {}) {
  const selectedIntent = getEntryIntentConfig(savedEntryFlow.selectedEntryIntent)
    ? savedEntryFlow.selectedEntryIntent
    : "";
  const stage = ["choices", "prompt", "ready"].includes(savedEntryFlow.stage)
    ? savedEntryFlow.stage
    : "choices";

  return {
    stage: selectedIntent || savedEntryFlow.entryFlowSkipped ? stage : "choices",
    selectedEntryIntent: selectedIntent,
    entryPromptAnswer: typeof savedEntryFlow.entryPromptAnswer === "string"
      ? savedEntryFlow.entryPromptAnswer
      : "",
    entryFlowSkipped: Boolean(savedEntryFlow.entryFlowSkipped),
    entryFlowVersion: ENTRY_FLOW_VERSION
  };
}

function shouldGateComposerForEntryFlow() {
  const sessionId = localStorage.getItem(storageKey);

  return !sessionId && onboarding.stage === "initial" && onboarding.entryFlow.stage !== "ready";
}

function shouldHideMessagesForEntryFlow() {
  return !localStorage.getItem(storageKey) && onboarding.stage === "initial" && !closedConversationState;
}

function syncMessagesVisibility() {
  if (!messagesEl) {
    return;
  }

  messagesEl.classList.toggle("hidden", shouldHideMessagesForEntryFlow());
}

function syncComposerVisibility() {
  const shouldShowComposer = composerEnabled && !shouldGateComposerForEntryFlow();

  if (chatInputArea) {
    chatInputArea.classList.toggle("hidden", !shouldShowComposer);
  }

  if (messageInput) {
    messageInput.disabled = !shouldShowComposer;
  }
}

function trackEntryFlowEvent(name, extra = {}) {
  const payload = {
    name,
    entryFlowVersion: ENTRY_FLOW_VERSION,
    selectedEntryIntent: onboarding.entryFlow.selectedEntryIntent || null,
    entryFlowSkipped: onboarding.entryFlow.entryFlowSkipped,
    stage: onboarding.entryFlow.stage,
    timestamp: new Date().toISOString(),
    ...extra
  };

  window.dispatchEvent(new CustomEvent("libar-chat-entry-flow", { detail: payload }));

  window.LibarChatAnalytics = window.LibarChatAnalytics || [];
  window.LibarChatAnalytics.push(payload);
}

function setEntryFlowState(nextState = {}) {
  onboarding.entryFlow = {
    ...onboarding.entryFlow,
    ...nextState,
    entryFlowVersion: ENTRY_FLOW_VERSION
  };
  saveOnboardingState();
  renderEntryFlow();
  syncComposerVisibility();
  syncMessagesVisibility();
}

function getEntryFlowSummary() {
  if (onboarding.entryFlow.entryFlowSkipped) {
    return "Ručno upisan upit";
  }

  const selectedIntent = getEntryIntentConfig(onboarding.entryFlow.selectedEntryIntent);

  if (!selectedIntent) {
    return "";
  }

  if (onboarding.entryFlow.entryPromptAnswer) {
    return `${selectedIntent.label} · ${onboarding.entryFlow.entryPromptAnswer}`;
  }

  return selectedIntent.label;
}

function resetEntryFlowChoices() {
  setEntryFlowState({
    stage: "choices",
    selectedEntryIntent: "",
    entryPromptAnswer: "",
    entryFlowSkipped: false
  });
}

function renderEntryFlowChoices() {
  if (!entryFlowChoices) {
    return;
  }

  entryFlowChoices.innerHTML = "";

  ENTRY_FLOW_INTENTS.forEach((intent) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "entry-flow-choice";
    button.dataset.entryIntent = intent.id;

    const title = document.createElement("span");
    title.className = "entry-flow-choice__title";
    title.textContent = intent.label;

    const description = document.createElement("span");
    description.className = "entry-flow-choice__description";
    description.textContent = intent.description;

    button.appendChild(title);
    button.appendChild(description);
    entryFlowChoices.appendChild(button);
  });
}

function renderEntryFlow() {
  if (!entryFlowPanel) {
    return;
  }

  const shouldShow = !localStorage.getItem(storageKey) && onboarding.stage === "initial" && !closedConversationState;
  entryFlowPanel.classList.toggle("hidden", !shouldShow);
  syncMessagesVisibility();

  if (!shouldShow) {
    return;
  }

  const selectedIntent = getEntryIntentConfig(onboarding.entryFlow.selectedEntryIntent);
  const showPrompt =
    onboarding.entryFlow.stage === "prompt" &&
    selectedIntent &&
    selectedIntent.promptLabel;
  const showSummary = onboarding.entryFlow.stage === "ready";

  if (entryFlowTitle) {
    entryFlowTitle.textContent = selectedIntent && showPrompt
      ? selectedIntent.label
      : "Odaberite vrstu upita";
  }

  if (entryFlowSubtitle) {
    entryFlowSubtitle.textContent = selectedIntent && showPrompt
      ? "Jedan kratak podatak pomoći će nam da brže usmjerimo razgovor."
      : "Možete odabrati temu ili odmah napisati upit ručno.";
  }

  entryFlowChoices?.classList.toggle("hidden", onboarding.entryFlow.stage !== "choices");
  entryFlowPromptForm?.classList.toggle("hidden", !showPrompt);
  entryFlowSummary?.classList.toggle("hidden", !showSummary);
  entryFlowSkipButton?.classList.toggle("hidden", onboarding.entryFlow.stage !== "choices");

  if (showPrompt) {
    entryPromptLabel.textContent = selectedIntent.promptLabel;
    entryPromptInput.placeholder = selectedIntent.promptPlaceholder;
    entryPromptInput.value = onboarding.entryFlow.entryPromptAnswer || "";
  }

  if (showSummary && entryFlowSummaryText) {
    entryFlowSummaryText.textContent = getEntryFlowSummary();
  }
}

function hideClosedConversationPanel() {
  closedConversationState = null;
  closedConversationPanel?.classList.add("hidden");
  reviewConversationButton?.classList.remove("is-active");
  renderEntryFlow();
  syncComposerVisibility();
  syncMessagesVisibility();
}

function setResolutionPrompt(prompt) {
  currentResolutionPrompt = prompt?.show ? prompt : null;
}

function clearResolutionPrompt() {
  currentResolutionPrompt = null;
}

function showClosedConversationPanel(payload) {
  closedConversationState = payload;
  closedConversationTitle.textContent =
    payload?.panelTitle || "Što želite dalje?";
  closedConversationText.textContent =
    payload?.panelText || "Možete pregledati završeni razgovor ili odmah otvoriti novi upit.";
  closedConversationPanel?.classList.remove("hidden");
  reviewConversationButton?.classList.add("is-active");
  setComposerEnabled(false);
  hideTypingIndicator();
}

function handleResolvedSession(session, messages) {
  const existingSnapshot = getSessionSnapshot();
  const nextSnapshot = {
    ticketId: session?.ticketId || session?.ticket?.id || existingSnapshot?.ticketId || null,
    requesterId:
      session?.requesterId || session?.requester?.requesterId || existingSnapshot?.requesterId || null,
    requesterName:
      session?.requesterName || session?.requester?.name || existingSnapshot?.requesterName || "",
    requesterEmail:
      session?.requesterEmail || session?.requester?.email || existingSnapshot?.requesterEmail || ""
  };

  localStorage.removeItem(storageKey);
  saveSessionSnapshot(nextSnapshot);
  closeStream();
  stopPolling();
  clearResolutionPrompt();
  applySessionMessages(messages || []);
  showClosedConversationPanel({
    panelTitle: "Što želite dalje?",
    panelText: "Možete pregledati završeni razgovor ili odmah otvoriti novi upit.",
    conversationState: {
      tone: "resolved",
      badge: "Prethodni razgovor je završen",
      subtitle: "Ako imate novo pitanje, ovdje možete otvoriti novi razgovor."
    }
  });
}

function startNewConversationFlow() {
  closeStream();
  stopPolling();
  hideTypingIndicator();
  clearError();
  localStorage.removeItem(storageKey);
  clearSessionSnapshot();
  clearOnboardingState();
  resetOnboardingState();
  hideClosedConversationPanel();
  clearResolutionPrompt();
  pendingFiles = [];
  renderPendingFiles();
  lastRenderedSignature = "";
  seedWelcomeState();
  updateMessages(onboarding.messages);
  renderEntryFlow();
  applyConversationState({
    conversationState: {
      tone: "ai-active",
      badge: "Aktivan",
      subtitle: "Odgovaramo odmah, a po potrebi se u razgovor uključuje i naš tim."
    }
  });
  setComposerEnabled(true);
  showWidget();
}

function isImageAttachment(attachment) {
  return String(attachment?.contentType || attachment?.type || "").startsWith("image/");
}

function renderMessages(messages) {
  messagesEl.innerHTML = "";

  for (const message of messages) {
    messagesEl.appendChild(createMessageElement(message));
  }

  if (currentResolutionPrompt?.show) {
    messagesEl.appendChild(createResolutionPromptElement(currentResolutionPrompt));
  }

  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function getMessagesSignature(messages) {
  const messageSignature = messages
    .map((message) =>
      `${message.id}:${message.role}:${message.createdAt}:${message.content}:${(message.products || [])
        .map(
          (product) =>
            `${product.id || product.title}:${product.title}:${product.priceLabel || ""}:${product.metaLine || ""}:${product.buyLink || ""}:${product.sellLink || ""}:${product.imageUrl || ""}`
        )
        .join(",")}:${(message.attachments || [])
        .map((attachment) => `${attachment.id || attachment.name}:${attachment.name}`)
        .join(",")}`
    )
    .join("|");

  const promptSignature = currentResolutionPrompt?.show
    ? `prompt:${currentResolutionPrompt.title}:${currentResolutionPrompt.text}`
    : "prompt:none";

  return `${messageSignature}|${promptSignature}`;
}

function createResolutionPromptElement(prompt) {
  const wrapper = document.createElement("article");
  wrapper.className = "resolution-prompt";
  wrapper.dataset.messageId = "resolution-prompt";

  const title = document.createElement("p");
  title.className = "resolution-prompt__title";
  title.textContent = prompt.title || "Je li sve u redu?";

  const text = document.createElement("p");
  text.className = "resolution-prompt__text";
  text.textContent = prompt.text || "Ako je problem riješen, možemo završiti ovaj razgovor.";

  const actions = document.createElement("div");
  actions.className = "resolution-prompt__actions";

  const confirmButton = document.createElement("button");
  confirmButton.type = "button";
  confirmButton.className = "resolution-prompt__button is-primary";
  confirmButton.dataset.resolveAction = "confirm";
  confirmButton.textContent = prompt.confirmLabel || "Da, riješeno je";

  const cancelButton = document.createElement("button");
  cancelButton.type = "button";
  cancelButton.className = "resolution-prompt__button is-secondary";
  cancelButton.dataset.resolveAction = "cancel";
  cancelButton.textContent = prompt.cancelLabel || "Ne, trebam još pomoć";

  actions.appendChild(confirmButton);
  actions.appendChild(cancelButton);
  wrapper.appendChild(title);
  wrapper.appendChild(text);
  wrapper.appendChild(actions);

  return wrapper;
}

function createMessageElement(message) {
  const wrapper = document.createElement("article");
  wrapper.className = `message ${message.role}`;
  wrapper.dataset.messageId = String(message.id);

  const content = document.createElement("div");
  content.className = "message-content";
  content.textContent = message.content;
  wrapper.appendChild(content);

  const attachments = Array.isArray(message.attachments) ? message.attachments : [];

  if (attachments.length > 0) {
    const attachmentsEl = document.createElement("div");
    attachmentsEl.className = "message-attachments";

    attachments.forEach((attachment) => {
      const attachmentEl = document.createElement(attachment.url ? "a" : "div");
      attachmentEl.className = "message-attachment";

      if (attachment.url) {
        attachmentEl.href = attachment.url;
        attachmentEl.target = "_blank";
        attachmentEl.rel = "noopener noreferrer";
      }

      let icon;

      if (isImageAttachment(attachment) && attachment.url) {
        icon = document.createElement("img");
        icon.className = "message-attachment__thumb";
        icon.src = attachment.url;
        icon.alt = attachment.name || "Slika";
        icon.loading = "lazy";
      } else {
        icon = document.createElement("div");
        icon.className = "message-attachment__icon";
        icon.innerHTML =
          '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/><path d="M12 18v-6"/><path d="M9.5 14.5 12 12l2.5 2.5"/></svg>';
      }

      const meta = document.createElement("div");
      meta.className = "message-attachment__meta";

      const name = document.createElement("span");
      name.className = "message-attachment__name";
      name.textContent = attachment.name || "Privitak";

      const info = document.createElement("span");
      info.className = "message-attachment__info";
      info.textContent = attachment.size ? formatFileSize(attachment.size) : "Privitak";

      meta.appendChild(name);
      meta.appendChild(info);
      attachmentEl.appendChild(icon);
      attachmentEl.appendChild(meta);
      attachmentsEl.appendChild(attachmentEl);
    });

    wrapper.appendChild(attachmentsEl);
  }

  const products = Array.isArray(message.products) ? message.products : [];

  if (products.length > 0) {
    const productsEl = document.createElement("div");
    productsEl.className = "message-products";

    products.forEach((product) => {
      productsEl.appendChild(createProductCardElement(product));
    });

    wrapper.appendChild(productsEl);
  }

  const meta = document.createElement("div");
  meta.className = "message-meta";

  if (message.role === "assistant" && message.authoredByHuman) {
    meta.textContent = `Podrška uživo • ${formatTime(message.createdAt)}`;
  } else if (message.role === "assistant") {
    meta.textContent = `Podrška • ${formatTime(message.createdAt)}`;
  } else if (message.role === "system") {
    meta.textContent = formatTime(message.createdAt);
  } else {
    meta.textContent = `Vi • ${formatTime(message.createdAt)}`;
  }

  wrapper.appendChild(meta);
  return wrapper;
}

function createProductCardElement(product) {
  const card = document.createElement("article");
  card.className = "product-card";

  if (product.imageUrl) {
    const image = document.createElement("img");
    image.className = "product-card__image";
    image.src = product.imageUrl;
    image.alt = product.title || "Proizvod";
    image.loading = "lazy";
    image.addEventListener("error", () => {
      image.remove();
      card.classList.add("product-card--no-image");
    }, { once: true });
    card.appendChild(image);
  } else {
    card.classList.add("product-card--no-image");
  }

  const body = document.createElement("div");
  body.className = "product-card__body";

  const title = document.createElement("h3");
  title.className = "product-card__title";
  title.textContent = product.title || "Pronađeni proizvod";
  body.appendChild(title);

  if (product.metaLine) {
    const meta = document.createElement("p");
    meta.className = "product-card__meta";
    meta.textContent = product.metaLine;
    body.appendChild(meta);
  }

  if (product.priceLabel) {
    const price = document.createElement("p");
    price.className = "product-card__price";
    price.textContent = product.priceLabel;
    body.appendChild(price);
  }

  const actions = document.createElement("div");
  actions.className = "product-card__actions";

  if (product.buyLink) {
    actions.appendChild(createProductActionElement(product.buyLink, "Kupi", true));
  }

  if (product.sellLink) {
    actions.appendChild(createProductActionElement(product.sellLink, "Otkup", false));
  }

  if (actions.children.length > 0) {
    body.appendChild(actions);
  }

  card.appendChild(body);
  return card;
}

function createProductActionElement(url, label, primary) {
  const link = document.createElement("a");
  link.className = `product-card__action ${primary ? "is-primary" : "is-secondary"}`;
  link.href = url;
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  link.textContent = label;
  return link;
}

function applyConversationState(session) {
  const state = session?.conversationState;

  if (!state) {
    return;
  }

  currentConversationTone = state.tone || "ai-active";

  if (chatStatusText) {
    chatStatusText.textContent = state.badge || "Aktivan";
  }

  if (welcomeTitle) {
    welcomeTitle.textContent =
      state.tone === "resolved"
        ? "Prethodni razgovor je završen"
        : "Pitajte za knjige, otkup ili narudžbu";
  }

  if (welcomeSubtitle) {
    welcomeSubtitle.textContent =
      state.subtitle || "Odgovor stiže odmah - agent se može uključiti u razgovor.";
  }

  const statusEl = document.querySelector(".chat-widget__status");
  if (statusEl) {
    statusEl.dataset.tone = state.tone || "ai-active";
  }
}

function createTypingIndicatorElement() {
  const wrapper = document.createElement("article");
  wrapper.className = "message assistant typing-host";
  wrapper.dataset.messageId = "typing-indicator";

  const indicator = document.createElement("div");
  indicator.className = "typing-indicator";
  indicator.innerHTML = "<span></span><span></span><span></span>";
  wrapper.appendChild(indicator);

  return wrapper;
}

function showTypingIndicator() {
  if (typingIndicatorEl) {
    return;
  }

  typingIndicatorEl = createTypingIndicatorElement();
  messagesEl.appendChild(typingIndicatorEl);
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function hideTypingIndicator() {
  if (!typingIndicatorEl) {
    return;
  }

  typingIndicatorEl.remove();
  typingIndicatorEl = null;
}

function updateMessages(messages) {
  const nextSignature = getMessagesSignature(messages);

  if (nextSignature === lastRenderedSignature) {
    return;
  }

  const isNearBottom =
    messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < 80;

  if (!lastRenderedSignature || messagesEl.children.length === 0) {
    hideTypingIndicator();
    renderMessages(messages);
    lastRenderedSignature = nextSignature;
    return;
  }

  const currentIds = Array.from(messagesEl.children).map((node) => node.dataset.messageId);
  const nextIds = messages.map((message) => String(message.id));
  const canAppendOnly =
    optimisticMessages.length === 0 &&
    nextIds.length > currentIds.length &&
    currentIds.every((id, index) => id === nextIds[index]);

  if (!canAppendOnly) {
    hideTypingIndicator();
    renderMessages(messages);
    lastRenderedSignature = nextSignature;
    return;
  }

  const newMessages = messages.slice(currentIds.length);

  if (newMessages.length > 0 && widget.classList.contains("hidden")) {
    const incomingAssistantMessages = newMessages.filter((message) => message.role === "assistant");
    if (incomingAssistantMessages.length > 0) {
      setUnreadCount(unreadCount + incomingAssistantMessages.length);
    }
  }

  hideTypingIndicator();

  for (const message of newMessages) {
    messagesEl.appendChild(createMessageElement(message));
  }

  if (isNearBottom) {
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  lastRenderedSignature = nextSignature;
}

function startPolling() {
  if (pollTimer || !localStorage.getItem(storageKey)) {
    return;
  }

  pollTimer = window.setInterval(async () => {
    const sessionId = localStorage.getItem(storageKey);

    if (!sessionId) {
      stopPolling();
      return;
    }

    try {
      const response = await fetch(`/api/chat/session/${sessionId}`);
      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || "Osvježavanje razgovora nije uspjelo.");
      }

      onboarding.stage = "connected";
      hideClosedConversationPanel();
      setComposerEnabled(true);
      applyConversationState(data.session);
      setResolutionPrompt(data.session?.resolutionPrompt || null);
      applySessionMessages(data.session.messages);

      if (data.session?.conversationState?.tone === "resolved") {
        handleResolvedSession(data.session, data.session.messages);
      }
    } catch (error) {
      showError(error.message);
    }
  }, 4000);
}

function startStream(sessionId) {
  if (!sessionId || streamSource) {
    return;
  }

  try {
    streamSource = new EventSource(`/api/chat/stream/${sessionId}`);
  } catch (error) {
    startPolling();
    return;
  }

  streamSource.addEventListener("session_update", (event) => {
    try {
      const data = JSON.parse(event.data);
      onboarding.stage = "connected";
      hideClosedConversationPanel();
      setComposerEnabled(true);
      applyConversationState(data.session);
      setResolutionPrompt(data.session?.resolutionPrompt || null);
      applySessionMessages(data.session.messages);

      if (data.session?.conversationState?.tone === "resolved") {
        handleResolvedSession(data.session, data.session.messages);
      }
    } catch (error) {
      console.error("Failed to parse SSE update:", error);
    }
  });

  streamSource.onerror = () => {
    closeStream();
    startPolling();
  };
}

function stopPolling() {
  if (!pollTimer) {
    return;
  }

  window.clearInterval(pollTimer);
  pollTimer = null;
}

function setMessages(messages) {
  onboarding.messages = messages;
  updateMessages(messages);
  saveOnboardingState();
}

function pushMessage(role, content, attachments = []) {
  const message = createMessage(role, content);
  message.attachments = attachments;
  onboarding.messages.push(message);
  updateMessages(onboarding.messages);
  saveOnboardingState();
}

function pushOptimisticMessage(role, content, attachments = []) {
  const message = createMessage(role, content);
  message.attachments = attachments;
  optimisticMessages.push(message);
  updateMessages([...canonicalMessages, ...optimisticMessages]);
}

async function submitInitialUserMessage(message, attachments = []) {
  if (!message) {
    return;
  }

  pushMessage("user", message, attachments);
  await handleOnboardingMessage(message);
}

function seedWelcomeState() {
  if (onboarding.messages.length > 0) {
    return;
  }

  setMessages([
    createMessage(
      "assistant",
      "Pozdrav! Kako vam mogu pomoći?"
    )
  ]);
}

function isValidEmail(value) {
  return /\S+@\S+\.\S+/.test(value);
}

async function startZendeskChat() {
  const isForm = pendingFiles.length > 0;
  let body;
  let headers = {};
  const trackedEntryFlow = {
    selectedEntryIntent: onboarding.entryFlow.selectedEntryIntent || null,
    entryFlowSkipped: onboarding.entryFlow.entryFlowSkipped,
    stage: onboarding.entryFlow.stage,
    entryPromptAnswer: onboarding.entryFlow.entryPromptAnswer || ""
  };
  const entryPayload = {
    entryFlowVersion: ENTRY_FLOW_VERSION,
    ...(onboarding.entryFlow.selectedEntryIntent
      ? { entryIntent: onboarding.entryFlow.selectedEntryIntent }
      : {}),
    ...(onboarding.entryFlow.entryPromptAnswer
      ? { entryPromptAnswer: onboarding.entryFlow.entryPromptAnswer.trim() }
      : {})
  };

  if (isForm) {
    body = new FormData();
    body.append("name", onboarding.draft.name);
    body.append("email", onboarding.draft.email);
    body.append("message", onboarding.draft.firstMessage);
    body.append("entryFlowVersion", entryPayload.entryFlowVersion);
    if (entryPayload.entryIntent) {
      body.append("entryIntent", entryPayload.entryIntent);
    }
    if (entryPayload.entryPromptAnswer) {
      body.append("entryPromptAnswer", entryPayload.entryPromptAnswer);
    }
    for (const file of pendingFiles) {
      body.append("attachments", file);
    }
  } else {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify({
      name: onboarding.draft.name,
      email: onboarding.draft.email,
      message: onboarding.draft.firstMessage,
      ...entryPayload
    });
  }

  const response = await fetch("/api/chat/start", {
    method: "POST",
    headers,
    body
  });

  const data = await response.json();

  if (!response.ok) {
    throw new Error(data.error || "Pokretanje chata nije uspjelo.");
  }

  pendingFiles = [];
  renderPendingFiles();
  localStorage.setItem(storageKey, data.sessionId);
  saveSessionSnapshot(data.session);
  clearOnboardingState();
  onboarding.stage = "connected";
  trackEntryFlowEvent("chat_started", {
    selectedEntryIntent: trackedEntryFlow.selectedEntryIntent,
    entryFlowSkipped: trackedEntryFlow.entryFlowSkipped,
    stage: trackedEntryFlow.stage,
    hasPromptAnswer: Boolean(trackedEntryFlow.entryPromptAnswer)
  });
  if (data.session) {
    applyConversationState(data.session);
  }
  setResolutionPrompt(data.resolutionPrompt || data.session?.resolutionPrompt || null);
  applySessionMessages(data.messages);
  renderEntryFlow();
  closeStream();
  stopPolling();
  startStream(data.sessionId);
  startPolling();
}

async function handleOnboardingMessage(message) {
  if (onboarding.stage === "initial") {
    onboarding.draft.firstMessage = message;
    onboarding.stage = "awaiting_name";
    renderEntryFlow();
    syncComposerVisibility();
    pushMessage("assistant", "Hvala. Kako se zovete?");
    return;
  }

  if (onboarding.stage === "awaiting_name") {
    onboarding.draft.name = message;
    onboarding.stage = "awaiting_email";
    pushMessage("assistant", "Na koji vas email možemo kontaktirati ako zatreba nastavak razgovora?");
    return;
  }

  if (onboarding.stage === "awaiting_email") {
    if (!isValidEmail(message)) {
      pushMessage("assistant", "Molim upišite ispravnu email adresu, npr. ime@domena.com.");
      return;
    }

    onboarding.draft.email = message;
    onboarding.stage = "starting";
    pushMessage("assistant", "Hvala. Upit je zaprimljen i odgovor stiže ovdje u istom razgovoru.");

    try {
      await startZendeskChat();
    } catch (error) {
      onboarding.stage = "awaiting_email";
      showError(error.message);
    }
  }
}

async function loadExistingSession() {
  const sessionSnapshot = getSessionSnapshot();

  async function restoreFromSnapshot() {
    if (!sessionSnapshot) {
      return false;
    }

    const restoreResponse = await fetch("/api/chat/restore", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(sessionSnapshot)
    });
    const restoreData = await restoreResponse.json();

    if (!restoreResponse.ok) {
      return false;
    }

    if (restoreData.mode === "closed_session") {
      localStorage.removeItem(storageKey);
      clearOnboardingState();
      saveSessionSnapshot({
        ticketId: restoreData.ticket?.id,
        requesterId: restoreData.requester?.requesterId,
        requesterName: restoreData.requester?.name,
        requesterEmail: restoreData.requester?.email
      });
      resetOnboardingState();
      onboarding.stage = "closed";
      closeStream();
      stopPolling();
      clearResolutionPrompt();
      applyConversationState({ conversationState: restoreData.conversationState });
      applySessionMessages(restoreData.messages || []);
      renderEntryFlow();
      showClosedConversationPanel(restoreData);
      return true;
    }

    if (restoreData.mode === "active_session" && restoreData.session) {
      localStorage.setItem(storageKey, restoreData.session.sessionId);
      saveSessionSnapshot({
        sessionId: restoreData.session.sessionId,
        ticketId: restoreData.session.ticketId,
        requesterId: restoreData.session.requesterId,
        requesterName: restoreData.session.requesterName,
        requesterEmail: restoreData.session.requesterEmail
      });
      onboarding.stage = "connected";
      hideClosedConversationPanel();
      setComposerEnabled(true);
      applyConversationState(restoreData.session);
      setResolutionPrompt(restoreData.session?.resolutionPrompt || null);
      applySessionMessages(restoreData.session.messages);
      renderEntryFlow();
      closeStream();
      stopPolling();
      startStream(restoreData.session.sessionId);
      startPolling();
      return true;
    }

    return false;
  }

  if (await restoreFromSnapshot()) {
    return;
  }

  const sessionId = localStorage.getItem(storageKey);

  if (sessionId) {
    try {
      const response = await fetch(`/api/chat/session/${sessionId}`);
      const data = await response.json();

      if (response.ok) {
        onboarding.stage = "connected";
        hideClosedConversationPanel();
        setComposerEnabled(true);
        applyConversationState(data.session);
        setResolutionPrompt(data.session?.resolutionPrompt || null);
        applySessionMessages(data.session.messages);
        renderEntryFlow();

        if (data.session?.conversationState?.tone === "resolved") {
          localStorage.removeItem(storageKey);
          saveSessionSnapshot({
            ticketId: data.session.ticketId,
            requesterId: data.session.requesterId,
            requesterName: data.session.requesterName,
            requesterEmail: data.session.requesterEmail
          });
          showClosedConversationPanel({
            panelTitle: "Što želite dalje?",
            panelText: "Možete pregledati završeni razgovor ili odmah otvoriti novi upit.",
            conversationState: {
              tone: "resolved",
              badge: "Prethodni razgovor je završen",
              subtitle: "Ako imate novo pitanje, ovdje možete otvoriti novi razgovor."
            }
          });
          return;
        }

        closeStream();
        stopPolling();
        startStream(sessionId);
        startPolling();
        return;
      }

      localStorage.removeItem(storageKey);
      if (await restoreFromSnapshot()) {
        return;
      }
    } catch (error) {
      if (await restoreFromSnapshot()) {
        return;
      }

      showError("Ne mogu učitati prethodni razgovor.");
    }
  }

  const savedOnboarding = localStorage.getItem(onboardingKey);

  if (savedOnboarding) {
    try {
      const parsed = JSON.parse(savedOnboarding);
      onboarding.stage = parsed.stage || "initial";
      onboarding.draft = parsed.draft || onboarding.draft;
      onboarding.messages = parsed.messages || [];
      onboarding.entryFlow = normalizeEntryFlow(parsed.entryFlow || onboarding.entryFlow);
      canonicalMessages = [];
      optimisticMessages = [];
    } catch (error) {
      clearOnboardingState();
    }
  }

  seedWelcomeState();
  hideClosedConversationPanel();
  clearResolutionPrompt();
  renderEntryFlow();
  setComposerEnabled(true);
  canonicalMessages = [];
  optimisticMessages = [];
  updateMessages(onboarding.messages);
}

function initializeEmbedMode() {
  if (!isEmbedMode) {
    return;
  }

  document.body.classList.add("embed-mode");
  showWidget();
  if (!localStorage.getItem(storageKey) && onboarding.stage === "initial") {
    trackEntryFlowEvent("widget_opened", { mode: "embed" });
  }
  postEmbedMessage({ action: "ready" });
}

function handleEmbedMessage(event) {
  const data = event?.data;

  if (!data || data.source !== embedMessageType) {
    return;
  }

  if (data.action === "open") {
    showWidget();
  }
}

launcher.addEventListener("click", () => {
  if (widget.classList.contains("hidden")) {
    showWidget();
    if (!localStorage.getItem(storageKey) && onboarding.stage === "initial") {
      trackEntryFlowEvent("widget_opened");
    }
    return;
  }

  hideWidget();
});

closeButton.addEventListener("click", hideWidget);

reviewConversationButton?.addEventListener("click", () => {
  reviewConversationButton.classList.add("is-active");
  messagesEl.scrollTop = 0;
});

newConversationButton?.addEventListener("click", startNewConversationFlow);
entryFlowChoices?.addEventListener("click", (event) => {
  const button = event.target.closest("[data-entry-intent]");

  if (!button) {
    return;
  }

  const selectedIntent = getEntryIntentConfig(button.dataset.entryIntent);

  if (!selectedIntent) {
    return;
  }

  trackEntryFlowEvent("intent_selected", {
    intent: selectedIntent.id
  });

  if (!selectedIntent.promptLabel) {
    setEntryFlowState({
      stage: "ready",
      selectedEntryIntent: selectedIntent.id,
      entryPromptAnswer: "",
      entryFlowSkipped: false
    });
    messageInput?.focus();
    return;
  }

  setEntryFlowState({
    stage: "prompt",
    selectedEntryIntent: selectedIntent.id,
    entryPromptAnswer: "",
    entryFlowSkipped: false
  });
  entryPromptInput?.focus();
});

entryFlowSkipButton?.addEventListener("click", () => {
  trackEntryFlowEvent("entry_skipped");
  setEntryFlowState({
    stage: "ready",
    selectedEntryIntent: "",
    entryPromptAnswer: "",
    entryFlowSkipped: true
  });
  messageInput?.focus();
});

entryFlowBackButton?.addEventListener("click", () => {
  resetEntryFlowChoices();
});

entryFlowChangeButton?.addEventListener("click", () => {
  resetEntryFlowChoices();
});

entryFlowPromptForm?.addEventListener("submit", (event) => {
  event.preventDefault();
  const promptValue = entryPromptInput?.value.trim() || "";

  trackEntryFlowEvent("prompt_completed", {
    hasPromptAnswer: Boolean(promptValue)
  });

  setEntryFlowState({
    stage: "ready",
    entryPromptAnswer: promptValue,
    entryFlowSkipped: false
  });

  if (!promptValue) {
    messageInput?.focus();
    return;
  }

  submitInitialUserMessage(promptValue).catch((error) => {
    showError(error.message);
  });
});

messagesEl.addEventListener("click", async (event) => {
  const actionButton = event.target.closest("[data-resolve-action]");

  if (!actionButton) {
    return;
  }

  const sessionId = localStorage.getItem(storageKey);

  if (!sessionId) {
    return;
  }

  const confirmed = actionButton.dataset.resolveAction === "confirm";

  try {
    clearError();
    const response = await fetch("/api/chat/resolve", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        sessionId,
        confirmed
      })
    });
    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || "Ažuriranje razgovora nije uspjelo.");
    }

    if (!confirmed) {
      clearResolutionPrompt();
      if (data.session?.conversationState) {
        applyConversationState(data.session);
      }
      applySessionMessages(data.session?.messages || onboarding.messages);
      return;
    }

    clearResolutionPrompt();
    if (data.session?.conversationState) {
      applyConversationState(data.session);
    }
    if (data.session?.messages) {
      applySessionMessages(data.session.messages);
    }

    if (data.session?.conversationState?.tone === "resolved") {
      handleResolvedSession(data.session, data.session.messages);
    }
  } catch (error) {
    showError(error.message);
  }
});

function collectPendingFiles(inputEl) {
  if (!inputEl || !inputEl.files) {
    return;
  }

  for (const file of inputEl.files) {
    const duplicate = pendingFiles.some(
      (pendingFile) =>
        pendingFile.name === file.name &&
        pendingFile.size === file.size &&
        pendingFile.lastModified === file.lastModified
    );

    if (!duplicate) {
      pendingFiles.push(file);
    }
  }

  inputEl.value = "";
  renderPendingFiles();
}

function renderPendingFiles() {
  if (!filesIndicator || !pendingFilesList) return;

  if (pendingFiles.length === 0) {
    filesIndicator.classList.add("hidden");
    filesIndicator.textContent = "";
    pendingFilesList.classList.add("hidden");
    pendingFilesList.innerHTML = "";
    return;
  }

  filesIndicator.classList.remove("hidden");
  if (pendingFiles.length === 1) {
    filesIndicator.textContent = "1 datoteka";
  } else if (pendingFiles.length < 5) {
    filesIndicator.textContent = `${pendingFiles.length} datoteke`;
  } else {
    filesIndicator.textContent = `${pendingFiles.length} datoteka`;
  }

  pendingFilesList.classList.remove("hidden");
  pendingFilesList.innerHTML = "";

  pendingFiles.forEach((file, index) => {
    const item = document.createElement("div");
    item.className = "pending-file";

    const meta = document.createElement("div");
    meta.className = "pending-file__meta";

    const name = document.createElement("span");
    name.className = "pending-file__name";
    name.textContent = file.name;
    name.title = file.name;

    const size = document.createElement("span");
    size.className = "pending-file__size";
    size.textContent = formatFileSize(file.size);

    meta.appendChild(name);
    meta.appendChild(size);

    if (file.type && file.type.startsWith("image/")) {
      const preview = document.createElement("img");
      preview.className = "pending-file__thumb";
      preview.src = URL.createObjectURL(file);
      preview.alt = file.name;
      preview.loading = "lazy";
      item.appendChild(preview);
    }

    const removeButton = document.createElement("button");
    removeButton.type = "button";
    removeButton.className = "pending-file__remove";
    removeButton.setAttribute("aria-label", `Ukloni ${file.name}`);
    removeButton.dataset.fileIndex = String(index);
    removeButton.innerHTML = "&times;";

    item.appendChild(meta);
    item.appendChild(removeButton);

    pendingFilesList.appendChild(item);
  });
}

function removePendingFile(index) {
  pendingFiles = pendingFiles.filter((_, fileIndex) => fileIndex !== index);
  renderPendingFiles();
}

if (fileInput) {
  fileInput.addEventListener("change", () => {
    collectPendingFiles(fileInput);
  });
}

if (imageInput) {
  imageInput.addEventListener("change", () => {
    collectPendingFiles(imageInput);
  });
}

if (pendingFilesList) {
  pendingFilesList.addEventListener("click", (event) => {
    const target = event.target.closest(".pending-file__remove");

    if (!target) {
      return;
    }

    const index = Number(target.dataset.fileIndex);

    if (Number.isNaN(index)) {
      return;
    }

    removePendingFile(index);
  });
}

messageInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    messageForm.requestSubmit();
  }
});

messageForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  clearError();

  const sessionId = localStorage.getItem(storageKey);
  const message = messageInput.value.trim();

  if (closedConversationState) {
    return;
  }

  clearResolutionPrompt();

  if (!message && pendingFiles.length === 0) {
    return;
  }

  const pendingAttachmentPayload = pendingFiles.map((file) => ({
    id: `${file.name}-${file.size}-${file.lastModified}`,
    name: file.name,
    size: file.size,
    contentType: file.type || "application/octet-stream",
    url: null
  }));

  if (message) {
    if (sessionId) {
      pushOptimisticMessage("user", message, pendingAttachmentPayload);
    }
  } else if (pendingAttachmentPayload.length > 0) {
    if (sessionId) {
      pushOptimisticMessage("user", "Šaljem privitak.", pendingAttachmentPayload);
    } else {
      pushMessage("user", "Šaljem privitak.", pendingAttachmentPayload);
    }
  }

  messageInput.value = "";
  messageInput.style.height = "auto";

  if (!sessionId) {
    if (message) {
      await submitInitialUserMessage(message, pendingAttachmentPayload);
    }
    // Do NOT clear pendingFiles here anymore! They need to persist until startZendeskChat
    return;
  }

  try {
    const shouldShowTypingIndicator =
      currentConversationTone !== "human-active" &&
      currentConversationTone !== "awaiting-human";

    if (shouldShowTypingIndicator) {
      showTypingIndicator();
    }
    const formData = new FormData();
    formData.append("sessionId", sessionId);
    formData.append("message", message);

    for (const file of pendingFiles) {
      formData.append("attachments", file);
    }

    pendingFiles = [];
    renderPendingFiles();

    const response = await fetch("/api/chat/message", {
      method: "POST",
      body: formData
    });

    const data = await response.json();

    if (!response.ok) {
      if (response.status === 409 && data.conversationState?.tone === "resolved") {
        handleResolvedSession(data, canonicalMessages);
      }
      throw new Error(data.error || "Slanje poruke nije uspjelo.");
    }

    if (data.conversationState) {
      applyConversationState({ conversationState: data.conversationState });
    }

    setResolutionPrompt(data.resolutionPrompt || null);
    applySessionMessages(data.messages);
    startPolling();
  } catch (error) {
    optimisticMessages = [];
    if (sessionId) {
      updateMessages(canonicalMessages);
    }
    hideTypingIndicator();
    showError(error.message);
  }
});

messageInput.addEventListener("input", () => {
  messageInput.style.height = "auto";
  messageInput.style.height = `${Math.min(messageInput.scrollHeight, 132)}px`;
});

window.addEventListener("message", handleEmbedMessage);
renderEntryFlowChoices();
initializeEmbedMode();
loadExistingSession();

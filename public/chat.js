const storageKey = "libar-chat-session-id";
const sessionSnapshotKey = "libar-chat-session-snapshot";
const onboardingKey = "libar-chat-onboarding";

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
const messageForm = document.getElementById("message-form");
const messagesEl = document.getElementById("messages");
const errorBox = document.getElementById("error-box");
const messageInput = document.getElementById("message-input");
const fileInput = document.getElementById("file-input");
const imageInput = document.getElementById("image-input");
const filesIndicator = document.getElementById("pending-files-indicator");
const pendingFilesList = document.getElementById("pending-files-list");
const chatInputArea = document.querySelector(".chat-input-area");
let pollTimer = null;
let streamSource = null;
let lastRenderedSignature = "";
let pendingFiles = [];
let unreadCount = 0;
let typingIndicatorEl = null;
let closedConversationState = null;

const onboarding = {
  stage: "initial",
  draft: {
    firstMessage: "",
    name: "",
    email: ""
  },
  messages: [],
  preludeMessages: []
};

function showWidget() {
  widget.classList.remove("hidden");
  widget.setAttribute("aria-hidden", "false");
  launcher.setAttribute("aria-expanded", "true");
  setUnreadCount(0);

  if (!messageInput.disabled && !chatInputArea?.classList.contains("hidden")) {
    messageInput.focus();
  }
}

function hideWidget() {
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

function createMessage(role, content, createdAt = new Date().toISOString()) {
  return {
    id: crypto.randomUUID(),
    role,
    content,
    createdAt,
    attachments: []
  };
}

function normalizeMessageContent(content) {
  return String(content || "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function getMessageMatchKey(message) {
  const attachments = Array.isArray(message?.attachments) ? message.attachments : [];

  return [
    message?.role || "",
    normalizeMessageContent(message?.content),
    attachments
      .map((attachment) => `${attachment.name || ""}:${attachment.size || ""}`)
      .join(",")
  ].join("|");
}

function mergePreludeWithSessionMessages(preludeMessages, sessionMessages) {
  if (!Array.isArray(preludeMessages) || preludeMessages.length === 0) {
    return Array.isArray(sessionMessages) ? sessionMessages : [];
  }

  const mergedMessages = [...preludeMessages];
  const existingKeys = new Set(
    preludeMessages
      .filter((message) => message.role !== "system")
      .map((message) => getMessageMatchKey(message))
  );

  for (const message of Array.isArray(sessionMessages) ? sessionMessages : []) {
    const matchKey = getMessageMatchKey(message);

    if (message.role !== "system" && existingKeys.has(matchKey)) {
      continue;
    }

    mergedMessages.push(message);

    if (message.role !== "system") {
      existingKeys.add(matchKey);
    }
  }

  return mergedMessages;
}

function applySessionMessages(sessionMessages) {
  const visibleMessages = mergePreludeWithSessionMessages(
    onboarding.preludeMessages,
    sessionMessages
  );

  onboarding.messages = visibleMessages;
  updateMessages(visibleMessages);
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
  onboarding.preludeMessages = [];
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
  if (chatInputArea) {
    chatInputArea.classList.toggle("hidden", !enabled);
  }

  if (messageInput) {
    messageInput.disabled = !enabled;
  }
}

function hideClosedConversationPanel() {
  closedConversationState = null;
  closedConversationPanel?.classList.add("hidden");
  reviewConversationButton?.classList.remove("is-active");
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
  applySessionMessages(messages || []);
  showClosedConversationPanel({
    panelTitle: "Što želite dalje?",
    panelText: "Možete pregledati završeni razgovor ili odmah otvoriti novi upit.",
    conversationState: {
      tone: "resolved",
      badge: "Prethodni razgovor je završen",
      subtitle: "Ako imate novo pitanje, ovdje možete započeti novi razgovor."
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
  pendingFiles = [];
  renderPendingFiles();
  lastRenderedSignature = "";
  seedWelcomeState();
  updateMessages(onboarding.messages);
  applyConversationState({
    conversationState: {
      tone: "ai-active",
      badge: "Aktivan",
      subtitle: "Libar Agent odgovara odmah, a po potrebi se u razgovor uključuje i naš tim."
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

  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function getMessagesSignature(messages) {
  return messages
    .map((message) =>
      `${message.id}:${message.createdAt}:${message.content}:${(message.attachments || [])
        .map((attachment) => `${attachment.id || attachment.name}:${attachment.name}`)
        .join(",")}`
    )
    .join("|");
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

  const meta = document.createElement("div");
  meta.className = "message-meta";

  if (message.role === "assistant" && message.authoredByHuman) {
    meta.textContent = `Agent uživo • ${formatTime(message.createdAt)}`;
  } else if (message.role === "assistant") {
    meta.textContent = `Agent podrške • ${formatTime(message.createdAt)}`;
  } else if (message.role === "system") {
    meta.textContent = formatTime(message.createdAt);
  } else {
    meta.textContent = `Vi • ${formatTime(message.createdAt)}`;
  }

  wrapper.appendChild(meta);
  return wrapper;
}

function applyConversationState(session) {
  const state = session?.conversationState;

  if (!state) {
    return;
  }

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
    currentIds.every((id, index) => id === nextIds[index]) &&
    nextIds.length >= currentIds.length;

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

function seedWelcomeState() {
  if (onboarding.messages.length > 0) {
    return;
  }

  setMessages([
    createMessage(
      "assistant",
      "Pozdrav! Ja sam Libar Agent. Kako vam mogu pomoći danas?"
    )
  ]);
}

function isValidEmail(value) {
  return /\S+@\S+\.\S+/.test(value);
}

async function startZendeskChat() {
  const preludeMessages = onboarding.messages.slice();
  const isForm = pendingFiles.length > 0;
  let body;
  let headers = {};

  if (isForm) {
    body = new FormData();
    body.append("name", onboarding.draft.name);
    body.append("email", onboarding.draft.email);
    body.append("message", onboarding.draft.firstMessage);
    for (const file of pendingFiles) {
      body.append("attachments", file);
    }
  } else {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify({
      name: onboarding.draft.name,
      email: onboarding.draft.email,
      message: onboarding.draft.firstMessage
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
  onboarding.preludeMessages = preludeMessages;
  clearOnboardingState();
  onboarding.stage = "connected";
  if (data.session) {
    applyConversationState(data.session);
  }
  applySessionMessages(data.messages);
  closeStream();
  stopPolling();
  startStream(data.sessionId);
  startPolling();
}

async function handleOnboardingMessage(message) {
  if (onboarding.stage === "initial") {
    onboarding.draft.firstMessage = message;
    onboarding.stage = "awaiting_name";
    pushMessage("system", "Za početak, recite mi svoje ime i prezime.");
    return;
  }

  if (onboarding.stage === "awaiting_name") {
    onboarding.draft.name = message;
    onboarding.stage = "awaiting_email";
    pushMessage("system", "Hvala. Na koji email vas možemo kontaktirati ako zatreba nastavak razgovora?");
    return;
  }

  if (onboarding.stage === "awaiting_email") {
    if (!isValidEmail(message)) {
      pushMessage("system", "Molim unesite ispravnu email adresu, npr. ime@domena.com.");
      return;
    }

    onboarding.draft.email = message;
    onboarding.stage = "starting";
    pushMessage("system", "Odlično, povezujem razgovor s podrškom...");

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
      applyConversationState({ conversationState: restoreData.conversationState });
      applySessionMessages(restoreData.messages || []);
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
      applySessionMessages(restoreData.session.messages);
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
        applySessionMessages(data.session.messages);

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
              subtitle: "Ako imate novo pitanje, ovdje možete započeti novi razgovor."
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
    } catch (error) {
      clearOnboardingState();
    }
  }

  seedWelcomeState();
  hideClosedConversationPanel();
  setComposerEnabled(true);
  updateMessages(onboarding.messages);
}

launcher.addEventListener("click", () => {
  if (widget.classList.contains("hidden")) {
    showWidget();
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
    pushMessage("user", message, pendingAttachmentPayload);
  } else if (pendingAttachmentPayload.length > 0) {
    pushMessage("user", "Poslan je privitak.", pendingAttachmentPayload);
  }

  messageInput.value = "";
  messageInput.style.height = "auto";

  if (!sessionId) {
    if (message) {
      await handleOnboardingMessage(message);
    }
    // Do NOT clear pendingFiles here anymore! They need to persist until startZendeskChat
    return;
  }

  try {
    showTypingIndicator();
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
        handleResolvedSession(data, onboarding.messages);
      }
      throw new Error(data.error || "Slanje poruke nije uspjelo.");
    }

    if (data.conversationState) {
      applyConversationState({ conversationState: data.conversationState });
    }

    applySessionMessages(data.messages);
    startPolling();
  } catch (error) {
    hideTypingIndicator();
    showError(error.message);
  }
});

messageInput.addEventListener("input", () => {
  messageInput.style.height = "auto";
  messageInput.style.height = `${Math.min(messageInput.scrollHeight, 132)}px`;
});

loadExistingSession();
